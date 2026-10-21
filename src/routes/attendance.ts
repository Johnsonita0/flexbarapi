import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { AdminActivityWriteError, recordAdminActivity } from "../services/adminActivity.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";
import { notifyAdminsOfSystemError } from "../services/systemNotifications.js";

const router = Router();
const adminRoles = new Set(["super_admin", "management_admin"]);

interface Coordinates {
  latitude: number;
  longitude: number;
}

interface AttendanceLocation extends Coordinates {
  accuracyMeters: number;
}

const attendanceQrPeriodSeconds = 30;
const attendanceRadiusMeters = 25;

async function sendAttendanceError(response: Response, error: unknown, context: string) {
  console.error(context, error);
  await notifyAdminsOfSystemError(response, error, context);
  if (error instanceof AdminActivityWriteError) {
    response.status(502).json({ error: "The location was saved, but its administrator activity entry could not be saved. Do not repeat the change; contact support." });
    return;
  }
  if (error instanceof Error && error.message.includes("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY")) {
    response.status(503).json({ error: "Attendance services are not configured yet. Please contact the system administrator." });
    return;
  }
  response.status(500).json({ error: "We couldn't complete that attendance request. Please try again." });
}

function parseCoordinates(body: unknown): Coordinates | null {
  if (typeof body !== "object" || body === null || !("latitude" in body) || !("longitude" in body)) return null;
  const { latitude, longitude } = body;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) return null;
  return { latitude, longitude };
}

function parseAttendanceLocation(body: unknown): AttendanceLocation | null {
  if (typeof body !== "object" || body === null || !("accuracyMeters" in body)) return null;
  const coordinates = parseCoordinates(body);
  const accuracyMeters = body.accuracyMeters;
  if (
    !coordinates ||
    typeof accuracyMeters !== "number" ||
    !Number.isFinite(accuracyMeters) ||
    accuracyMeters < 0 ||
    accuracyMeters > 1000
  ) return null;
  return { ...coordinates, accuracyMeters };
}

function attendanceQrSigningKey() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
  return createHmac("sha256", serviceRoleKey).update("flexbar-attendance-qr-signing-key-v1").digest();
}

function createAttendanceQrToken(companyId: string, period: number) {
  const signature = createHmac("sha256", attendanceQrSigningKey())
    .update(`${companyId}:${period}`)
    .digest("base64url");
  return `flexbar-attendance:${companyId}:${period}:${signature}`;
}

function isValidAttendanceQrToken(token: unknown, companyId: string) {
  if (typeof token !== "string") return false;
  const match = /^flexbar-attendance:([0-9a-f-]{36}):(\d+):([A-Za-z0-9_-]{43})$/i.exec(token);
  if (!match || match[1] !== companyId) return false;
  const tokenCompanyId = match[1];
  const period = Number(match[2]);
  const signature = match[3];
  const currentPeriod = Math.floor(Date.now() / (attendanceQrPeriodSeconds * 1000));
  if (!Number.isSafeInteger(period) || (period !== currentPeriod && period !== currentPeriod - 1)) return false;
  const expected = Buffer.from(createAttendanceQrToken(tokenCompanyId!, period).split(":").at(-1)!);
  const provided = Buffer.from(signature!);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function distanceInMeters(from: Coordinates, to: Coordinates) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6_371_000;
  const latitudeDifference = radians(to.latitude - from.latitude);
  const longitudeDifference = radians(to.longitude - from.longitude);
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitudeDifference / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

function localWorkDate(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

async function loadBusinessSettings(companyId: string) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("business_settings")
    .select("latitude, longitude, geofence_radius_m, timezone")
    .eq("company_id", companyId)
    .single();
  if (error) throw error;
  return data;
}

async function alertGeofenceViolation(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  user: NonNullable<Request["flexbarUser"]>,
  location: AttendanceLocation,
  distanceMeters: number,
) {
  const recentCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: recentAttempt, error: recentAttemptError } = await admin.from("attendance_geofence_violations")
    .select("id")
    .eq("company_id", user.companyId)
    .eq("user_id", user.id)
    .gte("created_at", recentCutoff)
    .limit(1)
    .maybeSingle();
  if (recentAttemptError) throw recentAttemptError;

  const [{ data: departments, error: departmentsError }, { data: administrators, error: administratorsError }] =
    await Promise.all([
      user.departmentId
        ? admin.from("departments")
          .select("id, name, head_user_id")
          .eq("id", user.departmentId)
          .eq("company_id", user.companyId)
          .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      admin.from("profiles")
        .select("id")
        .eq("company_id", user.companyId)
        .eq("is_active", true)
        .eq("is_archived", false)
        .in("role", ["super_admin", "management_admin"]),
    ]);
  if (departmentsError || administratorsError) {
    throw departmentsError ?? administratorsError;
  }

  const department = departments;
  let headId: string | null = null;
  if (department?.head_user_id) {
    const { data: head, error: headError } = await admin.from("profiles")
      .select("id")
      .eq("id", department.head_user_id)
      .eq("company_id", user.companyId)
      .eq("is_active", true)
      .eq("is_archived", false)
      .maybeSingle();
    if (headError) throw headError;
    headId = head?.id ?? null;
  }

  const recipientIds = [...new Set([
    ...(administrators ?? []).map((profile) => profile.id),
    ...(headId ? [headId] : []),
  ])].filter((recipientId) => recipientId !== user.id);
  const { error: auditError } = await admin.from("attendance_geofence_violations").insert({
    company_id: user.companyId,
    user_id: user.id,
    department_id: department?.id ?? user.departmentId,
    distance_meters: Math.round(distanceMeters * 10) / 10,
    accuracy_meters: Math.round(location.accuracyMeters * 10) / 10,
  });
  if (auditError) throw auditError;
  if (!recipientIds.length || recentAttempt) return;

  const staffName = user.displayName?.trim() || user.email || "A staff member";
  const departmentName = department?.name ?? "their assigned department";
  const roundedDistance = Math.round(distanceMeters);
  const detail = `${staffName} was blocked from checking in because the reported location could not be confirmed inside the 10 m attendance area. The reported position was approximately ${roundedDistance} m from the registered point (GPS accuracy ±${Math.ceil(location.accuracyMeters)} m). Department: ${departmentName}.`;
  const { error: notificationError } = await admin.from("notifications").insert(
    recipientIds.map((userId) => ({
      user_id: userId,
      company_id: user.companyId,
      type: "attendance_geofence_violation",
      title: "Blocked attendance check-in could not be verified",
      detail,
      sale_id: null,
    })),
  );
  if (notificationError) throw notificationError;
}

