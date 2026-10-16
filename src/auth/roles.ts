export const appRoles = [
  "super_admin",
  "management_admin",
  "department_supervisor",
  "inventory_officer",
  "cash_sales_officer",
  "staff",
] as const;

export type AppRole = (typeof appRoles)[number];

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && appRoles.some((role) => role === value);
}
