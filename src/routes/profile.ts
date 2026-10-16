import { Router } from "express";
import type { Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();
const avatarPathPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/i;

function sendProfileError(response: Response, error: unknown) {
  console.error("Could not update the signed-in user's profile.", error);
  if (error instanceof Error && error.message.includes("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY")) {
    response.status(503).json({ error: "Profile services are not configured yet. Please contact the system administrator." });
    return;
  }
  response.status(500).json({ error: "We couldn't save your profile. Please try again." });
}

router.use(requireUser);

router.patch("/", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to update your profile." });
    return;
  }
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    response.status(400).json({ error: "Choose the profile details to update." });
    return;
  }

  const body = request.body as Record<string, unknown>;
  const updates: { display_name?: string; avatar_path?: string | null; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if ("displayName" in body) {
    if (typeof body.displayName !== "string") {
      response.status(400).json({ error: "Enter a valid display name." });
      return;
    }
    const displayName = body.displayName.trim();
    if (displayName.length < 2 || displayName.length > 100) {
      response.status(400).json({ error: "Your display name must be between 2 and 100 characters." });
      return;
    }
    updates.display_name = displayName;
  }
  if ("avatarPath" in body) {
    if (body.avatarPath !== null && (typeof body.avatarPath !== "string" || !avatarPathPattern.test(body.avatarPath) || !body.avatarPath.startsWith(`${user.id}/`))) {
      response.status(400).json({ error: "Choose a valid profile photo." });
      return;
    }
    updates.avatar_path = body.avatarPath;
  }
  if (Object.keys(updates).length === 1) {
    response.status(400).json({ error: "No profile changes were provided." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
      .select("display_name, avatar_path")
      .single();
    if (error) {
      sendProfileError(response, error);
      return;
    }
    response.status(200).json({
      displayName: data.display_name,
      avatarPath: data.avatar_path,
      message: "Profile updated.",
    });
  } catch (error: unknown) {
    sendProfileError(response, error);
  }
});

router.post("/lock-pin", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to set your lock PIN." });
    return;
  }
  if (user.role === "super_admin") {
    response.status(403).json({ error: "The administrator account does not use the staff lock PIN." });
    return;
  }
  const pin = request.body?.pin;
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    response.status(400).json({ error: "Your lock PIN must contain exactly four digits." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.rpc("set_staff_lock_pin", {
      p_user_id: user.id,
      p_pin: pin,
    });
    if (error) {
      sendProfileError(response, error);
      return;
    }
    response.status(200).json({ message: "Your lock PIN has been set." });
  } catch (error: unknown) {
    sendProfileError(response, error);
  }
});

router.post("/lock-pin/verify", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to unlock your workspace." });
    return;
  }
  const pin = request.body?.pin;
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    response.status(400).json({ error: "Enter your four-digit lock PIN." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("verify_staff_lock_pin", {
      p_user_id: user.id,
      p_pin: pin,
    });
    if (error) {
      sendProfileError(response, error);
      return;
    }
    if (data === "verified") {
      response.status(200).json({ verified: true });
      return;
    }
    if (data === "unconfigured") {
      response.status(409).json({ error: "Your lock PIN needs to be set up again.", setupRequired: true });
      return;
    }
    if (data === "locked") {
      response.status(429).json({ error: "Too many incorrect PIN attempts. Try again in 15 minutes or contact your administrator." });
      return;
    }
    response.status(401).json({ error: "That PIN is not correct." });
  } catch (error: unknown) {
    sendProfileError(response, error);
  }
});

export { router as profileRouter };
