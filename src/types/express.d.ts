import type { AppRole } from "../auth/roles.js";

declare global {
  namespace Express {
    interface Request {
      flexbarUser?: {
        id: string;
        sessionId: string;
        companyId: string;
        email: string | null;
        displayName: string | null;
        avatarPath: string | null;
        hasLockPin: boolean;
        isArchived: boolean;
        departmentId: string | null;
        salesEnabled: boolean;
        role: AppRole;
        companyName: string;
        businessType: string;
      };
    }
  }
}

export {};
