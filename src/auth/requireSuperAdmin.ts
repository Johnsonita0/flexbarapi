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
  if (request.flexbarUser.role !== "super_admin") {
    response.status(403).json({ error: "Only the Flex Bar system administrator can manage these settings." });
    return;
  }
  next();
}
