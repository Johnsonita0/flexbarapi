import { Router } from "express";
import type { Response } from "express";
import { requireSuperAdmin } from "../auth/requireSuperAdmin.js";
import { requireUser } from "../auth/requireUser.js";
import { appRoles, isAppRole } from "../auth/roles.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();
const primaryAdminId = "9668b2c5-428f-4d38-a29f-b5de8aa3d6b0";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendAdminError(response: Response, error: unknown, message: string) {
  console.error(message, error);
  if (error instanceof Error && error.message.includes("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY")) {
    response.status(503).json({ error: "Secure admin tools are not configured yet. Please contact the system administrator." });
    return;
  }
  response.status(500).json({ error: "We couldn't complete that request. Please try again or contact your administrator." });
}

router.use(requireUser);

router.get("/departments", async (_request, response) => {
  try {
    const admin = createSupabaseAdminClient();
    const [{ data, error }, { data: profiles, error: profileError }] = await Promise.all([
      admin
      .from("departments")
      .select("id, name, created_at")
      .order("name"),
      admin.from("profiles").select("department_id"),
    ]);
    if (error || profileError) {
      sendAdminError(response, error ?? profileError, "Could not load departments.");
      return;
    }
    const staffCounts = new Map<string, number>();
    for (const profile of profiles ?? []) {
      if (profile.department_id) {
        staffCounts.set(profile.department_id, (staffCounts.get(profile.department_id) ?? 0) + 1);
      }
    }
    response.status(200).json({
      departments: (data ?? []).map((department) => ({
        ...department,
        staffCount: staffCounts.get(department.id) ?? 0,
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
    response.status(201).json({ department: data });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize department creation.");
  }
});

router.get("/users", requireSuperAdmin, async (_request, response) => {
  try {
    const admin = createSupabaseAdminClient();
    const [{ data: profiles, error: profilesError }, { data: departments, error: departmentsError }] =
      await Promise.all([
        admin.from("profiles").select("id, display_name, role, is_active, department_id").order("created_at"),
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
      users: (profiles ?? []).map((profile) => ({
        id: profile.id,
        displayName: profile.display_name,
        email: emailById.get(profile.id) ?? null,
        role: profile.role,
        isActive: profile.is_active,
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
    typeof request.body.role !== "string"
  ) {
    response.status(400).json({ error: "Enter the new user’s name, email, and role." });
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

    const redirectTo = process.env.FRONTEND_URL ?? request.get("origin");
    const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { display_name: displayName },
      ...(redirectTo ? { redirectTo } : {}),
    });
    if (invitationError) {
      if (invitationError.message.toLowerCase().includes("already been registered")) {
        response.status(409).json({ error: "An account already exists for that email address." });
        return;
      }
      sendAdminError(response, invitationError, "Could not invite the new user.");
      return;
    }
    if (!invitation.user) {
      response.status(502).json({ error: "The invitation could not be confirmed. Check the user list before retrying." });
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
      .eq("id", invitation.user.id);
    if (profileError) {
      console.error("Invited user, but could not save the user's workspace role.", profileError);
      response.status(502).json({ error: "The invitation was sent, but the workspace role could not be saved. Contact your administrator before retrying." });
      return;
    }

    response.status(201).json({ message: "Invitation sent. The user can set their password from the email link." });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize user invitation.");
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
      .select("id, display_name, role, is_active, department_id")
      .maybeSingle();
    if (error) {
      sendAdminError(response, error, "Could not update the user account.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That user account could not be found." });
      return;
    }
    response.status(200).json({ user: data });
  } catch (error: unknown) {
    sendAdminError(response, error, "Could not initialize user management.");
  }
});

export { router as adminRouter };
