import type { SupabaseClient } from "@supabase/supabase-js";

export class AdminActivityWriteError extends Error {
  constructor() {
    super("Administrator action completed but its audit event could not be saved.");
    this.name = "AdminActivityWriteError";
  }
}

export interface AdminActivityEntry {
  actorId: string;
  actorName: string;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  targetLabel: string;
  details?: Record<string, unknown>;
}

export async function recordAdminActivity(
  admin: SupabaseClient,
  entry: AdminActivityEntry,
) {
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", entry.actorId)
    .single();
  if (profileError) {
    console.error("Could not determine the company for an administrator activity event.", profileError);
    throw new AdminActivityWriteError();
  }
  const { error } = await admin.from("admin_activity_logs").insert({
    company_id: profile.company_id,
    actor_id: entry.actorId,
    actor_name: entry.actorName,
    actor_email: entry.actorEmail,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId ?? null,
    target_label: entry.targetLabel,
    details: entry.details ?? {},
  });
  if (error) {
    console.error("Could not record a super-admin activity event.", error);
    throw new AdminActivityWriteError();
  }
}
