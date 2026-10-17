import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";

const router = Router();
const allowedRoles = new Set(["super_admin", "management_admin", "inventory_officer"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    const [{ data, error }, { data: departments, error: departmentError }] = await Promise.all([
      admin
      .from("products")
      .select("id, name, category, stock_quantity, unit, reorder_level, image_path, department_id, unit_price, created_at, updated_at")
      .order("name"),
      admin.from("departments").select("id, name, head_user_id"),
    ]);
    if (error || departmentError) {
      sendInventoryError(response, error ?? departmentError, "Could not load inventory products.");
      return;
    }
    const departmentById = new Map((departments ?? []).map((department) => [department.id, department.name]));
    response.status(200).json({
      products: (data ?? []).map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        stock: product.stock_quantity,
        unit: product.unit,
        reorder: product.reorder_level,
        imagePath: product.image_path,
        departmentId: product.department_id,
        departmentName: product.department_id ? departmentById.get(product.department_id) ?? null : null,
        price: Number(product.unit_price),
        createdAt: product.created_at,
        updatedAt: product.updated_at,
      })),
      departments: (departments ?? []).map((department) => ({ id: department.id, name: department.name, headUserId: department.head_user_id })),
    });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize inventory products.");
  }
});

router.post("/products", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  const { name, category, stock, unit, reorder, imagePath, departmentId, price } = request.body ?? {};
  if (
    typeof name !== "string" || name.trim().length < 2 || name.trim().length > 120 ||
    typeof category !== "string" || category.trim().length < 2 || category.trim().length > 80 ||
    !Number.isInteger(stock) || stock < 0 ||
    typeof unit !== "string" || unit.trim().length < 1 || unit.trim().length > 30 ||
    !Number.isInteger(reorder) || reorder < 0 ||
    (departmentId !== null && departmentId !== undefined && (typeof departmentId !== "string" || !uuidPattern.test(departmentId))) ||
    (stock > 0 && !departmentId) ||
    typeof price !== "number" || !Number.isFinite(price) || price < 0 ||
    (imagePath !== null && imagePath !== undefined &&
      (typeof imagePath !== "string" ||
       !imagePathPattern.test(imagePath) ||
       !imagePath.startsWith(`${request.flexbarUser?.id}/`)))
  ) {
    response.status(400).json({ error: "Enter a valid product name, category, stock quantity, unit, reorder level, sale price, and image; opening stock also requires a department." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    if (departmentId) {
      const { data: department, error: departmentError } = await admin
        .from("departments")
        .select("id, head_user_id")
        .eq("id", departmentId)
        .maybeSingle();
      if (departmentError || !department) {
        if (departmentError) sendInventoryError(response, departmentError, "Could not verify the product department.");
        else response.status(400).json({ error: "Choose an existing department." });
        return;
      }
      if (stock > 0 && !department.head_user_id) {
        response.status(409).json({ error: "Assign a head of department before sending stock to this team." });
        return;
      }
    }
    const { data, error } = await admin
      .from("products")
      .insert({
        name: name.trim(),
        category: category.trim(),
        stock_quantity: 0,
        unit: unit.trim(),
        reorder_level: reorder,
        image_path: imagePath ?? null,
        department_id: departmentId ?? null,
        unit_price: price,
        created_by: request.flexbarUser?.id,
      })
      .select("id, name, category, stock_quantity, unit, reorder_level, image_path, department_id, unit_price, created_at, updated_at")
      .single();
    if (error) {
      sendInventoryError(response, error, "Could not save an inventory product.");
      return;
    }
    if (stock > 0 && departmentId) {
      const { error: deliveryError } = await admin
        .from("stock_deliveries")
        .insert({
          department_id: departmentId,
          product_id: data.id,
          quantity: stock,
          created_by: request.flexbarUser?.id,
        });
      if (deliveryError) {
        const { error: cleanupError } = await admin.from("products").delete().eq("id", data.id);
        if (cleanupError) console.error("Could not remove product after its initial stock dispatch failed.", cleanupError);
        sendInventoryError(response, deliveryError, "Could not record the initial department stock delivery.");
        return;
      }
    }
    response.status(201).json({
      product: {
        id: data.id,
        name: data.name,
        category: data.category,
        stock: 0,
        unit: data.unit,
        reorder: data.reorder_level,
        imagePath: data.image_path,
        departmentId: data.department_id,
        price: Number(data.unit_price),
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        stockDispatchQuantity: stock,
      },
      message: stock > 0 ? "Product created and stock sent to the department head for receipt." : "Product created.",
    });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize inventory product creation.");
  }
});

router.get("/deliveries", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to view stock deliveries." });
    return;
  }
  const canViewAll = allowedRoles.has(user.role);
  try {
    const admin = createSupabaseAdminClient();
    let query = admin
      .from("stock_deliveries")
      .select("id, department_id, product_id, quantity, created_by, created_at, received_by, received_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (!canViewAll) {
      if (!user.departmentId) {
        response.status(403).json({ error: "Assign your account to a department to view stock deliveries." });
        return;
      }
      const { data: department, error: departmentError } = await admin
        .from("departments")
        .select("head_user_id")
        .eq("id", user.departmentId)
        .maybeSingle();
      if (departmentError) {
        sendInventoryError(response, departmentError, "Could not verify department stock access.");
        return;
      }
      if (!department) {
        response.status(403).json({ error: "Your department could not be found." });
        return;
      }
      query = query.eq("department_id", user.departmentId);
    }
    const { data: deliveries, error } = await query;
    if (error) {
      sendInventoryError(response, error, "Could not load stock deliveries.");
      return;
    }
    const productIds = [...new Set((deliveries ?? []).map((delivery) => delivery.product_id))];
    const departmentIds = [...new Set((deliveries ?? []).map((delivery) => delivery.department_id))];
    const profileIds = [...new Set((deliveries ?? []).flatMap((delivery) => [delivery.created_by, delivery.received_by].filter((id): id is string => Boolean(id))))];
    const [{ data: products, error: productsError }, { data: departments, error: departmentsError }, { data: profiles, error: profilesError }] = await Promise.all([
      productIds.length ? admin.from("products").select("id, name, unit").in("id", productIds) : Promise.resolve({ data: [], error: null }),
      departmentIds.length ? admin.from("departments").select("id, name, head_user_id").in("id", departmentIds) : Promise.resolve({ data: [], error: null }),
      profileIds.length ? admin.from("profiles").select("id, display_name").in("id", profileIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const failure = productsError ?? departmentsError ?? profilesError;
    if (failure) {
      sendInventoryError(response, failure, "Could not load stock delivery details.");
      return;
    }
    const productById = new Map((products ?? []).map((product) => [product.id, product]));
    const departmentById = new Map((departments ?? []).map((department) => [department.id, department]));
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name ?? "Team member"]));
    response.status(200).json({
      deliveries: (deliveries ?? []).map((delivery) => ({
        id: delivery.id,
        departmentId: delivery.department_id,
        departmentName: departmentById.get(delivery.department_id)?.name ?? "Department",
        productId: delivery.product_id,
        productName: productById.get(delivery.product_id)?.name ?? "Product",
        unit: productById.get(delivery.product_id)?.unit ?? "items",
        quantity: delivery.quantity,
        createdBy: delivery.created_by,
        createdByName: profileById.get(delivery.created_by) ?? "Team member",
        createdAt: delivery.created_at,
        receivedBy: delivery.received_by,
        receivedByName: delivery.received_by ? profileById.get(delivery.received_by) ?? "Team member" : null,
        receivedAt: delivery.received_at,
        canReceive: departmentById.get(delivery.department_id)?.head_user_id === user.id && delivery.received_at === null,
      })),
    });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize stock deliveries.");
  }
});

