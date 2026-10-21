import { createClient } from "@supabase/supabase-js";
import type { NextFunction, Request, Response } from "express";
import { getRequiredEnv } from "../config/env.js";
import { runWithCompany } from "../services/companyContext.js";
import { notifyAdminsOfSystemError } from "../services/systemNotifications.js";
import { getSessionIdFromToken } from "./sessionId.js";
import { isAppRole } from "./roles.js";
import { idempotentWrites } from "../middleware/idempotentWrites.js";

export async function requireUser(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const authorization = request.header("authorization");
  const [scheme, token] = authorization?.split(" ") ?? [];

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    response.status(401).json({ error: "A valid sign-in session is required." });
    return;
  }

  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!supabaseKey) {
    throw new Error("Missing required environment variable: SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY.");
  }

  const supabase = createClient(
    getRequiredEnv("SUPABASE_URL"),
    supabaseKey,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    },
  );

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    response.status(401).json({ error: "Your sign-in session is invalid or expired." });
    return;
  }

  const sessionId = getSessionIdFromToken(token);
  if (!sessionId) {
    response.status(401).json({ error: "Your sign-in session is invalid or expired." });
    return;
  }
  const { data: activeSession, error: activeSessionError } = await supabase.rpc("touch_account_device_session", {
    p_session_id: sessionId,
  });
  if (activeSessionError) {
    console.error("Could not verify the active device session.", activeSessionError);
    response.status(500).json({ error: "We couldn't verify this device's sign-in session." });
    return;
  }
  if (activeSession !== true) {
    response.status(401).json({
      code: "ACCOUNT_SESSION_NOT_REGISTERED",
      error: "This device's sign-in session is no longer registered. Please sign in again.",
    });
    return;
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("display_name, avatar_path, role, is_active, is_archived, lock_pin_hash, department_id, company_id")
    .eq("id", user.id)
    .single();

  if (profileError?.code === "PGRST116") {
    response.status(403).json({ error: "Your account is not ready to access the workspace. Please contact your administrator." });
    return;
  }
  if (profileError) {
    console.error("Could not load the authenticated user's profile.", profileError);
    response.status(500).json({ error: "We couldn't load your account details. Please try again or contact your administrator." });
    return;
  }
  if (!profile.is_active || profile.is_archived) {
    response.status(403).json({ error: "Your account is not approved to access this workspace. Please contact your administrator." });
    return;
  }
  if (!isAppRole(profile.role)) {
    console.error("The authenticated user's profile contains an unsupported role.");
    response.status(500).json({ error: "Your account role is not configured correctly." });
    return;
  }
  if (typeof profile.company_id !== "string") {
    console.error("The authenticated user's profile has no company workspace.");
    response.status(403).json({ error: "Your account is not assigned to a company workspace. Please contact your administrator." });
    return;
  }
  response.locals.flexbarCompanyId = profile.company_id;

  let salesEnabled = false;
  if (typeof profile.department_id === "string") {
    const { data: department, error: departmentError } = await supabase
      .from("departments")
      .select("sales_enabled")
      .eq("id", profile.department_id)
      .eq("company_id", profile.company_id)
      .maybeSingle();
    if (departmentError) {
      console.error("Could not load the authenticated user's department access.", departmentError);
      await notifyAdminsOfSystemError(response, departmentError, "Could not load the authenticated user's department access.");
      response.status(500).json({ error: "We couldn't load your department access. Please try again or contact your administrator." });
      return;
    }
    salesEnabled = department?.sales_enabled === true;
  }
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("name, business_type")
    .eq("id", profile.company_id)
    .single();
  if (companyError) {
    console.error("Could not load the authenticated user's company workspace.", companyError);
    await notifyAdminsOfSystemError(response, companyError, "Could not load the authenticated user's company workspace.");
    response.status(500).json({ error: "We couldn't load your company workspace. Please try again or contact your administrator." });
    return;
  }

  request.flexbarUser = {
    id: user.id,
    sessionId,
    companyId: profile.company_id,
    email: user.email ?? null,
    displayName:
      typeof profile.display_name === "string" ? profile.display_name : null,
    avatarPath:
      typeof profile.avatar_path === "string" ? profile.avatar_path : null,
    hasLockPin: typeof profile.lock_pin_hash === "string",
    isArchived: profile.is_archived,
    departmentId: typeof profile.department_id === "string" ? profile.department_id : null,
    salesEnabled,
    role: profile.role,
    companyName: company.name,
    businessType: company.business_type,
  };
  runWithCompany(profile.company_id, () => {
    void idempotentWrites(request, response, next);
  });
}
