import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";
import { notifyAdminsOfSystemError } from "../services/systemNotifications.js";

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

async function sendInventoryError(response: Response, error: unknown, context: string) {
  console.error(context, error);
  await notifyAdminsOfSystemError(response, error, context);
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
    const [{ data, error }, { data: departments, error: departmentError }, { data: pendingDeliveries, error: deliveriesError }] = await Promise.all([
      admin
      .from("products")
      .select("id, name, category, barcode, stock_quantity, central_stock_quantity, unit, reorder_level, image_path, department_id, unit_price, created_at, updated_at")
      .eq("company_id", request.flexbarUser?.companyId)
      .order("name"),
      admin.from("departments").select("id, name, head_user_id").eq("company_id", request.flexbarUser?.companyId),
      admin.from("stock_deliveries").select("product_id, quantity").eq("company_id", request.flexbarUser?.companyId).is("received_at", null),
    ]);
    if (error || departmentError || deliveriesError) {
      sendInventoryError(response, error ?? departmentError ?? deliveriesError, "Could not load inventory products.");
      return;
    }
    const departmentById = new Map((departments ?? []).map((department) => [department.id, department.name]));
    const inTransitByProduct = new Map<string, number>();
    for (const delivery of pendingDeliveries ?? []) {
      inTransitByProduct.set(delivery.product_id, (inTransitByProduct.get(delivery.product_id) ?? 0) + delivery.quantity);
    }
    response.status(200).json({
      products: (data ?? []).map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        barcode: product.barcode,
        stock: product.stock_quantity,
        centralStock: product.central_stock_quantity,
        inTransitStock: inTransitByProduct.get(product.id) ?? 0,
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
  const { name, category, barcode, stock, unit, reorder, imagePath, departmentId, price } = request.body ?? {};
  const normalizedBarcode = typeof barcode === "string" ? barcode.trim() || null : barcode ?? null;
  if (
    typeof name !== "string" || name.trim().length < 2 || name.trim().length > 120 ||
    typeof category !== "string" || category.trim().length < 2 || category.trim().length > 80 ||
    (normalizedBarcode !== null && (typeof normalizedBarcode !== "string" || normalizedBarcode.length > 100)) ||
    !Number.isInteger(stock) || stock !== 0 ||
    typeof unit !== "string" || unit.trim().length < 1 || unit.trim().length > 30 ||
    !Number.isInteger(reorder) || reorder < 0 ||
    (departmentId !== null && departmentId !== undefined && (typeof departmentId !== "string" || !uuidPattern.test(departmentId))) ||
    typeof price !== "number" || !Number.isFinite(price) || price < 0 ||
    (imagePath !== null && imagePath !== undefined &&
      (typeof imagePath !== "string" ||
       !imagePathPattern.test(imagePath) ||
       !imagePath.startsWith(`${request.flexbarUser?.id}/`)))
  ) {
    response.status(400).json({ error: "Enter valid product details. Record purchased stock through a vendor purchase so its cost and payment are tracked." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    if (departmentId) {
      const { data: department, error: departmentError } = await admin
        .from("departments")
        .select("id")
        .eq("id", departmentId)
        .eq("company_id", request.flexbarUser?.companyId)
        .maybeSingle();
      if (departmentError || !department) {
        if (departmentError) sendInventoryError(response, departmentError, "Could not verify the product department.");
        else response.status(400).json({ error: "Choose an existing department." });
        return;
      }
    }
    const { data, error } = await admin
      .from("products")
      .insert({
        name: name.trim(),
        category: category.trim(),
        barcode: normalizedBarcode,
        stock_quantity: 0,
        central_stock_quantity: stock,
        unit: unit.trim(),
        reorder_level: reorder,
        image_path: imagePath ?? null,
        department_id: departmentId ?? null,
        unit_price: price,
        created_by: request.flexbarUser?.id,
      })
      .select("id, name, category, barcode, stock_quantity, central_stock_quantity, unit, reorder_level, image_path, department_id, unit_price, created_at, updated_at")
      .single();
    if (error) {
      if (error.code === "23505") {
        response.status(409).json({ error: "This barcode is already assigned to another product." });
        return;
      }
      sendInventoryError(response, error, "Could not save an inventory product.");
      return;
    }
    response.status(201).json({
      product: {
        id: data.id,
        name: data.name,
        category: data.category,
        barcode: data.barcode,
        stock: data.stock_quantity,
        centralStock: data.central_stock_quantity,
        inTransitStock: 0,
        unit: data.unit,
        reorder: data.reorder_level,
        imagePath: data.image_path,
        departmentId: data.department_id,
        price: Number(data.unit_price),
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      },
      message: "Product created. Record vendor purchases to add stock to central inventory.",
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
      .select("id, department_id, product_id, quantity, received_quantity, created_by, created_at, received_by, received_at")
      .eq("company_id", user.companyId)
      .order("created_at", { ascending: false });
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
      productIds.length ? admin.from("products").select("id, name, unit, stock_quantity").in("id", productIds) : Promise.resolve({ data: [], error: null }),
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
    const receivedByProduct = new Map<string, typeof deliveries>();
    for (const delivery of deliveries ?? []) {
      if (delivery.received_at) {
        receivedByProduct.set(delivery.product_id, [...(receivedByProduct.get(delivery.product_id) ?? []), delivery]);
      }
    }
    const deliveryBalances = new Map<string, number>();
    for (const [productId, productDeliveries] of receivedByProduct) {
      const product = productById.get(productId);
      let remainingStock = Math.min(
        product?.stock_quantity ?? 0,
        productDeliveries.reduce((sum, delivery) => sum + delivery.received_quantity, 0),
      );
      for (const delivery of [...productDeliveries].reverse()) {
        const remaining = Math.min(delivery.received_quantity, remainingStock);
        deliveryBalances.set(delivery.id, remaining);
        remainingStock -= remaining;
      }
    }
    response.status(200).json({
      deliveries: (deliveries ?? []).map((delivery) => ({
        id: delivery.id,
        departmentId: delivery.department_id,
        departmentName: departmentById.get(delivery.department_id)?.name ?? "Department",
        productId: delivery.product_id,
        productName: productById.get(delivery.product_id)?.name ?? "Product",
        unit: productById.get(delivery.product_id)?.unit ?? "items",
        quantity: delivery.quantity,
        receivedQuantity: delivery.received_quantity,
        remainingQuantity: delivery.received_at ? deliveryBalances.get(delivery.id) ?? 0 : 0,
        soldQuantity: delivery.received_at ? delivery.received_quantity - (deliveryBalances.get(delivery.id) ?? 0) : 0,
        departmentStock: productById.get(delivery.product_id)?.stock_quantity ?? 0,
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
    const { data: deliveryId, error } = await admin.rpc("dispatch_department_stock", {
      p_product_id: productId,
      p_quantity: quantity,
      p_sender_id: request.flexbarUser?.id,
    });
    if (error) {
      response.status(409).json({ error: error.message });
      return;
    }
    response.status(201).json({ deliveryId, message: "Stock reserved from central inventory and sent to the department head for receipt." });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize stock dispatch.");
  }
});

router.post("/products/:productId/central-stock", async (_request, response) => {
  response.status(410).json({ error: "Central stock must be recorded as a vendor purchase, including its supplier, cost, and payment." });
});

router.get("/purchases", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  try {
    const admin = createSupabaseAdminClient();
    const { data: purchases, error } = await admin
      .from("vendor_purchases")
      .select("id, product_id, vendor_name, reference, package_quantity, units_per_package, total_units, rate_per_package, invoice_total, created_by, created_at")
      .eq("company_id", request.flexbarUser?.companyId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      sendInventoryError(response, error, "Could not load vendor purchases.");
      return;
    }
    const purchaseIds = (purchases ?? []).map((purchase) => purchase.id);
    const productIds = [...new Set((purchases ?? []).map((purchase) => purchase.product_id))];
    const profileIds = new Set((purchases ?? []).map((purchase) => purchase.created_by));
    const [{ data: payments, error: paymentError }, { data: products, error: productError }] = await Promise.all([
      purchaseIds.length
        ? admin.from("vendor_purchase_payments").select("id, purchase_id, amount, payment_method, paid_by, paid_at").in("purchase_id", purchaseIds).order("paid_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      productIds.length
        ? admin.from("products").select("id, name, unit").in("id", productIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const payment of payments ?? []) profileIds.add(payment.paid_by);
    const { data: profiles, error: profileError } = profileIds.size
      ? await admin.from("profiles").select("id, display_name").in("id", [...profileIds])
      : { data: [], error: null };
    const failure = paymentError ?? productError ?? profileError;
    if (failure) {
      sendInventoryError(response, failure, "Could not load vendor purchase details.");
      return;
    }
    const productById = new Map((products ?? []).map((product) => [product.id, product]));
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name ?? "Team member"]));
    const paymentsByPurchase = new Map<string, NonNullable<typeof payments>>();
    for (const payment of payments ?? []) {
      paymentsByPurchase.set(payment.purchase_id, [...(paymentsByPurchase.get(payment.purchase_id) ?? []), payment]);
    }
    response.status(200).json({
      purchases: (purchases ?? []).map((purchase) => {
        const purchasePayments = paymentsByPurchase.get(purchase.id) ?? [];
        const paid = purchasePayments.reduce((sum, payment) => sum + Number(payment.amount), 0);
        const product = productById.get(purchase.product_id);
        return {
          id: purchase.id,
          productId: purchase.product_id,
          productName: product?.name ?? "Product",
          unit: product?.unit ?? "items",
          vendorName: purchase.vendor_name,
          reference: purchase.reference,
          packageQuantity: purchase.package_quantity,
          unitsPerPackage: purchase.units_per_package,
          totalUnits: purchase.total_units,
          ratePerPackage: Number(purchase.rate_per_package),
          invoiceTotal: Number(purchase.invoice_total),
          amountPaid: paid,
          balance: Math.max(0, Number(purchase.invoice_total) - paid),
          createdByName: profileById.get(purchase.created_by) ?? "Team member",
          createdAt: purchase.created_at,
          payments: purchasePayments.map((payment) => ({
            id: payment.id,
            amount: Number(payment.amount),
            method: payment.payment_method,
            paidByName: profileById.get(payment.paid_by) ?? "Team member",
            paidAt: payment.paid_at,
          })),
        };
      }),
    });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not initialize vendor purchase history.");
  }
});

router.post("/purchases", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  const { productId, vendorName, reference, packageQuantity, unitsPerPackage, ratePerPackage, amountPaid, paymentMethod } = request.body ?? {};
  if (
    typeof productId !== "string" || !uuidPattern.test(productId) ||
    typeof vendorName !== "string" || vendorName.trim().length < 2 || vendorName.trim().length > 160 ||
    (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.trim().length > 100)) ||
    !Number.isInteger(packageQuantity) || packageQuantity < 1 ||
    !Number.isInteger(unitsPerPackage) || unitsPerPackage < 1 ||
    packageQuantity * unitsPerPackage > 1_000_000 ||
    typeof ratePerPackage !== "number" || !Number.isFinite(ratePerPackage) || ratePerPackage < 0 ||
    typeof amountPaid !== "number" || !Number.isFinite(amountPaid) || amountPaid < 0 ||
    !["cash", "card", "transfer"].includes(paymentMethod)
  ) {
    response.status(400).json({ error: "Enter a valid product, vendor, package quantity, units per package, purchase rate, and payment." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("record_vendor_purchase", {
      p_product_id: productId,
      p_vendor_name: vendorName.trim(),
      p_package_quantity: packageQuantity,
      p_units_per_package: unitsPerPackage,
      p_rate_per_package: ratePerPackage,
      p_amount_paid: amountPaid,
      p_payment_method: paymentMethod,
      p_reference: reference?.trim() || null,
      p_user_id: request.flexbarUser?.id,
    });
    if (error) {
      if (error.code === "P0002") {
        response.status(404).json({ error: "That product could not be found." });
        return;
      }
      console.error("Vendor purchase could not be recorded.", error);
      response.status(409).json({ error: error.message });
      return;
    }
    response.status(201).json({ ...data, message: "Vendor purchase recorded and stock added to central inventory." });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not record a vendor purchase.");
  }
});

router.post("/purchases/:purchaseId/payments", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  const { purchaseId } = request.params;
  const { amount, paymentMethod } = request.body ?? {};
  if (
    typeof purchaseId !== "string" || !uuidPattern.test(purchaseId) ||
    typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 ||
    !["cash", "card", "transfer"].includes(paymentMethod)
  ) {
    response.status(400).json({ error: "Enter a valid vendor payment amount and method." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("record_vendor_purchase_payment", {
      p_purchase_id: purchaseId,
      p_amount: amount,
      p_payment_method: paymentMethod,
      p_user_id: request.flexbarUser?.id,
    });
    if (error) {
      if (error.code === "P0002") {
        response.status(404).json({ error: "That vendor purchase could not be found." });
        return;
      }
      console.error("Vendor purchase payment could not be recorded.", error);
      response.status(409).json({ error: error.message });
      return;
    }
    response.status(201).json({ amountPaid: Number(data), message: "Vendor payment recorded." });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not record a vendor payment.");
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
  const receivedQuantity = request.body?.receivedQuantity;
  if (!Number.isInteger(receivedQuantity) || receivedQuantity < 0 || receivedQuantity > 1_000_000) {
    response.status(400).json({ error: "Enter a valid quantity received, including zero if the delivery is rejected." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("receive_department_stock", {
      p_delivery_id: deliveryId,
      p_receiver_id: user.id,
      p_received_quantity: receivedQuantity,
    });
    if (error) {
      console.error("Department stock receipt was rejected.", error);
      response.status(409).json({ error: error.message });
      return;
    }
    response.status(200).json({
      stock: data,
      message: receivedQuantity === 0
        ? "Delivery rejected and reserved stock returned to central inventory."
        : "Stock receipt confirmed and inventory updated.",
    });
  } catch (error: unknown) {
    sendInventoryError(response, error, "Could not receive department stock.");
  }
});

router.patch("/products/:productId", async (request, response) => {
  if (!requireInventoryRole(request, response)) return;
  const { productId } = request.params;
  const { name, category, barcode, unit, departmentId, price, imagePath } = request.body ?? {};
  const normalizedBarcode = typeof barcode === "string" ? barcode.trim() || null : barcode ?? null;
  if (
    typeof productId !== "string" || !uuidPattern.test(productId) ||
    typeof name !== "string" || name.trim().length < 2 || name.trim().length > 120 ||
    typeof category !== "string" || category.trim().length < 2 || category.trim().length > 80 ||
    (normalizedBarcode !== null && (typeof normalizedBarcode !== "string" || normalizedBarcode.length > 100)) ||
    typeof unit !== "string" || unit.trim().length < 1 || unit.trim().length > 30 ||
    (departmentId !== null && departmentId !== undefined && (typeof departmentId !== "string" || !uuidPattern.test(departmentId))) ||
    typeof price !== "number" || !Number.isFinite(price) || price < 0 ||
    (imagePath !== undefined &&
      (typeof imagePath !== "string" ||
       !imagePathPattern.test(imagePath) ||
       !imagePath.startsWith(`${request.flexbarUser?.id}/`)))
  ) {
    response.status(400).json({ error: "Enter a valid product name, barcode, category, unit, department, sale price, and image." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    if (departmentId) {
      const { data: department, error: departmentError } = await admin
        .from("departments")
        .select("id")
        .eq("id", departmentId)
        .eq("company_id", request.flexbarUser?.companyId)
        .maybeSingle();
      if (departmentError || !department) {
        if (departmentError) sendInventoryError(response, departmentError, "Could not verify the product department.");
        else response.status(400).json({ error: "Choose an existing department." });
        return;
      }
    }
    const { data: existingProduct, error: existingProductError } = await admin
      .from("products")
      .select("id, stock_quantity, department_id")
      .eq("id", productId)
      .eq("company_id", request.flexbarUser?.companyId)
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
        barcode: normalizedBarcode,
        unit: unit.trim(),
        department_id: departmentId ?? null,
        unit_price: price,
        ...(imagePath === undefined ? {} : { image_path: imagePath }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", productId)
      .select("id, name, category, barcode, unit, image_path, department_id, unit_price")
      .maybeSingle();
    if (error) {
      if (error.code === "23505") {
        response.status(409).json({ error: "This barcode is already assigned to another product." });
        return;
      }
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
        barcode: data.barcode,
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
