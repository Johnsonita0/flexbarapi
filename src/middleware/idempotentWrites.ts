import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestFingerprint(request: Request) {
  return createHash("sha256")
    .update(`${request.method}\n${request.originalUrl}\n${JSON.stringify(request.body ?? null)}`)
    .digest("hex");
}

export async function idempotentWrites(request: Request, response: Response, next: NextFunction) {
  const key = request.header("idempotency-key");
  if (!key || !keyPattern.test(key) || ["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    next();
    return;
  }
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "A valid sign-in session is required." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const fingerprint = requestFingerprint(request);
    const existing = await admin
      .from("api_idempotency_keys")
      .select("request_hash, response_status, response_body")
      .eq("company_id", user.companyId)
      .eq("user_id", user.id)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (existing.error) throw existing.error;

    if (existing.data) {
      if (existing.data.request_hash !== fingerprint) {
        response.status(409).json({ code: "IDEMPOTENCY_KEY_REUSED", error: "This offline action key was already used for a different request." });
        return;
      }
      if (existing.data.response_status !== null) {
        response.status(existing.data.response_status).json(existing.data.response_body);
        return;
      }
      response.status(409).json({ code: "OFFLINE_OPERATION_IN_PROGRESS", error: "This action reached the server but its result could not be confirmed. Keep it for review." });
      return;
    }

    const { error: insertError } = await admin.from("api_idempotency_keys").insert({
      company_id: user.companyId,
      user_id: user.id,
      idempotency_key: key,
      request_hash: fingerprint,
    });
    if (insertError) {
      if (insertError.code === "23505") {
        response.status(409).json({ code: "OFFLINE_OPERATION_IN_PROGRESS", error: "This action is already being processed. Keep it for review." });
        return;
      }
      throw insertError;
    }

    const sendJson = response.json.bind(response);
    response.json = ((body: unknown) => {
      const status = response.statusCode;
      void admin
        .from("api_idempotency_keys")
        .update({ response_status: status, response_body: body })
        .eq("company_id", user.companyId)
        .eq("user_id", user.id)
        .eq("idempotency_key", key)
        .then(({ error }) => {
          if (error) {
            console.error("Could not save the idempotent API response; the offline action is held for review.", error);
          }
          sendJson(body);
        }, (error: unknown) => {
          console.error("Could not save the idempotent API response; the offline action is held for review.", error);
          sendJson(body);
        });
      return response;
    }) as Response["json"];
    next();
  } catch (error: unknown) {
    console.error("Could not prepare an idempotent API write.", error);
    response.status(503).json({ error: "We couldn't safely prepare this offline-capable action. Please retry when the connection is available." });
  }
}
