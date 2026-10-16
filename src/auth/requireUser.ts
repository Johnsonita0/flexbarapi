import { createClient } from "@supabase/supabase-js";
import type { NextFunction, Request, Response } from "express";
import { getRequiredEnv } from "../config/env.js";
import { isAppRole } from "./roles.js";

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

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("display_name, role, is_active")
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
  if (!profile.is_active) {
    response.status(403).json({ error: "Your account is not approved to access this workspace. Please contact your administrator." });
    return;
  }
  if (!isAppRole(profile.role)) {
    console.error("The authenticated user's profile contains an unsupported role.");
    response.status(500).json({ error: "Your account role is not configured correctly." });
    return;
  }

  request.flexbarUser = {
    id: user.id,
    email: user.email ?? null,
    displayName:
      typeof profile.display_name === "string" ? profile.display_name : null,
    role: profile.role,
  };
  next();
}
