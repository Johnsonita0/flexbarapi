import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";
import { getCallPushConfig } from "../services/callPush.js";

const router = Router();
const base64UrlPattern = /^[A-Za-z0-9_-]{20,200}$/;

function sendPushError(response: Response, error: unknown, context: string) {
  console.error(context, error);
  response.status(500).json({ error: "We couldn't update call notifications. Please try again." });
}

function getUser(request: Request, response: Response) {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to manage call notifications." });
    return null;
  }
  return user;
}

function isSupportedPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const endpoint = new URL(value);
    const host = endpoint.hostname.toLowerCase();
    return endpoint.protocol === "https:"
      && (host === "fcm.googleapis.com"
        || host === "web.push.apple.com"
        || host === "updates.push.services.mozilla.com"
        || host === "push.services.mozilla.com"
        || host.endsWith(".push.services.mozilla.com")
        || (host.endsWith(".notify.windows.com") && /^wns\d+-/.test(host)));
  } catch {
    return false;
  }
}

router.use(requireUser);

router.get("/config", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  try {
    const config = getCallPushConfig();
    const admin = createSupabaseAdminClient();
    const { data: subscription, error } = await admin.from("call_push_subscriptions")
      .select("endpoint")
      .eq("user_id", user.id)
      .eq("session_id", user.sessionId)
      .limit(1)
      .maybeSingle();
    if (error) {
      sendPushError(response, error, "Could not check call notification registration.");
      return;
    }
    response.status(200).json({ ...config, subscribed: Boolean(subscription) });
  } catch (error: unknown) {
    sendPushError(response, error, "Could not load call notification settings.");
  }
});

router.post("/subscription", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const endpoint: unknown = request.body?.endpoint;
  const p256dh: unknown = request.body?.keys?.p256dh;
  const auth: unknown = request.body?.keys?.auth;
  if (
    !isSupportedPushEndpoint(endpoint)
    || typeof p256dh !== "string" || !base64UrlPattern.test(p256dh)
    || typeof auth !== "string" || !base64UrlPattern.test(auth)
  ) {
    response.status(400).json({ error: "The browser provided an invalid push subscription." });
    return;
  }
  try {
    if (!getCallPushConfig().enabled) {
      response.status(503).json({ error: "Call notifications are not configured yet. Please contact your administrator." });
      return;
    }
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from("call_push_subscriptions").upsert({
      user_id: user.id,
      session_id: user.sessionId,
      company_id: user.companyId,
      endpoint,
      p256dh,
      auth,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,endpoint" });
    if (error) {
      sendPushError(response, error, "Could not save call notification subscription.");
      return;
    }
    response.status(200).json({ subscribed: true });
  } catch (error: unknown) {
    sendPushError(response, error, "Could not enable call notifications.");
  }
});

router.delete("/subscription", async (request, response) => {
  const user = getUser(request, response);
  if (!user) return;
  const endpoint: unknown = request.body?.endpoint;
  if (endpoint !== undefined && !isSupportedPushEndpoint(endpoint)) {
    response.status(400).json({ error: "Choose a valid push subscription to remove." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { error } = isSupportedPushEndpoint(endpoint)
      ? await admin.from("call_push_subscriptions").delete()
        .eq("user_id", user.id).eq("session_id", user.sessionId).eq("endpoint", endpoint)
      : await admin.from("call_push_subscriptions").delete()
        .eq("user_id", user.id).eq("session_id", user.sessionId);
    if (error) {
      sendPushError(response, error, "Could not remove call notification subscription.");
      return;
    }
    response.status(200).json({ subscribed: false });
  } catch (error: unknown) {
    sendPushError(response, error, "Could not disable call notifications.");
  }
});

export { router as callPushRouter };
