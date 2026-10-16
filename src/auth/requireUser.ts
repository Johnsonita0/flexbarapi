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

  const supabase = createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_ANON_KEY"),
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
    response.status(403).json({ error: "Your account does not have a Flex Bar profile." });
    return;
  }
  if (profileError) {
    console.error("Could not load the authenticated user's profile.", profileError);
    response.status(500).json({ error: "Could not load your account profile." });
    return;
  }
  if (!profile.is_active) {
    response.status(403).json({ error: "This Flex Bar account is inactive." });
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
