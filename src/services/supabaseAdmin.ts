import { createClient } from "@supabase/supabase-js";
import { getRequiredEnv } from "../config/env.js";
import { getCompanyContext } from "./companyContext.js";

function companyScopedFetch(companyId: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/rest/v1/") || url.pathname.startsWith("/rest/v1/rpc/")) {
      return fetch(request);
    }
    url.searchParams.set("company_id", `eq.${companyId}`);
    return fetch(new Request(url, request));
  };
}

export function createSupabaseAdminClient() {
  const companyId = getCompanyContext();
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      ...(companyId ? { global: { fetch: companyScopedFetch(companyId) } } : {}),
    },
  );
}
