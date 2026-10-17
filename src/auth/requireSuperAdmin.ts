import type { NextFunction, Request, Response } from "express";

export function requireSuperAdmin(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  if (!request.flexbarUser) {
    response.status(401).json({ error: "Please sign in to continue." });
    return;
  }
  if (request.flexbarUser.role !== "super_admin" && request.flexbarUser.role !== "management_admin") {
    response.status(403).json({ error: "Only a company administrator can manage these settings." });
    return;
  }
  next();
}
