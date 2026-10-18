import { createClient } from "@supabase/supabase-js";
import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { getSessionIdFromToken } from "../auth/sessionId.js";
import { getRequiredEnv } from "../config/env.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();

async function authenticateSession(request: Request, response: Response) {
  const [scheme, token] = request.header("authorization")?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    response.status(401).json({ error: "A valid sign-in session is required." });
    return null;
  }

  const sessionId = getSessionIdFromToken(token);
  if (!sessionId) {
    response.status(401).json({ error: "Your sign-in session is invalid or expired." });
    return null;
  }

  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!supabaseKey) {
    response.status(503).json({ error: "Account sign-in protection is not configured." });
    return null;
  }

  const authClient = createClient(getRequiredEnv("SUPABASE_URL"), supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await authClient.auth.getUser(token);
  if (error || !user) {
    response.status(401).json({ error: "Your sign-in session is invalid or expired." });
    return null;
  }
  return { userId: user.id, sessionId };
}

router.post("/claim", async (request, response) => {
  try {
    const session = await authenticateSession(request, response);
    if (!session) return;
    const admin = createSupabaseAdminClient();
    const replaceExisting = request.body?.replaceExisting === true;
    const result = replaceExisting
      ? await admin.from("account_device_sessions").upsert({
        user_id: session.userId,
        session_id: session.sessionId,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: "user_id" })
      : await admin.rpc("claim_account_device_session", {
        p_user_id: session.userId,
        p_session_id: session.sessionId,
      });
    const error = result.error;
    if (error) {
      console.error("Could not claim the account's active device session.", error);
      response.status(500).json({ error: "We couldn't verify whether another device is using this account." });
      return;
    }
    if (!replaceExisting && result.data !== true) {
      response.status(409).json({
        code: "ACCOUNT_ALREADY_ACTIVE",
        error: "This account is already signed in on another device.",
      });
      return;
    }
    response.status(200).json({ ok: true });
  } catch (error: unknown) {
    console.error("Could not initialize account device-session protection.", error);
    response.status(500).json({ error: "We couldn't verify this device. Please try again." });
  }
});

router.post("/release", async (request, response) => {
  try {
    const session = await authenticateSession(request, response);
    if (!session) return;
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from("account_device_sessions")
      .delete()
      .eq("user_id", session.userId)
      .eq("session_id", session.sessionId);
    if (error) {
      console.error("Could not release the account's active device session.", error);
      response.status(500).json({ error: "We couldn't release this device's sign-in session." });
      return;
    }
    response.status(200).json({ ok: true });
  } catch (error: unknown) {
    console.error("Could not initialize account device-session release.", error);
    response.status(500).json({ error: "We couldn't release this device's sign-in session." });
  }
});

router.post("/heartbeat", requireUser, (_request, response) => {
  response.status(200).json({ ok: true });
});

export { router as accountSessionRouter };