router.use(requireUser);

router.get("/config", async (request, response) => {
  try {
    const user = request.flexbarUser;
    if (!user) {
      response.status(401).json({ error: "Please sign in to view attendance settings." });
      return;
    }
    const settings = await loadBusinessSettings(user.companyId);
    const canViewCoordinates = adminRoles.has(user.role);
    response.set("Cache-Control", "no-store");
    response.status(200).json({
      latitude: canViewCoordinates ? settings.latitude : null,
      longitude: canViewCoordinates ? settings.longitude : null,
      radiusMeters: settings.geofence_radius_m,
      timezone: settings.timezone,
      configured: settings.latitude !== null && settings.longitude !== null,
    });
  } catch (error: unknown) {
    sendAttendanceError(response, error, "Could not load attendance settings.");
  }
});

router.get("/on-site-code", async (request, response) => {
  const user = request.flexbarUser;
  if (!user || !adminRoles.has(user.role)) {
    response.status(403).json({ error: "Only a company administrator can display the on-site attendance QR code." });
    return;
  }
  try {
    const settings = await loadBusinessSettings(user.companyId);
    if (settings.latitude === null || settings.longitude === null) {
      response.status(409).json({ error: "Set and save the business location before displaying the check-in QR code." });
      return;
    }
    const period = Math.floor(Date.now() / (attendanceQrPeriodSeconds * 1000));
    response.set("Cache-Control", "no-store");
    response.status(200).json({
      token: createAttendanceQrToken(user.companyId, period),
      expiresAt: (period + 1) * attendanceQrPeriodSeconds * 1000,
    });
  } catch (error: unknown) {
    sendAttendanceError(response, error, "Could not create the on-site attendance code.");
  }
});

router.put("/config", async (request, response) => {
  if (!request.flexbarUser || !adminRoles.has(request.flexbarUser.role)) {
    response.status(403).json({ error: "Only a company administrator can change the business attendance location." });
    return;
  }
  const coordinates = parseCoordinates(request.body);
  const radiusMeters = typeof request.body?.radiusMeters === "number" ? request.body.radiusMeters : NaN;
  if (!coordinates || radiusMeters !== attendanceRadiusMeters) {
    response.status(400).json({ error: "The attendance geofence is fixed at 25 metres around the approved location." });
    return;
  }
  const timezone = typeof request.body?.timezone === "string" ? request.body.timezone : "Africa/Lagos";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    response.status(400).json({ error: "Choose a valid timezone." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from("business_settings").upsert({
      company_id: request.flexbarUser.companyId,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      geofence_radius_m: radiusMeters,
      timezone,
      updated_at: new Date().toISOString(),
    }, { onConflict: "company_id" });
    if (error) {
      sendAttendanceError(response, error, "Could not save attendance settings.");
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to update the business location." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "attendance.location.updated",
      targetType: "business_settings",
      targetLabel: "Attendance geofence",
      details: {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        radiusMeters,
        timezone,
      },
    });
    response.status(200).json({ message: "Business attendance location saved." });
  } catch (error: unknown) {
    sendAttendanceError(response, error, "Could not initialize attendance settings.");
  }
});

