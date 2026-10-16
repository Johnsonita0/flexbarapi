import { createClient } from "@supabase/supabase-js";
import { getRequiredEnv } from "../config/env.js";

export function createSupabaseAdminClient() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
