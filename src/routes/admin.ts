import { Router } from "express";
import type { Request, Response } from "express";
import { requireSuperAdmin } from "../auth/requireSuperAdmin.js";
import { requireUser } from "../auth/requireUser.js";
import { appRoles, isAppRole } from "../auth/roles.js";
import { AdminActivityWriteError, recordAdminActivity } from "../services/adminActivity.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();
const primaryAdminId = "9668b2c5-428f-4d38-a29f-b5de8aa3d6b0";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nonSellingDepartmentPattern = /\b(management|admin|administration|kitchen|inventory|store|cleaning|maintenance|security|finance|human resources|operations|laundry)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frontendRedirect(request: Request, query: string): string | undefined {
  const configuredBase = process.env.FRONTEND_URL;
  const fallbackBase = process.env.VERCEL
    ? "https://flaxbarmanagement.vercel.app"
    : "http://localhost:5173";
  const base = configuredBase
    ? new URL(configuredBase).hostname === "localhost" || new URL(configuredBase).hostname === "127.0.0.1"
      ? fallbackBase
      : configuredBase
    : process.env.VERCEL
      ? fallbackBase
      : request.get("origin") ?? fallbackBase;
  if (!base) return undefined;
  const redirect = new URL(base);
  redirect.pathname = "/";
  redirect.search = query;
  redirect.hash = "";
  return redirect.toString();
}

function sendAdminError(response: Response, error: unknown, message: string) {
  console.error(message, error);
  if (error instanceof AdminActivityWriteError) {
    response.status(502).json({ error: "The change was saved, but its administrator activity entry could not be saved. Do not repeat the change; contact support." });
    return;
  }
  if (error instanceof Error && error.message.includes("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY")) {
    response.status(503).json({ error: "Secure admin tools are not configured yet. Please contact the system administrator." });
    return;
  }
  response.status(500).json({ error: "We couldn't complete that request. Please try again or contact your administrator." });
}

router.use(requireUser);

router.get("/settings", requireSuperAdmin, async (_request, response) => {
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("business_settings")
      .select("currency, timezone, opening_time, closing_time, notify_task_assignments, notify_low_stock, notify_sales_updates, notify_new_messages")
      .eq("id", 1)
      .single();
    if (error) {
      sendAdminError(response, error, "Could not load business settings.");
      return;
    }
    response.status(200).json({
      currency: data.currency,
      timezone: data.timezone,
      openingTime: data.opening_time.slice(0, 5),
      closingTime: data.closing_time.slice(0, 5),
      notifications: {
        taskAssignments: data.notify_task_assignments,
        lowStock: data.notify_low_stock,
        salesUpdates: data.notify_sales_updates,
        newMessages: data.notify_new_messages,
      },
    });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize business settings.");
  }
});

