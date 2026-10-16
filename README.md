# Flex Bar API

Node.js, Express, and TypeScript API, designed for an independent Vercel deployment.

## Local setup

1. Copy `.env.example` to `.env` and configure `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY`, plus the secret `SUPABASE_SERVICE_ROLE_KEY`. The Flex Bar Supabase project URL is already set. Keep all real secrets out of Git and never expose the service-role key to the frontend.
2. Apply or re-run the single SQL setup file `supabase/migrations/0001_profiles.sql` in the Supabase SQL editor. It promotes the supplied Supabase Auth UID to the active `super_admin`, disables workspace access for other accounts until an administrator approves them, adds department assignments, and seeds the starter Management, Bar, Kitchen, Restaurant Floor, Cashier, Inventory & Store, and Cleaning & Maintenance departments.
3. Copy `.env.example` to `.env`, fill the local values, and run `npm run dev` from this folder. The dev/start scripts load `.env`.
4. Check `http://localhost:3000/api/v1/health`.

`GET /api/v1/me` requires a valid email/password sign-in session and reads the signed-in user's profile under row-level security. The API returns the role stored in the database; a role is never accepted from the browser. The super-admin-only `/api/v1/admin` routes list and invite users, assign app roles, activate/deactivate staff, and create departments. Invitations send a Supabase email link so users set their own passwords. The invite form includes seven bar/restaurant starter role-and-department assignments; enter each real staff member's name and email to send their invitation. No fake staff accounts are created. New accounts otherwise remain inactive. The protected primary admin cannot be disabled or demoted through the user-management routes. The `/api/v1/attendance` routes save the business geofence, let staff and management roles clock in/out from inside it, and show the admin attendance history; the super-admin is explicitly blocked from clocking in. Disable public sign-ups in Supabase Auth settings and add the local/Vercel app URLs to Supabase Auth's allowed redirect URLs; the app itself has no public sign-up flow. The admin UID is an identifier, not a password—keep the admin account protected with a strong, unique password and never share it.

Cloudflare R2 is configured through server-only environment variables. The R2 client helper is ready for later file features; credentials are never sent to the frontend.

## Vercel

Create a Vercel project connected to the backend Git repository and leave its Root Directory at the repository root (`./`). This is a separate repository, so there is no nested `backend` directory in the deployment. `vercel.json` builds the Express app as a Node function and routes requests to it. Verify `https://<your-api-domain>/api/v1/health` returns `200` after deployment. Configure `SUPABASE_URL`, either `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY`, the server-only `SUPABASE_SERVICE_ROLE_KEY`, `FRONTEND_URL`, `FRONTEND_ORIGINS`, and the R2 variables in Vercel project settings. The service-role secret must only be added to the backend deployment, never to frontend `VITE_*` variables. Do not add secret values to `.env.example`.

Apply the single SQL setup file to the intended Supabase environment before enabling sign-in. Create/invite staff accounts through Supabase Auth; new profiles default to the least-privileged `staff` role and inactive access. Approve staff by activating their profile and assigning roles through a trusted administrative process, not client-side metadata. Disable public sign-ups in Supabase Auth settings.
