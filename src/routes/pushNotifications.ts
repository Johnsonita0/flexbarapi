import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";
import { sendWorkspaceNotificationPush } from "../services/callPush.js";

const router = Router();

function isNotificationRecord(value: unknown): value is {
  id: string;
  user_id: string;
  company_id: string;
  type: string;
  title: string;
  detail: string;
} {
  if (typeof value !== "object" || value === null) return false;
  return ["id", "user_id", "company_id", "type", "title", "detail"]
    .every((key) => typeof Reflect.get(value, key) === "string");
}

function hasValidWebhookSecret(request: Request) {
  const configuredSecret = process.env.PUSH_WEBHOOK_SECRET;
  const authorization = request.header("authorization");
  if (!configuredSecret || !authorization?.startsWith("Bearer ")) return false;
  const expected = Buffer.from(configuredSecret);
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

router.post("/webhook", async (request, response) => {
  if (!hasValidWebhookSecret(request)) {
    response.status(401).json({ error: "The notification webhook is not authorized." });
    return;
  }
  if (request.body?.type !== "INSERT" || request.body?.table !== "notifications" || request.body?.schema !== "public") {
    response.status(400).json({ error: "Expected a public notification insert event." });
    return;
  }
  const record: unknown = request.body.record;
  if (!isNotificationRecord(record)) {
    response.status(400).json({ error: "The notification event is incomplete." });
    return;
  }

  try {
    await sendWorkspaceNotificationPush(createSupabaseAdminClient(), {
      id: record.id,
      userId: record.user_id,
      companyId: record.company_id,
      type: record.type,
      title: record.title,
      detail: record.detail,
    });
    response.status(202).json({ accepted: true });
  } catch (error: unknown) {
    console.error("Could not deliver a workspace notification push.", error);
    response.status(500).json({ error: "The notification push could not be delivered." });
  }
});

export { router as pushNotificationsRouter };