import * as webpush from "web-push";
import type { createSupabaseAdminClient } from "./supabaseAdmin.js";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

interface IncomingCallNotification {
  callId: string;
  callerName: string;
  mediaMode: "audio" | "video";
}

interface WorkspaceNotification {
  id: string;
  userId: string;
  companyId: string;
  type: string;
  title: string;
  detail: string;
}

interface PushSubscription {
  user_id: string;
  session_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function getVapidKeys() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey) throw new Error("Both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured.");
  return { publicKey, privateKey };
}

export function getCallPushConfig() {
  const keys = getVapidKeys();
  return { enabled: Boolean(keys), publicKey: keys?.publicKey ?? null };
}

function configureVapid() {
  const keys = getVapidKeys();
  if (!keys) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? process.env.FRONTEND_URL ?? "https://flaxbarmanagement.vercel.app",
    keys.publicKey,
    keys.privateKey,
  );
  return true;
}

function getStatusCode(error: unknown) {
  return typeof error === "object" && error !== null && "statusCode" in error
    && typeof error.statusCode === "number"
    ? error.statusCode
    : null;
}

async function removeSubscription(admin: AdminClient, userId: string, endpoint: string) {
  const { error } = await admin.from("call_push_subscriptions")
    .delete()
    .eq("user_id", userId)
    .eq("endpoint", endpoint);
  if (error) console.error("Could not remove an expired call push subscription.", error);
}

async function sendToSubscriptions(
  admin: AdminClient,
  subscriptions: PushSubscription[],
  payload: Record<string, string>,
) {
  await Promise.all(subscriptions.map(async (subscription) => {
    const { data: isActiveSession, error: sessionError } = await admin.rpc("is_active_account_device_session", {
      p_user_id: subscription.user_id,
      p_session_id: subscription.session_id,
    });
    if (sessionError) {
      console.error("Could not verify the device session for a push subscription.", sessionError);
      return;
    }
    if (isActiveSession !== true) {
      await removeSubscription(admin, subscription.user_id, subscription.endpoint);
      return;
    }

    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        { TTL: 60, urgency: "high" },
      );
    } catch (pushError: unknown) {
      const statusCode = getStatusCode(pushError);
      if (statusCode === 404 || statusCode === 410) {
        await removeSubscription(admin, subscription.user_id, subscription.endpoint);
        return;
      }
      console.error("Could not deliver a web push notification.", {
        name: pushError instanceof Error ? pushError.name : "UnknownError",
        statusCode,
      });
    }
  }));
}

export async function sendIncomingCallPush(
  admin: AdminClient,
  companyId: string,
  participantIds: string[],
  notification: IncomingCallNotification,
) {
  if (!participantIds.length) return;
  if (!configureVapid()) {
    return;
  }

  const { data: subscriptions, error } = await admin.from("call_push_subscriptions")
    .select("user_id, session_id, endpoint, p256dh, auth")
    .eq("company_id", companyId)
    .in("user_id", participantIds);
  if (error) {
    console.error("Could not load call push subscriptions.", error);
    return;
  }

  await sendToSubscriptions(admin, subscriptions ?? [], {
    type: "incoming-call",
    title: `${notification.callerName} is calling`,
    body: notification.mediaMode === "video" ? "Incoming video call" : "Incoming voice call",
    callId: notification.callId,
    mediaMode: notification.mediaMode,
    url: "/",
  });
}

export async function sendWorkspaceNotificationPush(admin: AdminClient, notification: WorkspaceNotification) {
  if (!configureVapid()) return;
  const { data: subscriptions, error } = await admin.from("call_push_subscriptions")
    .select("user_id, session_id, endpoint, p256dh, auth")
    .eq("company_id", notification.companyId)
    .eq("user_id", notification.userId);
  if (error) {
    console.error("Could not load push subscriptions for a workspace notification.", error);
    return;
  }
  await sendToSubscriptions(admin, subscriptions ?? [], {
    type: "workspace-notification",
    title: notification.title,
    body: notification.detail,
    notificationId: notification.id,
    notificationType: notification.type,
    url: "/",
  });
}
