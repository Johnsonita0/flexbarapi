import { Router } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();
const adminRoles = new Set(["super_admin", "management_admin"]);

function sendDepartmentError(response: import("express").Response, error: unknown, context: string) {
  console.error(context, error);
  response.status(500).json({ error: "We couldn't complete that department request. Please try again." });
}

function localDate(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function utcBoundary(date: string, timezone: string) {
  const desired = new Date(`${date}T00:00:00.000Z`);
  let result = desired;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(result);
    const values = new Map(parts.map(({ type, value }) => [type, value]));
    const represented = Date.UTC(
      Number(values.get("year")),
      Number(values.get("month")) - 1,
      Number(values.get("day")),
      Number(values.get("hour")),
      Number(values.get("minute")),
      Number(values.get("second")),
    );
    result = new Date(desired.getTime() - (represented - result.getTime()));
  }
  return result.toISOString();
}

async function getBusinessDay(admin: ReturnType<typeof createSupabaseAdminClient>) {
  const { data, error } = await admin.from("business_settings").select("timezone").single();
  if (error) throw error;
  const timezone = data.timezone || "Africa/Lagos";
  const date = localDate(timezone);
  const start = utcBoundary(date, timezone);
  const nextDate = new Date(`${date}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const end = utcBoundary(nextDate.toISOString().slice(0, 10), timezone);
  return { date, start, end };
}

async function getHeadDepartment(admin: ReturnType<typeof createSupabaseAdminClient>, userId: string, departmentId: string | null) {
  if (!departmentId) return null;
  const { data, error } = await admin
    .from("departments")
    .select("id, name, head_user_id")
    .eq("head_user_id", userId)
    .eq("id", departmentId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

router.use(requireUser);

router.get("/access", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to view department access." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const department = await getHeadDepartment(admin, user.id, user.departmentId);
    response.status(200).json({
      isDepartmentHead: Boolean(department),
      departmentId: department?.id ?? null,
      departmentName: department?.name ?? null,
    });
  } catch (error: unknown) {
    sendDepartmentError(response, error, "Could not verify department head access.");
  }
});

router.get("/overview", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to view the department overview." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const department = await getHeadDepartment(admin, user.id, user.departmentId);
    if (!department) {
      response.status(403).json({ error: "Only the assigned head of department can view this team overview." });
      return;
    }
    const { date, start, end } = await getBusinessDay(admin);
    const [
      { data: members, error: membersError },
      { data: attendance, error: attendanceError },
      { data: sales, error: salesError },
      { data: closures, error: closuresError },
    ] = await Promise.all([
      admin.from("profiles").select("id, display_name, role").eq("department_id", department.id).eq("is_active", true).eq("is_archived", false).order("display_name"),
      admin.from("attendance_records").select("id, user_id, check_in_at, check_out_at").eq("work_date", date),
      admin.from("sales").select("id, seller_id, payment_method, total_amount, created_at").eq("department_id", department.id).gte("created_at", start).lt("created_at", end).order("created_at", { ascending: false }).limit(100),
      admin.from("shift_closings").select("id, user_id, business_date, opening_cash, cash_sales, cash_received, cash_paid_out, expected_cash, actual_cash, variance, handover_notes, handed_to, closed_at").eq("department_id", department.id).order("closed_at", { ascending: false }).limit(100),
    ]);
    const failure = membersError ?? attendanceError ?? salesError ?? closuresError;
    if (failure) {
      sendDepartmentError(response, failure, "Could not load department operations.");
      return;
    }
    const memberIds = (members ?? []).map((member) => member.id);
    const salesIds = (sales ?? []).map((sale) => sale.id);
    const closureUserIds = [...new Set((closures ?? []).flatMap((closure) => [closure.user_id, closure.handed_to].filter((id): id is string => Boolean(id))))];
    const [
      { data: salesItems, error: salesItemsError },
      { data: closureProfiles, error: closureProfilesError },
    ] = await Promise.all([
      salesIds.length ? admin.from("sale_items").select("sale_id, product_name, quantity, line_total").in("sale_id", salesIds) : Promise.resolve({ data: [], error: null }),
      closureUserIds.length ? admin.from("profiles").select("id, display_name").in("id", closureUserIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (salesItemsError || closureProfilesError) {
      sendDepartmentError(response, salesItemsError ?? closureProfilesError, "Could not load department operation details.");
      return;
    }
    const memberById = new Map((members ?? []).map((member) => [member.id, member]));
    const attendanceByUser = new Map((attendance ?? []).filter((record) => record.user_id && memberIds.includes(record.user_id)).map((record) => [record.user_id, record]));
    const closureNameById = new Map((closureProfiles ?? []).map((profile) => [profile.id, profile.display_name ?? "Team member"]));
    const itemsBySale = new Map<string, typeof salesItems>();
    for (const item of salesItems ?? []) itemsBySale.set(item.sale_id, [...(itemsBySale.get(item.sale_id) ?? []), item]);
    response.status(200).json({
      department: { id: department.id, name: department.name },
      businessDate: date,
      staff: (members ?? []).map((member) => {
        const record = attendanceByUser.get(member.id);
        return {
          id: member.id,
          name: member.display_name ?? "Team member",
          role: member.role,
          clockedIn: Boolean(record && !record.check_out_at),
          clockIn: record?.check_in_at ?? null,
          clockOut: record?.check_out_at ?? null,
        };
      }),
      sales: (sales ?? []).map((sale) => ({
        id: sale.id,
        sellerName: memberById.get(sale.seller_id)?.display_name ?? "Team member",
        paymentMethod: sale.payment_method,
        total: Number(sale.total_amount),
        createdAt: sale.created_at,
        items: (itemsBySale.get(sale.id) ?? []).map((item) => ({
          name: item.product_name,
          quantity: item.quantity,
          total: Number(item.line_total),
        })),
      })),
      closures: (closures ?? []).map((closure) => ({
        id: closure.id,
        staffName: closureNameById.get(closure.user_id) ?? "Team member",
        handedToName: closure.handed_to ? closureNameById.get(closure.handed_to) ?? "Team member" : null,
        businessDate: closure.business_date,
        openingCash: Number(closure.opening_cash),
        cashSales: Number(closure.cash_sales),
        cashReceived: Number(closure.cash_received),
        cashPaidOut: Number(closure.cash_paid_out),
        expectedCash: Number(closure.expected_cash),
        actualCash: Number(closure.actual_cash),
        variance: Number(closure.variance),
        handoverNotes: closure.handover_notes,
        closedAt: closure.closed_at,
      })),
    });
  } catch (error: unknown) {
    sendDepartmentError(response, error, "Could not initialize department operations.");
  }
});

router.get("/closures", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to view shift closures." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const headDepartment = await getHeadDepartment(admin, user.id, user.departmentId);
    let query = admin.from("shift_closings")
      .select("id, department_id, user_id, business_date, opening_cash, cash_sales, cash_received, cash_paid_out, expected_cash, actual_cash, variance, handover_notes, handed_to, closed_at")
      .order("closed_at", { ascending: false })
      .limit(100);
    if (adminRoles.has(user.role)) {
      // Administrators can review all departments.
    } else if (headDepartment) {
      query = query.eq("department_id", headDepartment.id);
    } else {
      query = query.eq("user_id", user.id);
    }
    const { data: closures, error } = await query;
    if (error) {
      sendDepartmentError(response, error, "Could not load shift closures.");
      return;
    }
    const departmentIds = [...new Set((closures ?? []).map((closure) => closure.department_id))];
    const profileIds = [...new Set((closures ?? []).flatMap((closure) => [closure.user_id, closure.handed_to].filter((id): id is string => Boolean(id))))];
    const [{ data: departments, error: departmentsError }, { data: profiles, error: profilesError }] = await Promise.all([
      departmentIds.length ? admin.from("departments").select("id, name").in("id", departmentIds) : Promise.resolve({ data: [], error: null }),
      profileIds.length ? admin.from("profiles").select("id, display_name").in("id", profileIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (departmentsError || profilesError) {
      sendDepartmentError(response, departmentsError ?? profilesError, "Could not load shift closure details.");
      return;
    }
    const departmentNames = new Map((departments ?? []).map((item) => [item.id, item.name]));
    const profileNames = new Map((profiles ?? []).map((item) => [item.id, item.display_name ?? "Team member"]));
    let closeout = {
      businessDate: null as string | null,
      cashSales: 0,
      clockedIn: false,
      alreadyClosed: false,
      handedToName: null as string | null,
    };
    if (!adminRoles.has(user.role) && user.departmentId) {
      const { date, start, end } = await getBusinessDay(admin);
      const [{ data: shift, error: shiftError }, { data: cashSales, error: cashSalesError }, { data: existing, error: existingError }, { data: currentDepartment, error: currentDepartmentError }] = await Promise.all([
        admin.from("attendance_records").select("id").eq("user_id", user.id).eq("work_date", date).is("check_out_at", null).maybeSingle(),
        admin.from("sales").select("total_amount").eq("seller_id", user.id).eq("department_id", user.departmentId).eq("payment_method", "cash").gte("created_at", start).lt("created_at", end),
        admin.from("shift_closings").select("id").eq("user_id", user.id).eq("business_date", date).maybeSingle(),
        admin.from("departments").select("head_user_id").eq("id", user.departmentId).maybeSingle(),
      ]);
      const closeoutFailure = shiftError ?? cashSalesError ?? existingError ?? currentDepartmentError;
      if (closeoutFailure) {
        sendDepartmentError(response, closeoutFailure, "Could not load today's shift close status.");
        return;
      }
      closeout = {
        businessDate: date,
        cashSales: (cashSales ?? []).reduce((total, sale) => total + Number(sale.total_amount), 0),
        clockedIn: Boolean(shift),
        alreadyClosed: Boolean(existing),
        handedToName: null,
      };
      if (currentDepartment?.head_user_id) {
        const { data: headProfile, error: headProfileError } = await admin.from("profiles")
          .select("display_name")
          .eq("id", currentDepartment.head_user_id)
          .eq("department_id", user.departmentId)
          .eq("is_active", true)
          .eq("is_archived", false)
          .maybeSingle();
        if (headProfileError) {
          sendDepartmentError(response, headProfileError, "Could not load the department head's name.");
          return;
        }
        closeout.handedToName = headProfile?.display_name ?? "Department head";
      }
    }
    response.status(200).json({
      ...closeout,
      canClose: closeout.clockedIn && !closeout.alreadyClosed && !adminRoles.has(user.role) && Boolean(closeout.handedToName),
      closures: (closures ?? []).map((closure) => ({
        id: closure.id,
        departmentName: departmentNames.get(closure.department_id) ?? "Department",
        staffName: profileNames.get(closure.user_id) ?? "Team member",
        handedToName: closure.handed_to ? profileNames.get(closure.handed_to) ?? "Team member" : null,
        businessDate: closure.business_date,
        openingCash: Number(closure.opening_cash),
        cashSales: Number(closure.cash_sales),
        cashReceived: Number(closure.cash_received),
        cashPaidOut: Number(closure.cash_paid_out),
        expectedCash: Number(closure.expected_cash),
        actualCash: Number(closure.actual_cash),
        variance: Number(closure.variance),
        handoverNotes: closure.handover_notes,
        closedAt: closure.closed_at,
      })),
    });
  } catch (error: unknown) {
    sendDepartmentError(response, error, "Could not initialize shift closures.");
  }
});

router.post("/closures", async (request, response) => {
  const user = request.flexbarUser;
  if (user && adminRoles.has(user.role)) {
    response.status(403).json({ error: "Administrator accounts review shift closures; staff members submit them." });
    return;
  }
  if (!user?.departmentId) {
    response.status(403).json({ error: "Assign your account to a department before closing a shift." });
    return;
  }
  const { openingCash, cashReceived, cashPaidOut, actualCash, handoverNotes } = request.body ?? {};
  const amounts = [openingCash, cashReceived, cashPaidOut, actualCash];
  if (amounts.some((amount) => typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) ||
    (handoverNotes !== undefined && (typeof handoverNotes !== "string" || handoverNotes.length > 1000))) {
    response.status(400).json({ error: "Enter valid non-negative cash amounts and handover notes under 1,000 characters." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { date, start, end } = await getBusinessDay(admin);
    const [{ data: shift, error: shiftError }, { data: department, error: departmentError }, { data: sales, error: salesError }] = await Promise.all([
      admin.from("attendance_records").select("id").eq("user_id", user.id).eq("work_date", date).is("check_out_at", null).maybeSingle(),
      admin.from("departments").select("id, head_user_id").eq("id", user.departmentId).maybeSingle(),
      admin.from("sales").select("total_amount").eq("department_id", user.departmentId).eq("seller_id", user.id).eq("payment_method", "cash").gte("created_at", start).lt("created_at", end),
    ]);
    const failure = shiftError ?? departmentError ?? salesError;
    if (failure) {
      sendDepartmentError(response, failure, "Could not calculate the shift cash close.");
      return;
    }
    if (!shift) {
      response.status(409).json({ error: "You must be clocked in to submit your shift close. Record it before clocking out." });
      return;
    }
    if (!department?.head_user_id) {
      response.status(409).json({ error: "Ask your administrator to assign a head of department before closing and handing over cash." });
      return;
    }
    const { data: head, error: headError } = await admin.from("profiles")
      .select("id")
      .eq("id", department.head_user_id)
      .eq("department_id", department.id)
      .eq("is_active", true)
      .eq("is_archived", false)
      .maybeSingle();
    if (headError) {
      sendDepartmentError(response, headError, "Could not verify the department cash handover recipient.");
      return;
    }
    if (!head) {
      response.status(409).json({ error: "Ask your administrator to assign an active head of department before closing and handing over cash." });
      return;
    }
    const cashSales = (sales ?? []).reduce((total, sale) => total + Number(sale.total_amount), 0);
    const expectedCash = Math.round((openingCash + cashSales + cashReceived - cashPaidOut) * 100) / 100;
    if (expectedCash < 0) {
      response.status(400).json({ error: "Cash paid out cannot exceed the opening balance plus recorded cash received and cash sales." });
      return;
    }
    const receiverId = department.head_user_id;
    const { data: closure, error } = await admin.from("shift_closings").insert({
      department_id: user.departmentId,
      user_id: user.id,
      business_date: date,
      opening_cash: openingCash,
      cash_sales: cashSales,
      cash_received: cashReceived,
      cash_paid_out: cashPaidOut,
      expected_cash: expectedCash,
      actual_cash: actualCash,
      variance: actualCash - expectedCash,
      handover_notes: typeof handoverNotes === "string" ? handoverNotes.trim() || null : null,
      handed_to: receiverId,
    }).select("id, business_date, cash_sales, expected_cash, actual_cash, variance, closed_at").single();
    if (error?.code === "23505") {
      response.status(409).json({ error: "A shift close has already been submitted for today." });
      return;
    }
    if (error) {
      sendDepartmentError(response, error, "Could not save the shift cash close.");
      return;
    }
    response.status(201).json({
      closure: {
        id: closure.id,
        businessDate: closure.business_date,
        cashSales: Number(closure.cash_sales),
        expectedCash: Number(closure.expected_cash),
        actualCash: Number(closure.actual_cash),
        variance: Number(closure.variance),
        closedAt: closure.closed_at,
      },
      message: "Shift cash balance saved and handed over to your department head.",
    });
  } catch (error: unknown) {
    sendDepartmentError(response, error, "Could not initialize the shift cash close.");
  }
});

router.get("/meetings", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to view department meetings." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const canViewAll = adminRoles.has(user.role);
    let query = admin.from("department_meetings")
      .select("id, department_id, is_company_wide, title, agenda, starts_at, is_instant, location, call_mode, created_by, created_at")
      .gte("starts_at", new Date(Date.now() - 8 * 60 * 60_000).toISOString())
      .order("starts_at", { ascending: true })
      .limit(100);
    if (!canViewAll) {
      if (!user.departmentId) {
        response.status(403).json({ error: "Assign your account to a department to view its meetings." });
        return;
      }
      query = query.or(`department_id.eq.${user.departmentId},is_company_wide.eq.true`);
    }
    const { data: meetings, error } = await query;
    if (error) {
      sendDepartmentError(response, error, "Could not load department meetings.");
      return;
    }
    const departmentIds = [...new Set((meetings ?? []).flatMap((meeting) => meeting.department_id ? [meeting.department_id] : []))];
    const creatorIds = [...new Set((meetings ?? []).map((meeting) => meeting.created_by))];
    const [{ data: departments, error: departmentsError }, { data: profiles, error: profilesError }, { data: availableDepartments, error: availableDepartmentsError }] = await Promise.all([
      departmentIds.length ? admin.from("departments").select("id, name").in("id", departmentIds) : Promise.resolve({ data: [], error: null }),
      creatorIds.length ? admin.from("profiles").select("id, display_name").in("id", creatorIds) : Promise.resolve({ data: [], error: null }),
      canViewAll ? admin.from("departments").select("id, name").order("name") : Promise.resolve({ data: [], error: null }),
    ]);
    if (departmentsError || profilesError || availableDepartmentsError) {
      sendDepartmentError(response, departmentsError ?? profilesError ?? availableDepartmentsError, "Could not load meeting details.");
      return;
    }
    const departmentNames = new Map((departments ?? []).map((department) => [department.id, department.name]));
    const creatorNames = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name ?? "Team member"]));
    const headDepartment = await getHeadDepartment(admin, user.id, user.departmentId);
    response.status(200).json({
      meetings: (meetings ?? []).map((meeting) => ({
        id: meeting.id,
        departmentId: meeting.department_id,
        departmentName: meeting.is_company_wide ? "All departments" : departmentNames.get(meeting.department_id ?? "") ?? "Department",
        title: meeting.title,
        agenda: meeting.agenda,
        startsAt: meeting.starts_at,
        isInstant: meeting.is_instant,
        callMode: meeting.call_mode,
        location: meeting.location,
        createdByName: creatorNames.get(meeting.created_by) ?? "Team member",
        createdAt: meeting.created_at,
      })),
      canCreate: canViewAll || Boolean(headDepartment),
      isAdmin: canViewAll,
      departments: (availableDepartments ?? []).map(({ id, name }) => ({ id, name })),
    });
  } catch (error: unknown) {
    sendDepartmentError(response, error, "Could not initialize department meetings.");
  }
});

router.post("/meetings", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to schedule a meeting." });
    return;
  }
  const { title, agenda, startsAt, location, departmentId, callMode, instant } = request.body ?? {};
  const isInstant = instant === true;
  const isCompanyWide = departmentId === "all";
  const scheduledStartTime = typeof startsAt === "string" ? Date.parse(startsAt) : NaN;
  if (
    typeof title !== "string" || title.trim().length < 3 || title.trim().length > 120 ||
    (instant !== undefined && typeof instant !== "boolean") ||
    (!isInstant && (typeof agenda !== "string" || agenda.trim().length < 3 || agenda.trim().length > 2000)) ||
    (isInstant && agenda !== undefined && (typeof agenda !== "string" || agenda.trim().length > 2000)) ||
    (!isInstant && (!Number.isFinite(scheduledStartTime) || scheduledStartTime <= Date.now())) ||
    (location !== undefined && (typeof location !== "string" || location.length > 160)) ||
    (departmentId !== undefined && (typeof departmentId !== "string" || (!isCompanyWide && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(departmentId)))) ||
    (callMode !== undefined && callMode !== "voice" && callMode !== "video")
  ) {
    response.status(400).json({
      error: isInstant
        ? "Enter a meeting title and an optional agenda under 2,000 characters."
        : "Enter a meeting title, agenda, future start time, and a location under 160 characters.",
    });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const canScheduleAll = adminRoles.has(user.role);
    if (isCompanyWide && !canScheduleAll) {
      response.status(403).json({ error: "Only an administrator can start a meeting for all departments." });
      return;
    }
    const department = canScheduleAll
      ? isCompanyWide
        ? null
        : departmentId
        ? await admin.from("departments").select("id, name").eq("id", departmentId).maybeSingle().then(({ data, error }) => {
          if (error) throw error;
          return data;
        })
        : null
      : await getHeadDepartment(admin, user.id, user.departmentId);
    if (canScheduleAll && !department && !isCompanyWide) {
      response.status(400).json({ error: "Choose a department for this meeting." });
      return;
    }
    if (!department && !isCompanyWide) {
      response.status(403).json({ error: "Only the assigned head of department can schedule team meetings." });
      return;
    }
    const departmentName = isCompanyWide ? "All departments" : department?.name ?? "Department";
    const meetingStartsAt = isInstant ? new Date() : new Date(scheduledStartTime);
    const meetingAgenda = typeof agenda === "string" && agenda.trim()
      ? agenda.trim()
      : "Instant department meeting";
    const { data, error } = await admin.from("department_meetings").insert({
      department_id: department?.id ?? null,
      is_company_wide: isCompanyWide,
      created_by: user.id,
      title: title.trim(),
      agenda: meetingAgenda,
      starts_at: meetingStartsAt.toISOString(),
      is_instant: isInstant,
      location: isInstant ? null : typeof location === "string" ? location.trim() || null : null,
      call_mode: callMode === "voice" ? "voice" : "video",
    }).select("id, title, agenda, starts_at, is_instant, location, call_mode, created_at").single();
    if (error) {
      sendDepartmentError(response, error, "Could not schedule department meeting.");
      return;
    }
    response.status(201).json({
      meeting: {
        id: data.id,
        departmentId: department?.id ?? null,
        departmentName,
        title: data.title,
        agenda: data.agenda,
        startsAt: data.starts_at,
        isInstant: data.is_instant,
        location: data.location,
        callMode: data.call_mode,
        createdByName: user.displayName ?? (canScheduleAll ? "Administrator" : "Department head"),
        createdAt: data.created_at,
      },
      message: isInstant
        ? `Instant meeting started for ${departmentName}. Your team and administrators can join now.`
        : canScheduleAll
          ? `Meeting scheduled for ${departmentName}. All administrators can join this and every department meeting.`
          : "Department meeting scheduled. All administrators can join this and every department meeting.",
    });
  } catch (error: unknown) {
    sendDepartmentError(response, error, "Could not initialize department meeting creation.");
  }
});

router.get("/meetings/:meetingId/room", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to join a meeting." });
    return;
  }
  const meetingId = request.params.meetingId;
  if (!meetingId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meetingId)) {
    response.status(400).json({ error: "Choose a valid meeting." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: meeting, error } = await admin.from("department_meetings")
      .select("id, department_id, is_company_wide, title, starts_at, call_mode")
      .eq("id", meetingId)
      .maybeSingle();
    if (error) {
      sendDepartmentError(response, error, "Could not load meeting room.");
      return;
    }
    if (!meeting) {
      response.status(404).json({ error: "This meeting could not be found." });
      return;
    }
    const canJoin = adminRoles.has(user.role) || user.departmentId === meeting.department_id || meeting.is_company_wide;
    if (!canJoin) {
      response.status(403).json({ error: "This meeting is only available to its department and administrators." });
      return;
    }
    const startTime = Date.parse(meeting.starts_at);
    if (Date.now() < startTime - 15 * 60_000 || Date.now() > startTime + 8 * 60 * 60_000) {
      response.status(409).json({ error: "The live room opens 15 minutes before the scheduled time and closes eight hours after it." });
      return;
    }
    const { data: department, error: departmentError } = meeting.department_id
      ? await admin.from("departments")
      .select("name")
      .eq("id", meeting.department_id)
      .single()
      : { data: null, error: null };
    if (departmentError) {
      sendDepartmentError(response, departmentError, "Could not load meeting department.");
      return;
    }
    const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
      { urls: "stun:stun.l.google.com:19302" },
    ];
    const turnUrls = process.env.TURN_URLS?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
    if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      iceServers.push({
        urls: turnUrls,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    }
    response.status(200).json({
      meeting: {
        id: meeting.id,
        title: meeting.title,
        departmentName: meeting.is_company_wide ? "All departments" : department?.name ?? "Department",
        startsAt: meeting.starts_at,
        callMode: meeting.call_mode,
      },
      user: { id: user.id, name: user.displayName ?? "Team member", role: user.role, avatarPath: user.avatarPath },
      iceServers,
      turnConfigured: turnUrls.length > 0 && Boolean(process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL),
      adminInCall: adminRoles.has(user.role),
    });
  } catch (error: unknown) {
    sendDepartmentError(response, error, "Could not initialize the meeting room.");
  }
});

export { router as departmentRouter };
