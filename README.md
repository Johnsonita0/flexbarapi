# Flex Bar API

Node.js, Express, and TypeScript API, designed for an independent Vercel deployment.

## Local setup

1. Copy `.env.example` to `.env` and configure `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY`. The Flex Bar Supabase project URL is already set. Keep all real secrets out of Git.
2. Apply the single SQL setup file `supabase/migrations/0001_profiles.sql` to the Supabase project. It promotes the supplied Supabase Auth UID to the active `super_admin` and disables workspace access for every other account until an administrator approves it.
3. From this folder, run `npm install`, then `npm run dev`.
4. Check `http://localhost:3000/api/v1/health`.

`GET /api/v1/me` requires a valid email/password sign-in session and reads the signed-in user's profile under row-level security. The API returns the role stored in the database; a role is never accepted from the browser. Newly created accounts are inactive by default. Create/invite staff accounts in the trusted Supabase Auth dashboard, then activate them and assign their least-privilege role through the Supabase SQL editor. Disable public sign-ups in the Supabase Auth settings; the app itself has no sign-up flow. The admin UID is an identifier, not a password—keep the admin account protected with a strong, unique password and never share it.

Cloudflare R2 is configured through server-only environment variables. The R2 client helper is ready for later file features; credentials are never sent to the frontend.

## Vercel

Create a Vercel project connected to the backend Git repository and set its Root Directory to `backend`. Configure `SUPABASE_URL`, either `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY`, `FRONTEND_ORIGINS`, and the R2 variables in Vercel project settings. Do not add secret values to `.env.example`.

Apply the single SQL setup file to the intended Supabase environment before enabling sign-in. Create/invite staff accounts through Supabase Auth; new profiles default to the least-privileged `staff` role and inactive access. Approve staff by activating their profile and assigning roles through a trusted administrative process, not client-side metadata. Disable public sign-ups in Supabase Auth settings.
