import { createECDH } from "node:crypto";
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
  endpoint: string;
  p256dh: string;
  auth: string;
}

function getVapidKeys() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey) throw new Error("Both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured.");
  if (
    !/^[A-Za-z0-9_-]{87}$/.test(publicKey) ||
    !/^[A-Za-z0-9_-]{43}$/.test(privateKey)
  ) {
    throw new Error("The configured VAPID keys have an invalid format.");
  }
  const publicBytes = Buffer.from(publicKey, "base64url");
  const privateBytes = Buffer.from(privateKey, "base64url");
  if (
    publicBytes.length !== 65 ||
    publicBytes[0] !== 4 ||
    publicBytes.toString("base64url") !== publicKey ||
    privateBytes.length !== 32 ||
    privateBytes.toString("base64url") !== privateKey
  ) {
    throw new Error("The configured VAPID keys have an invalid encoding.");
  }
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateBytes);
  if (!ecdh.getPublicKey(undefined, "uncompressed").equals(publicBytes)) {
    throw new Error("The configured VAPID public and private keys do not match.");
  }
  return { publicKey, privateKey };
}

export function getCallPushConfig() {
  try {
    const keys = getVapidKeys();
    return { enabled: Boolean(keys), publicKey: keys?.publicKey ?? null, configurationError: null };
  } catch (error: unknown) {
    console.error("Call notification VAPID configuration is invalid.", error);
    return {
      enabled: false,
      publicKey: null,
      configurationError: "Call alerts are misconfigured. Please contact your administrator.",
    };
  }
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
    .select("user_id, endpoint, p256dh, auth")
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
    .select("user_id, endpoint, p256dh, auth")
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
