import type { AppRole } from "../auth/roles.js";

declare global {
  namespace Express {
    interface Request {
      flexbarUser?: {
        id: string;
        email: string | null;
        displayName: string | null;
        role: AppRole;
      };
    }
  }
}

export {};