router.get("/records", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to view attendance." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    let recordsQuery = admin
      .from("attendance_records")
      .select("id, user_id, staff_name_snapshot, staff_email_snapshot, work_date, check_in_at, check_out_at")
      .order("work_date", { ascending: false })
      .order("check_in_at", { ascending: false })
      .limit(200);
    if (!adminRoles.has(user.role)) recordsQuery = recordsQuery.eq("user_id", user.id);
    const [{ data: records, error: recordsError }, { data: profiles, error: profilesError }, { data: departments, error: departmentsError }] =
      await Promise.all([
        recordsQuery,
        admin.from("profiles").select("id, display_name, role, department_id"),
        admin.from("departments").select("id, name"),
      ]);
    const failure = recordsError ?? profilesError ?? departmentsError;
    if (failure) {
      sendAttendanceError(response, failure, "Could not load attendance records.");
      return;
    }
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    const departmentById = new Map((departments ?? []).map((department) => [department.id, department.name]));
    response.status(200).json({
      records: (records ?? []).map((record) => {
        const profile = record.user_id ? profileById.get(record.user_id) : undefined;
        return {
          id: record.id,
          userId: record.user_id,
          name: profile?.display_name ?? record.staff_name_snapshot ?? "Former staff member",
          email: record.staff_email_snapshot,
          role: profile?.role ?? "staff",
          department: profile?.department_id ? departmentById.get(profile.department_id) ?? null : null,
          date: record.work_date,
          clockIn: record.check_in_at,
          clockOut: record.check_out_at,
        };
      }),
    });
  } catch (error: unknown) {
    sendAttendanceError(response, error, "Could not initialize attendance history.");
  }
});

async function recordAttendance(
  request: Request,
  response: Response,
  action: "clock-in" | "clock-out",
) {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to record attendance." });
    return;
  }
  if (user.role === "super_admin") {
    response.status(403).json({ error: "Super admins are not included in staff attendance." });
    return;
  }
  const location = parseAttendanceLocation(request.body);
  if (!location) {
    response.status(400).json({ error: "Check your location again and allow precise location access before recording attendance." });
    return;
  }
  try {
    const settings = await loadBusinessSettings(user.companyId);
    if (settings.latitude === null || settings.longitude === null) {
      response.status(409).json({ error: "The business attendance location has not been configured yet." });
      return;
    }
    const admin = createSupabaseAdminClient();
    const distance = distanceInMeters(
      location,
      { latitude: settings.latitude, longitude: settings.longitude },
    );
    if (distance + location.accuracyMeters > attendanceRadiusMeters) {
      if (action === "clock-in") {
        try {
          await alertGeofenceViolation(admin, user, location, distance);
        } catch (alertError: unknown) {
          console.error("Could not record or notify administrators about an outside-area attendance attempt.", alertError);
          await notifyAdminsOfSystemError(response, alertError, "Could not record or notify administrators about an outside-area attendance attempt.");
        }
      }
      response.status(403).json({
        error: "Your location could not be verified at the business. Enable location services and try again while on site.",
      });
      return;
    }
    if (!isValidAttendanceQrToken(request.body?.qrToken, user.companyId)) {
      response.status(403).json({ error: "Scan the current on-site attendance QR code displayed inside the business before recording attendance." });
      return;
    }

    const workDate = localWorkDate(settings.timezone);
    if (action === "clock-in") {
      const { data, error } = await admin
        .from("attendance_records")
        .insert({
          user_id: user.id,
          work_date: workDate,
          check_in_latitude: location.latitude,
          check_in_longitude: location.longitude,
        })
        .select("id, work_date, check_in_at, check_out_at")
        .single();
      if (error?.code === "23505") {
        response.status(409).json({ error: "You’ve already clocked in for today." });
        return;
      }
      if (error) {
        sendAttendanceError(response, error, "Could not record staff clock-in.");
        return;
      }
      response.status(201).json({ record: data, message: "You’re clocked in. Have a great shift!" });
      return;
    }

    const { data: existing, error: lookupError } = await admin
      .from("attendance_records")
      .select("id, check_out_at")
      .eq("user_id", user.id)
      .eq("work_date", workDate)
      .maybeSingle();
    if (lookupError) {
      sendAttendanceError(response, lookupError, "Could not check the current shift.");
      return;
    }
    if (!existing) {
      response.status(409).json({ error: "Clock in before you clock out." });
      return;
    }
    if (existing.check_out_at) {
      response.status(409).json({ error: "You’ve already clocked out for today." });
      return;
    }
    const { data, error } = await admin
      .from("attendance_records")
      .update({
        check_out_at: new Date().toISOString(),
        check_out_latitude: location.latitude,
        check_out_longitude: location.longitude,
      })
      .eq("id", existing.id)
      .is("check_out_at", null)
      .select("id, work_date, check_in_at, check_out_at")
      .single();
    if (error) {
      sendAttendanceError(response, error, "Could not record staff clock-out.");
      return;
    }
    response.status(200).json({ record: data, message: "You’re clocked out. Thank you for your shift!" });
  } catch (error: unknown) {
    sendAttendanceError(response, error, "Could not initialize attendance recording.");
  }
}

router.post("/clock-in", (request, response) => {
  void recordAttendance(request, response, "clock-in");
});

router.post("/clock-out", (request, response) => {
  void recordAttendance(request, response, "clock-out");
});

export { router as attendanceRouter };
