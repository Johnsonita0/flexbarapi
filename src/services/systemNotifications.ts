import type { Response } from "express";
import { createSupabaseAdminClient } from "./supabaseAdmin.js";

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === "string"
      ? error
      : JSON.stringify(error) ?? String(error);
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:service[_-]?role|publishable|anon|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^"' \s,;}]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@");
}

export async function notifyAdminsOfSystemError(
  response: Response,
  error: unknown,
  context: string,
) {
  const companyId: unknown = response.locals.flexbarCompanyId;
  if (typeof companyId !== "string") return;

  try {
    const admin = createSupabaseAdminClient();
    const { data: administrators, error: administratorsError } = await admin
      .from("profiles")
      .select("id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("is_archived", false)
      .in("role", ["super_admin", "management_admin"]);
    if (administratorsError) throw administratorsError;
    if (!administrators?.length) return;

    const detail = `${context}\n${safeErrorMessage(error)}`;
    const { error: notificationError } = await admin.from("notifications").insert(
      administrators.map(({ id }) => ({
        user_id: id,
        company_id: companyId,
        type: "system_error",
        title: "System error needs review",
        detail,
        sale_id: null,
      })),
    );
    if (notificationError) throw notificationError;
  } catch (notificationError: unknown) {
    console.error("Could not save a system error to the administrator inbox.", notificationError);
  }
}
