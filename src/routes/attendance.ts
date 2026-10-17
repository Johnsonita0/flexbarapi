import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { AdminActivityWriteError, recordAdminActivity } from "../services/adminActivity.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();

interface Coordinates {
  latitude: number;
  longitude: number;
}

function sendAttendanceError(response: Response, error: unknown, context: string) {
  console.error(context, error);
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

async function loadBusinessSettings() {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("business_settings")
    .select("latitude, longitude, geofence_radius_m, timezone")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return data;
}

router.use(requireUser);

router.get("/config", async (request, response) => {
  try {
    const settings = await loadBusinessSettings();
    const canViewCoordinates = request.flexbarUser?.role === "super_admin";
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

router.put("/config", async (request, response) => {
  if (request.flexbarUser?.role !== "super_admin") {
    response.status(403).json({ error: "Only the super admin can change the business attendance location." });
    return;
  }
  const coordinates = parseCoordinates(request.body);
  const radiusMeters = typeof request.body?.radiusMeters === "number" ? request.body.radiusMeters : NaN;
  if (!coordinates || !Number.isInteger(radiusMeters) || radiusMeters < 25 || radiusMeters > 2000) {
    response.status(400).json({ error: "Enter valid coordinates and a radius between 25 and 2,000 metres." });
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
      id: 1,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      geofence_radius_m: radiusMeters,
      timezone,
      updated_at: new Date().toISOString(),
    });
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
    if (user.role !== "super_admin") recordsQuery = recordsQuery.eq("user_id", user.id);
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
  const coordinates = parseCoordinates(request.body);
  if (!coordinates) {
    response.status(400).json({ error: "Allow location access and try again from your device." });
    return;
  }

  try {
    const settings = await loadBusinessSettings();
    if (settings.latitude === null || settings.longitude === null) {
      response.status(409).json({ error: "The business attendance location has not been configured yet." });
      return;
    }
    const distance = distanceInMeters(
      coordinates,
      { latitude: settings.latitude, longitude: settings.longitude },
    );
    if (distance > settings.geofence_radius_m) {
      response.status(403).json({ error: "You’re outside the approved attendance area." });
      return;
    }

    const admin = createSupabaseAdminClient();
    const workDate = localWorkDate(settings.timezone);
    if (action === "clock-in") {
      const { data, error } = await admin
        .from("attendance_records")
        .insert({
          user_id: user.id,
          work_date: workDate,
          check_in_latitude: coordinates.latitude,
          check_in_longitude: coordinates.longitude,
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
        check_out_latitude: coordinates.latitude,
        check_out_longitude: coordinates.longitude,
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