router.put("/settings", requireSuperAdmin, async (request, response) => {
  if (!isRecord(request.body) || !isRecord(request.body.notifications)) {
    response.status(400).json({ error: "Review the business and notification settings and try again." });
    return;
  }
  const { currency, timezone, openingTime, closingTime, notifications } = request.body;
  const validCurrencies = ["NGN", "USD", "GBP", "EUR"];
  const validTime = (value: unknown): value is string =>
    typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const notificationKeys = ["taskAssignments", "lowStock", "salesUpdates", "newMessages"] as const;
  if (
    typeof currency !== "string" ||
    !validCurrencies.includes(currency) ||
    typeof timezone !== "string" ||
    !validTime(openingTime) ||
    !validTime(closingTime) ||
    notificationKeys.some((key) => typeof notifications[key] !== "boolean")
  ) {
    response.status(400).json({ error: "Enter a valid currency, timezone, business hours, and notification choices." });
    return;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    response.status(400).json({ error: "Choose a valid business timezone." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from("business_settings").upsert({
      id: 1,
      currency,
      timezone,
      opening_time: openingTime,
      closing_time: closingTime,
      notify_task_assignments: notifications.taskAssignments,
      notify_low_stock: notifications.lowStock,
      notify_sales_updates: notifications.salesUpdates,
      notify_new_messages: notifications.newMessages,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      sendAdminError(response, error, "Could not save business settings.");
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to save business settings." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "settings.updated",
      targetType: "business_settings",
      targetLabel: "Business and notification settings",
      details: {
        currency,
        timezone,
        openingTime,
        closingTime,
        notifications,
      },
    });
    response.status(200).json({ message: "Business and notification settings saved." });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize business settings.");
  }
});

router.get("/activity", requireSuperAdmin, async (_request, response) => {
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("admin_activity_logs")
      .select("id, actor_name, actor_email, action, target_type, target_id, target_label, details, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      sendAdminError(response, error, "Could not load administrator activity.");
      return;
    }
    response.status(200).json({
      activities: (data ?? []).map((entry) => ({
        id: entry.id,
        actorName: entry.actor_name,
        actorEmail: entry.actor_email,
        action: entry.action,
        targetType: entry.target_type,
        targetId: entry.target_id,
        targetLabel: entry.target_label,
        details: entry.details,
        createdAt: entry.created_at,
      })),
    });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize administrator activity.");
  }
});

router.get("/departments", async (_request, response) => {
  try {
    const admin = createSupabaseAdminClient();
    const [{ data, error }, { data: profiles, error: profileError }] = await Promise.all([
      admin
      .from("departments")
      .select("id, name, sales_enabled, head_user_id, created_at")
      .order("name"),
      admin.from("profiles").select("id, department_id, display_name, role, is_active, is_archived").eq("is_archived", false).order("display_name"),
    ]);
    if (error || profileError) {
      sendAdminError(response, error ?? profileError, "Could not load departments.");
      return;
    }
    const staffCounts = new Map<string, number>();
    const membersByDepartment = new Map<string, Array<{
      id: string;
      name: string;
      role: string;
      isActive: boolean;
    }>>();
    for (const profile of profiles ?? []) {
      if (profile.department_id) {
        staffCounts.set(profile.department_id, (staffCounts.get(profile.department_id) ?? 0) + 1);
        membersByDepartment.set(profile.department_id, [
          ...(membersByDepartment.get(profile.department_id) ?? []),
          {
            id: profile.id,
            name: profile.display_name ?? "Team member",
            role: profile.role,
            isActive: profile.is_active,
          },
        ]);
      }
    }
    response.status(200).json({
      departments: (data ?? []).map((department) => ({
        ...department,
        salesEnabled: department.sales_enabled,
        staffCount: staffCounts.get(department.id) ?? 0,
        members: membersByDepartment.get(department.id) ?? [],
        headUserId: department.head_user_id,
        headName: membersByDepartment.get(department.id)?.find((member) => member.id === department.head_user_id)?.name ?? null,
        salesEligible: !nonSellingDepartmentPattern.test(department.name),
      })),
    });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize department access.");
  }
});

router.post("/departments", requireSuperAdmin, async (request, response) => {
  if (!isRecord(request.body) || typeof request.body.name !== "string") {
    response.status(400).json({ error: "Enter a department name." });
    return;
  }
  const name = request.body.name.trim();
  if (name.length < 2 || name.length > 80) {
    response.status(400).json({ error: "Department names must be between 2 and 80 characters." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("departments")
      .insert({ name })
      .select("id, name, created_at")
      .single();
    if (error?.code === "23505") {
      response.status(409).json({ error: "A department with that name already exists." });
      return;
    }
    if (error) {
      sendAdminError(response, error, "Could not create department.");
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to create a department." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "department.created",
      targetType: "department",
      targetId: data.id,
      targetLabel: data.name,
      details: { name: data.name },
    });
    response.status(201).json({ department: data });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize department creation.");
  }
});

router.patch("/departments/:departmentId", requireSuperAdmin, async (request, response) => {
  const { departmentId } = request.params;
  if (typeof departmentId !== "string" || !uuidPattern.test(departmentId) || !isRecord(request.body) || typeof request.body.name !== "string") {
    response.status(400).json({ error: "Enter a valid department name." });
    return;
  }
  const name = request.body.name.trim();
  if (name.length < 2 || name.length > 80) {
    response.status(400).json({ error: "Department names must be between 2 and 80 characters." });
    return;
  }
  const actor = request.flexbarUser;
  if (!actor) {
    response.status(401).json({ error: "Please sign in to rename departments." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("departments")
      .update({
        name,
        ...(nonSellingDepartmentPattern.test(name)
          ? { sales_enabled: false }
          : ["bar", "restaurant floor", "cashier"].includes(name.toLowerCase())
            ? { sales_enabled: true }
            : {}),
      })
      .eq("id", departmentId)
      .select("id, name, sales_enabled")
      .maybeSingle();
    if (error?.code === "23505") {
      response.status(409).json({ error: "A department with that name already exists." });
      return;
    }
    if (error) {
      sendAdminError(response, error, "Could not rename department.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That department could not be found." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "department.renamed",
      targetType: "department",
      targetId: data.id,
      targetLabel: data.name,
      details: { name: data.name, salesEnabled: data.sales_enabled },
    });
    response.status(200).json({ department: { id: data.id, name: data.name, salesEnabled: data.sales_enabled } });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize department rename.");
  }
});

router.patch("/departments/:departmentId/head", requireSuperAdmin, async (request, response) => {
  const { departmentId } = request.params;
  const headUserId = isRecord(request.body) ? request.body.headUserId : undefined;
  if (
    typeof departmentId !== "string" || !uuidPattern.test(departmentId) ||
    (headUserId !== null && (typeof headUserId !== "string" || !uuidPattern.test(headUserId)))
  ) {
    response.status(400).json({ error: "Choose a valid department and department head." });
    return;
  }
  const actor = request.flexbarUser;
  if (!actor) {
    response.status(401).json({ error: "Please sign in to assign a department head." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    let headName: string | null = null;
    if (headUserId) {
      const { data: member, error: memberError } = await admin
        .from("profiles")
        .select("id, department_id, display_name, is_active, is_archived")
        .eq("id", headUserId)
        .maybeSingle();
      if (memberError) {
        sendAdminError(response, memberError, "Could not verify the department head.");
        return;
      }
      if (!member || member.department_id !== departmentId || !member.is_active || member.is_archived) {
        response.status(400).json({ error: "Department head must be an active member of this department." });
        return;
      }
      headName = member.display_name ?? "Team member";
    }
    const { data, error } = await admin
      .from("departments")
      .update({ head_user_id: headUserId })
      .eq("id", departmentId)
      .select("id, name, head_user_id")
      .maybeSingle();
    if (error) {
      sendAdminError(response, error, "Could not assign department head.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That department could not be found." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "department.head_assigned",
      targetType: "department",
      targetId: data.id,
      targetLabel: data.name,
      details: { headUserId: data.head_user_id, headName },
    });
    response.status(200).json({ department: { id: data.id, name: data.name, headUserId: data.head_user_id, headName } });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize department head assignment.");
  }
});

router.patch("/departments/:departmentId/sales", requireSuperAdmin, async (request, response) => {
  const { departmentId } = request.params;
  if (typeof departmentId !== "string" || !uuidPattern.test(departmentId) || !isRecord(request.body) || typeof request.body.salesEnabled !== "boolean") {
    response.status(400).json({ error: "Choose a department and a valid sales access setting." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: department, error: departmentError } = await admin
      .from("departments")
      .select("id, name")
      .eq("id", departmentId)
      .maybeSingle();
    if (departmentError) {
      sendAdminError(response, departmentError, "Could not verify department sales eligibility.");
      return;
    }
    if (!department) {
      response.status(404).json({ error: "That department could not be found." });
      return;
    }
    if (request.body.salesEnabled && nonSellingDepartmentPattern.test(department.name)) {
      response.status(400).json({ error: "Management, kitchen, inventory, cleaning, and other non-customer-facing departments cannot record sales." });
      return;
    }
    const { data, error } = await admin
      .from("departments")
      .update({ sales_enabled: request.body.salesEnabled })
      .eq("id", departmentId)
      .select("id, name, sales_enabled")
      .maybeSingle();
    if (error) {
      sendAdminError(response, error, "Could not update department sales access.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That department could not be found." });
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to manage departments." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "department.sales_access_updated",
      targetType: "department",
      targetId: data.id,
      targetLabel: data.name,
      details: { salesEnabled: data.sales_enabled },
    });
    response.status(200).json({ department: { id: data.id, name: data.name, salesEnabled: data.sales_enabled } });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize department sales access update.");
  }
});

router.get("/users", requireSuperAdmin, async (_request, response) => {
  try {
    const admin = createSupabaseAdminClient();
    const [{ data: profiles, error: profilesError }, { data: departments, error: departmentsError }] =
      await Promise.all([
        admin.from("profiles").select("id, display_name, role, is_active, is_archived, department_id").order("created_at"),
        admin.from("departments").select("id, name"),
      ]);
    if (profilesError || departmentsError) {
      sendAdminError(response, profilesError ?? departmentsError, "Could not load user records.");
      return;
    }

    const authUsers = [];
    for (let page = 1; ; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) {
        sendAdminError(response, error, "Could not load account emails.");
        return;
      }
      authUsers.push(...data.users);
      if (data.users.length < 1000) break;
    }
    const emailById = new Map(authUsers.map((authUser) => [authUser.id, authUser.email ?? null]));
    const departmentById = new Map((departments ?? []).map((department) => [department.id, department.name]));

    response.status(200).json({
      users: (profiles ?? []).filter((profile) => profile.id !== primaryAdminId && profile.role !== "super_admin").map((profile) => ({
        id: profile.id,
        displayName: profile.display_name,
        email: emailById.get(profile.id) ?? null,
        role: profile.role,
        isActive: profile.is_active,
        isArchived: profile.is_archived,
        departmentId: profile.department_id,
        departmentName: profile.department_id ? departmentById.get(profile.department_id) ?? null : null,
      })),
      departments,
      assignableRoles: appRoles.filter((role) => role !== "super_admin"),
    });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize user management.");
  }
});

router.post("/users", requireSuperAdmin, async (request, response) => {
  if (
    !isRecord(request.body) ||
    typeof request.body.email !== "string" ||
    typeof request.body.displayName !== "string" ||
    typeof request.body.role !== "string" ||
    typeof request.body.password !== "string"
  ) {
    response.status(400).json({ error: "Enter the new staff member’s name, email, role, and initial password." });
    return;
  }
  const email = request.body.email.trim().toLowerCase();
  const displayName = request.body.displayName.trim();
  const role = request.body.role;
  const departmentId = request.body.departmentId;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    response.status(400).json({ error: "Enter a valid work email address." });
    return;
  }
  if (displayName.length < 2 || displayName.length > 100) {
    response.status(400).json({ error: "Names must be between 2 and 100 characters." });
    return;
  }
  if (request.body.password.length < 8 || request.body.password.length > 128) {
    response.status(400).json({ error: "Passwords must be between 8 and 128 characters." });
    return;
  }
  if (!isAppRole(role) || role === "super_admin") {
    response.status(400).json({ error: "Choose a valid staff role. The primary super-admin role is protected." });
    return;
  }
  if (departmentId !== null && departmentId !== undefined && (typeof departmentId !== "string" || !uuidPattern.test(departmentId))) {
    response.status(400).json({ error: "Choose a valid department." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    if (departmentId) {
      const { data: department, error: departmentError } = await admin
        .from("departments")
        .select("id")
        .eq("id", departmentId)
        .maybeSingle();
      if (departmentError) {
        sendAdminError(response, departmentError, "Could not verify the selected department.");
        return;
      }
      if (!department) {
        response.status(400).json({ error: "The selected department no longer exists." });
        return;
      }
    }

    const { data: createdAccount, error: createError } = await admin.auth.admin.createUser({
      email,
      password: request.body.password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (createError) {
      if (createError.message.toLowerCase().includes("already been registered")) {
        response.status(409).json({ error: "An account already exists for that email address." });
        return;
      }
      sendAdminError(response, createError, "Could not create the new staff account.");
      return;
    }
    if (!createdAccount.user) {
      response.status(502).json({ error: "The staff account could not be confirmed. Check the user list before retrying." });
      return;
    }

    const { error: profileError } = await admin
      .from("profiles")
      .update({
        display_name: displayName,
        role,
        department_id: departmentId ?? null,
        is_active: true,
      })
      .eq("id", createdAccount.user.id);
    if (profileError) {
      console.error("Created staff account, but could not save the user's workspace role.", profileError);
      response.status(502).json({ error: "The staff account was created, but its workspace role could not be saved. Contact your administrator before retrying." });
      return;
    }

    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to manage staff accounts." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "user.created",
      targetType: "user",
      targetId: createdAccount.user.id,
      targetLabel: displayName,
      details: { email, role, departmentId: departmentId ?? null },
    });
    response.status(201).json({ message: "Staff account created. Share the initial password with them securely." });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize staff account creation.");
  }
});

router.post("/users/:userId/password-reset", requireSuperAdmin, async (request, response) => {
  const { userId } = request.params;
  if (typeof userId !== "string" || !uuidPattern.test(userId)) {
    response.status(400).json({ error: "Choose a valid staff account." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id, display_name, role")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) {
      sendAdminError(response, profileError, "Could not verify the staff account.");
      return;
    }
    if (!profile) {
      response.status(404).json({ error: "That staff account could not be found." });
      return;
    }
    if (profile.role === "super_admin") {
      response.status(403).json({ error: "Administrator credentials cannot be reset from staff management." });
      return;
    }
    const { data: authUser, error: authError } = await admin.auth.admin.getUserById(userId);
    if (authError) {
      sendAdminError(response, authError, "Could not load the staff email address.");
      return;
    }
    if (!authUser.user.email) {
      response.status(409).json({ error: "This staff account has no email address for a password reset." });
      return;
    }
    const { error: resetError } = await admin.auth.resetPasswordForEmail(authUser.user.email, {
      redirectTo: frontendRedirect(request, "?password_reset=1"),
    });
    if (resetError) {
      sendAdminError(response, resetError, "Could not send the staff password reset email.");
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to manage staff accounts." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "user.password_reset_requested",
      targetType: "user",
      targetId: profile.id,
      targetLabel: profile.display_name ?? authUser.user.email,
      details: { email: authUser.user.email },
    });
    response.status(200).json({ message: "A secure password reset link was emailed to the staff member." });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize the staff password reset.");
  }
});

router.patch("/users/:userId", requireSuperAdmin, async (request, response) => {
  const { userId } = request.params;
  if (typeof userId !== "string" || !uuidPattern.test(userId)) {
    response.status(400).json({ error: "Choose a valid user account." });
    return;
  }
  if (userId === primaryAdminId) {
    response.status(403).json({ error: "The primary super-admin account is protected from role changes here." });
    return;
  }
  if (!isRecord(request.body)) {
    response.status(400).json({ error: "Choose the account changes to save." });
    return;
  }

  const updates: { role?: Exclude<(typeof appRoles)[number], "super_admin">; is_active?: boolean; department_id?: string | null } = {};
  if ("role" in request.body) {
    if (typeof request.body.role !== "string" || !isAppRole(request.body.role) || request.body.role === "super_admin") {
      response.status(400).json({ error: "Choose a valid staff role. The primary super-admin role is protected." });
      return;
    }
    updates.role = request.body.role;
  }
  if ("isActive" in request.body) {
    if (typeof request.body.isActive !== "boolean") {
      response.status(400).json({ error: "Choose whether this account should be active." });
      return;
    }
    updates.is_active = request.body.isActive;
  }
  if ("departmentId" in request.body) {
    const departmentId = request.body.departmentId;
    if (departmentId !== null && (typeof departmentId !== "string" || !uuidPattern.test(departmentId))) {
      response.status(400).json({ error: "Choose a valid department." });
      return;
    }
    updates.department_id = departmentId;
  }
  if (Object.keys(updates).length === 0) {
    response.status(400).json({ error: "No account changes were provided." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data: target, error: targetError } = await admin
      .from("profiles")
      .select("id, display_name, role, is_archived")
      .eq("id", userId)
      .maybeSingle();
    if (targetError) {
      sendAdminError(response, targetError, "Could not verify the user account.");
      return;
    }
    if (!target) {
      response.status(404).json({ error: "That user account could not be found." });
      return;
    }
    if (target.role === "super_admin") {
      response.status(403).json({ error: "Administrator accounts are managed separately from staff." });
      return;
    }
    if (target.is_archived && request.body.isActive === true) {
      response.status(409).json({ error: "Restore this staff account before enabling access." });
      return;
    }
    if (updates.department_id) {
      const { data: department, error } = await admin
        .from("departments")
        .select("id")
        .eq("id", updates.department_id)
        .maybeSingle();
      if (error) {
        sendAdminError(response, error, "Could not verify the selected department.");
        return;
      }
      if (!department) {
        response.status(400).json({ error: "The selected department no longer exists." });
        return;
      }
    }

    const { data, error } = await admin
      .from("profiles")
      .update(updates)
      .eq("id", userId)
      .select("id, display_name, role, is_active, is_archived, department_id")
      .maybeSingle();
    if (error) {
      sendAdminError(response, error, "Could not update the user account.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That user account could not be found." });
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to update user accounts." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "user.updated",
      targetType: "user",
      targetId: data.id,
      targetLabel: data.display_name ?? data.id,
      details: {
        role: data.role,
        isActive: data.is_active,
        isArchived: data.is_archived,
        departmentId: data.department_id,
      },
    });
    response.status(200).json({ user: data });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize user management.");
  }
});

router.post("/users/:userId/archive", requireSuperAdmin, async (request, response) => {
  const { userId } = request.params;
  if (typeof userId !== "string" || !uuidPattern.test(userId) || userId === primaryAdminId) {
    response.status(400).json({ error: "Choose a valid staff account to archive." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("profiles")
      .update({ is_archived: true, is_active: false, updated_at: new Date().toISOString() })
      .eq("id", userId)
      .neq("role", "super_admin")
      .select("id, display_name")
      .maybeSingle();
    if (error) {
      sendAdminError(response, error, "Could not archive the staff account.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That staff account could not be found." });
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to archive staff accounts." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "user.archived",
      targetType: "user",
      targetId: data.id,
      targetLabel: data.display_name ?? data.id,
    });
    response.status(200).json({ message: "Staff account archived and access disabled." });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not archive the staff account.");
  }
});

router.post("/users/:userId/restore", requireSuperAdmin, async (request, response) => {
  const { userId } = request.params;
  if (typeof userId !== "string" || !uuidPattern.test(userId) || userId === primaryAdminId) {
    response.status(400).json({ error: "Choose a valid staff account to restore." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("profiles")
      .update({ is_archived: false, is_active: true, updated_at: new Date().toISOString() })
      .eq("id", userId)
      .neq("role", "super_admin")
      .select("id, display_name")
      .maybeSingle();
    if (error) {
      sendAdminError(response, error, "Could not restore the staff account.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That staff account could not be found." });
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to restore staff accounts." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "user.restored",
      targetType: "user",
      targetId: data.id,
      targetLabel: data.display_name ?? data.id,
    });
    response.status(200).json({ message: "Staff account restored and access enabled." });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not restore the staff account.");
  }
});

router.post("/users/:userId/lock-pin-reset", requireSuperAdmin, async (request, response) => {
  const { userId } = request.params;
  if (typeof userId !== "string" || !uuidPattern.test(userId) || userId === primaryAdminId) {
    response.status(400).json({ error: "Choose a valid staff account." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("profiles")
      .update({
        lock_pin_hash: null,
        lock_pin_failed_attempts: 0,
        lock_pin_locked_until: null,
      })
      .eq("id", userId)
      .neq("role", "super_admin")
      .select("id, display_name")
      .maybeSingle();
    if (error) {
      sendAdminError(response, error, "Could not reset the staff lock PIN.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That staff account could not be found." });
      return;
    }
    const actor = request.flexbarUser;
    if (!actor) {
      response.status(401).json({ error: "Please sign in to reset staff PINs." });
      return;
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "user.lock_pin_reset",
      targetType: "user",
      targetId: data.id,
      targetLabel: data.display_name ?? data.id,
    });
    response.status(200).json({ message: "Lock PIN cleared. The staff member will be prompted to create a new PIN." });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not reset the staff lock PIN.");
  }
});

router.delete("/users/:userId", requireSuperAdmin, async (request, response) => {
  const { userId } = request.params;
  if (typeof userId !== "string" || !uuidPattern.test(userId) || userId === primaryAdminId) {
    response.status(400).json({ error: "Choose a valid archived staff account to delete." });
    return;
  }
  const actor = request.flexbarUser;
  if (!actor) {
    response.status(401).json({ error: "Please sign in to delete staff accounts." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id, display_name, role, is_archived, avatar_path")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) {
      sendAdminError(response, profileError, "Could not verify the staff account.");
      return;
    }
    if (!profile || profile.role === "super_admin") {
      response.status(404).json({ error: "That staff account could not be found." });
      return;
    }
    if (!profile.is_archived) {
      response.status(409).json({ error: "Archive the staff account before permanently deleting it." });
      return;
    }
    const { data: authUser, error: authError } = await admin.auth.admin.getUserById(userId);
    if (authError) {
      sendAdminError(response, authError, "Could not load the staff account details.");
      return;
    }
    const { error: historyError } = await admin
      .from("attendance_records")
      .update({
        staff_name_snapshot: profile.display_name ?? authUser.user.email ?? "Former staff member",
        staff_email_snapshot: authUser.user.email,
      })
      .eq("user_id", userId);
    if (historyError) {
      sendAdminError(response, historyError, "Could not preserve the staff attendance history.");
      return;
    }
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError) {
      sendAdminError(response, deleteError, "Could not delete the archived staff account.");
      return;
    }
    let photoCleanupFailed = false;
    if (profile.avatar_path) {
      const { error: photoError } = await admin.storage.from("profile-photos").remove([profile.avatar_path]);
      if (photoError) {
        console.error("Deleted archived staff account, but could not remove its profile photo.", photoError);
        photoCleanupFailed = true;
      }
    }
    await recordAdminActivity(admin, {
      actorId: actor.id,
      actorName: actor.displayName ?? actor.email ?? "Super Admin",
      actorEmail: actor.email,
      action: "user.deleted",
      targetType: "user",
      targetId: profile.id,
      targetLabel: profile.display_name ?? authUser.user.email ?? profile.id,
      details: { email: authUser.user.email, attendanceHistoryRetained: true },
    });
    if (photoCleanupFailed) {
      response.status(502).json({ error: "The account was deleted and attendance was retained, but its profile photo could not be removed." });
      return;
    }
    response.status(200).json({ message: "Staff login and profile deleted. Attendance history was retained." });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not delete the archived staff account.");
  }
});

export { router as adminRouter };
