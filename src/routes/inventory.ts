import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();
const allowedRoles = new Set(["super_admin", "management_admin", "inventory_officer"]);
const imagePathPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/i;

function requireInventoryRole(request: Request, response: Response): boolean {
  if (!request.flexbarUser || !allowedRoles.has(request.flexbarUser.role)) {
    response.status(403).json({ error: "You don't have permission to manage inventory." });
    return false;
  }
  return true;
}

function sendInventoryError(response: Response, error: unknown, context: string) {
  console.error(context, error);
  if (error instanceof Error && error.message.includes("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY")) {
    response.status(503).json({ error: "Inventory services are not configured yet. Please contact the system administrator." });
    return;
  }
  response.status(500).json({ error: "We couldn't complete that inventory request. Please try again." });
}

router.use(requireUser);

router.get("/products", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("products")
      .select("id, name, category, stock_quantity, unit, reorder_level, image_path, created_at, updated_at")
      .order("name");
    if (error) {
      sendInventoryError(response, error, "Could not load inventory products.");
      return;
    }
    response.status(200).json({
      products: (data ?? []).map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        stock: product.stock_quantity,
        unit: product.unit,
        reorder: product.reorder_level,
        imagePath: product.image_path,
        createdAt: product.created_at,
        updatedAt: product.updated_at,
      })),
    });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize inventory products.");
  }
});

router.post("/products", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  const { name, category, stock, unit, reorder, imagePath } = request.body ?? {};
  if (
    typeof name !== "string" || name.trim().length < 2 || name.trim().length > 120 ||
    typeof category !== "string" || category.trim().length < 2 || category.trim().length > 80 ||
    !Number.isInteger(stock) || stock < 0 ||
    typeof unit !== "string" || unit.trim().length < 1 || unit.trim().length > 30 ||
    !Number.isInteger(reorder) || reorder < 0 ||
    (imagePath !== null && imagePath !== undefined &&
      (typeof imagePath !== "string" ||
       !imagePathPattern.test(imagePath) ||
       !imagePath.startsWith(`${request.flexbarUser?.id}/`)))
  ) {
    response.status(400).json({ error: "Enter a valid product name, category, stock quantity, unit, reorder level, and image." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("products")
      .insert({
        name: name.trim(),
        category: category.trim(),
        stock_quantity: stock,
        unit: unit.trim(),
        reorder_level: reorder,
        image_path: imagePath ?? null,
        created_by: request.flexbarUser?.id,
      })
      .select("id, name, category, stock_quantity, unit, reorder_level, image_path, created_at, updated_at")
      .single();
    if (error) {
      sendInventoryError(response, error, "Could not save an inventory product.");
      return;
    }
    response.status(201).json({
      product: {
        id: data.id,
        name: data.name,
        category: data.category,
        stock: data.stock_quantity,
        unit: data.unit,
        reorder: data.reorder_level,
        imagePath: data.image_path,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      },
    });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize inventory product creation.");
  }
});

export { router as inventoryRouter };