router.post("/deliveries", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  const { productId, quantity } = request.body ?? {};
  if (typeof productId !== "string" || !uuidPattern.test(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    response.status(400).json({ error: "Choose a product and enter a stock quantity greater than zero." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: product, error: productError } = await admin
      .from("products")
      .select("id, department_id")
      .eq("id", productId)
      .maybeSingle();
    if (productError || !product) {
      if (productError) sendInventoryError(response, productError, "Could not verify stock delivery product.");
      else response.status(404).json({ error: "That product could not be found." });
      return;
    }
    if (!product.department_id) {
      response.status(400).json({ error: "Assign the product to a department before dispatching stock." });
      return;
    }
    const { data: department, error: departmentError } = await admin
      .from("departments")
      .select("head_user_id")
      .eq("id", product.department_id)
      .maybeSingle();
    if (departmentError) {
      sendInventoryError(response, departmentError, "Could not verify the receiving department head.");
      return;
    }
    if (!department?.head_user_id) {
      response.status(409).json({ error: "Assign a head of department before sending stock to this team." });
      return;
    }
    const { data: head, error: headError } = await admin
      .from("profiles")
      .select("id")
      .eq("id", department.head_user_id)
      .eq("department_id", product.department_id)
      .eq("is_active", true)
      .eq("is_archived", false)
      .maybeSingle();
    if (headError) {
      sendInventoryError(response, headError, "Could not verify the active department head.");
      return;
    }
    if (!head) {
      response.status(409).json({ error: "Assign an active department head before sending stock." });
      return;
    }
    const { data: delivery, error } = await admin
      .from("stock_deliveries")
      .insert({
        department_id: product.department_id,
        product_id: product.id,
        quantity,
        created_by: request.flexbarUser?.id,
      })
      .select("id, quantity, created_at")
      .single();
    if (error) {
      sendInventoryError(response, error, "Could not record stock dispatch.");
      return;
    }
    response.status(201).json({ delivery: { id: delivery.id, quantity: delivery.quantity, createdAt: delivery.created_at }, message: "Stock sent to the department head for receipt." });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize stock dispatch.");
  }
});

router.post("/deliveries/:deliveryId/receive", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to receive department stock." });
    return;
  }
  const { deliveryId } = request.params;
  if (typeof deliveryId !== "string" || !uuidPattern.test(deliveryId)) {
    response.status(400).json({ error: "Choose a valid stock delivery." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("receive_department_stock", {
      p_delivery_id: deliveryId,
      p_receiver_id: user.id,
    });
    if (error) {
      console.error("Department stock receipt was rejected.", error);
      response.status(409).json({ error: error.message });
      return;
    }
    response.status(200).json({ stock: data, message: "Stock received and inventory updated." });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not receive department stock.");
  }
});

router.patch("/products/:productId", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  const { productId } = request.params;
  const { name, category, unit, departmentId, price, imagePath } = request.body ?? {};
  if (
    typeof productId !== "string" || !uuidPattern.test(productId) ||
    typeof name !== "string" || name.trim().length < 2 || name.trim().length > 120 ||
    typeof category !== "string" || category.trim().length < 2 || category.trim().length > 80 ||
    typeof unit !== "string" || unit.trim().length < 1 || unit.trim().length > 30 ||
    typeof departmentId !== "string" || !uuidPattern.test(departmentId) ||
    typeof price !== "number" || !Number.isFinite(price) || price < 0 ||
    (imagePath !== undefined &&
      (typeof imagePath !== "string" ||
       !imagePathPattern.test(imagePath) ||
       !imagePath.startsWith(`${request.flexbarUser?.id}/`)))
  ) {
    response.status(400).json({ error: "Enter a valid product name, category, unit, department, sale price, and image." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data: department, error: departmentError } = await admin
      .from("departments")
      .select("id")
      .eq("id", departmentId)
      .maybeSingle();
    if (departmentError || !department) {
      if (departmentError) sendInventoryError(response, departmentError, "Could not verify the product department.");
      else response.status(400).json({ error: "Choose an existing department." });
      return;
    }
    const { data: existingProduct, error: existingProductError } = await admin
      .from("products")
      .select("id, stock_quantity, department_id")
      .eq("id", productId)
      .maybeSingle();
    if (existingProductError) {
      sendInventoryError(response, existingProductError, "Could not verify the product before editing.");
      return;
    }
    if (!existingProduct) {
      response.status(404).json({ error: "That product could not be found." });
      return;
    }
    if (existingProduct.department_id !== departmentId && existingProduct.stock_quantity > 0) {
      response.status(409).json({ error: "A product with stock cannot be reassigned to another department. Receive or sell its stock first." });
      return;
    }
    if (existingProduct.department_id !== departmentId) {
      const { data: pendingDeliveries, error: pendingError } = await admin
        .from("stock_deliveries")
        .select("id")
        .eq("product_id", productId)
        .is("received_at", null)
        .limit(1);
      if (pendingError) {
        sendInventoryError(response, pendingError, "Could not check pending stock deliveries.");
        return;
      }
      if (pendingDeliveries?.length) {
        response.status(409).json({ error: "This product has a pending stock delivery and cannot be reassigned yet." });
        return;
      }
    }
    const { data, error } = await admin
      .from("products")
      .update({
        name: name.trim(),
        category: category.trim(),
        unit: unit.trim(),
        department_id: departmentId,
        unit_price: price,
        ...(imagePath === undefined ? {} : { image_path: imagePath }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", productId)
      .select("id, name, category, unit, image_path, department_id, unit_price")
      .maybeSingle();
    if (error) {
      sendInventoryError(response, error, "Could not update the product's selling assignment.");
      return;
    }
    if (!data) {
      response.status(404).json({ error: "That product could not be found." });
      return;
    }
    response.status(200).json({
      product: {
        id: data.id,
        name: data.name,
        category: data.category,
        unit: data.unit,
        imagePath: data.image_path,
        departmentId: data.department_id,
        price: Number(data.unit_price),
      },
    });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize the product selling assignment update.");
  }
});

export { router as inventoryRouter };
