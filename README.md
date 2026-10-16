# Flex Bar API

Node.js, Express, and TypeScript API, designed for an independent Vercel deployment.

## Local setup

1. Copy `.env.example` to `.env` and fill in the Supabase anon/publishable key. The Flex Bar Supabase project URL is already set. Keep all real secrets out of Git.
2. Apply `supabase/migrations/0001_profiles.sql` to the Supabase project.
3. From this folder, run `npm install`, then `npm run dev`.
4. Check `http://localhost:3000/api/v1/health`.

`GET /api/v1/me` requires a Supabase access token and reads the signed-in user's profile under row-level security. The API returns the role stored in the database; a role is never accepted from the browser.

Cloudflare R2 is configured through server-only environment variables. The R2 client helper is ready for later file features; credentials are never sent to the frontend.

## Vercel

Create a Vercel project connected to the backend Git repository and set its Root Directory to `backend`. Configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FRONTEND_ORIGINS`, and the R2 variables in Vercel project settings. Do not add secret values to `.env.example`.

Apply SQL migrations to the intended Supabase environment before enabling sign-in. Create/invite staff accounts through Supabase Auth; profiles default to the least-privileged `staff` role. Assign elevated roles through a trusted administrative process, not client-side metadata.
