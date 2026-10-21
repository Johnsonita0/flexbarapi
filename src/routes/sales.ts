import { Router } from "express";
import type { Request, Response } from "express";
import { requireUser } from "../auth/requireUser.js";
import { createSupabaseAdminClient } from "../services/supabaseAdmin.js";
import { notifyAdminsOfSystemError } from "../services/systemNotifications.js";

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paymentMethods = new Set(["cash", "card", "transfer"]);
const reportRoles = new Set(["super_admin", "management_admin"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userDepartment(request: Request, response: Response): string | null {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to access sales and shift handovers." });
    return null;
  }
  if (!user.departmentId) {
    response.status(403).json({ error: "Assign your account to a department to use sales and shift handovers." });
    return null;
  }
  return user.departmentId;
}

async function handleError(response: Response, error: unknown, context: string) {
  console.error(context, error);
  await notifyAdminsOfSystemError(response, error, context);
  if (error instanceof Error && error.message.includes("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY")) {
    response.status(503).json({ error: "Sales and handover services are not configured yet." });
    return;
  }
  response.status(500).json({ error: "We couldn't complete that request. Please try again." });
}

function rpcError(response: Response, error: { message: string }) {
  console.error("A sales or handover database operation was rejected.", error);
  response.status(409).json({ error: error.message });
}

function canViewAdminSales(request: Request, response: Response): boolean {
  if (!request.flexbarUser || !reportRoles.has(request.flexbarUser.role)) {
    response.status(403).json({ error: "You don't have permission to view administrator sales data." });
    return false;
  }
  return true;
}

function isValidReportDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function businessWorkDate(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

router.use(requireUser);

router.get("/catalog", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to access the sales catalog." });
    return;
  }
  const canBrowseAllDepartments = user.role === "super_admin" || user.role === "management_admin";
  if (!canBrowseAllDepartments && (!user.departmentId || !user.salesEnabled)) {
    response.status(403).json({ error: "Sales are not enabled for your department." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    let productsQuery = admin
      .from("products")
      .select("id, name, category, barcode, stock_quantity, unit, image_path, department_id, unit_price")
      .not("department_id", "is", null)
      .gt("unit_price", 0)
      .order("name");
    if (!canBrowseAllDepartments) productsQuery = productsQuery.eq("department_id", user.departmentId);

    const [{ data: products, error: productsError }, { data: departments, error: departmentsError }] = await Promise.all([
      productsQuery,
      admin.from("departments").select("id, name, sales_enabled").eq("sales_enabled", true).order("name"),
    ]);
    if (productsError || departmentsError) {
      handleError(response, productsError ?? departmentsError, "Could not load sales catalog.");
      return;
    }
    const departmentById = new Map((departments ?? []).map((department) => [department.id, department]));
    response.status(200).json({
      departmentId: canBrowseAllDepartments ? null : user.departmentId,
      departments: (departments ?? []).map((department) => ({ id: department.id, name: department.name })),
      products: (products ?? [])
        .filter((product) => departmentById.has(product.department_id))
        .map((product) => ({
          id: product.id,
          name: product.name,
          category: product.category,
          barcode: product.barcode,
          stock: product.stock_quantity,
          unit: product.unit,
          imagePath: product.image_path,
          departmentId: product.department_id,
          departmentName: departmentById.get(product.department_id)?.name ?? "",
          price: Number(product.unit_price),
        })),
    });
  } catch (error: unknown) {
    handleError(response, error, "Could not initialize sales catalog.");
  }
});

router.post("/sales", async (request, response) => {
  const user = request.flexbarUser;
  const departmentId = userDepartment(request, response);
  if (!user || !departmentId) return;
  if (!user.salesEnabled) {
    response.status(403).json({ error: "Sales are not enabled for your department." });
    return;
  }
  if (
    !isRecord(request.body) ||
    typeof request.body.paymentMethod !== "string" || !paymentMethods.has(request.body.paymentMethod) ||
    !Array.isArray(request.body.items) || request.body.items.length === 0 ||
    request.body.items.length > 100 ||
    request.body.items.some((item: unknown) =>
      !isRecord(item) || typeof item.productId !== "string" || !uuidPattern.test(item.productId) ||
      !Number.isInteger(item.quantity) || (item.quantity as number) < 1,
    )
  ) {
    response.status(400).json({ error: "Choose products, quantities, and a valid payment method." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data: businessSettings, error: settingsError } = await admin
      .from("business_settings")
      .select("timezone")
      .single();
    if (settingsError) {
      handleError(response, settingsError, "Could not verify the business date before recording a sale.");
      return;
    }
    const { data: closedShift, error: closeError } = await admin
      .from("shift_closings")
      .select("id")
      .eq("user_id", user.id)
      .eq("business_date", businessWorkDate(businessSettings.timezone))
      .maybeSingle();
    if (closeError) {
      handleError(response, closeError, "Could not verify the seller's shift status.");
      return;
    }
    if (closedShift) {
      response.status(409).json({ error: "Your shift is already closed for today. Ask your department head to review the close before recording another sale." });
      return;
    }
    const { data: saleId, error } = await admin.rpc("record_department_sale", {
      p_seller_id: user.id,
      p_department_id: departmentId,
      p_payment_method: request.body.paymentMethod,
      p_items: request.body.items,
    });
    if (error) {
      rpcError(response, error);
      return;
    }
    response.status(201).json({ saleId, message: "Sale recorded and department stock updated." });
  } catch (error: unknown) {
    handleError(response, error, "Could not record a department sale.");
  }
});

router.get("/history", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to view sales." });
    return;
  }
  const canBrowseAllDepartments = user.role === "super_admin" || user.role === "management_admin";
  if (!canBrowseAllDepartments && (!user.departmentId || !user.salesEnabled)) {
    response.status(403).json({ error: "Sales are not enabled for your department." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    let salesQuery = admin
      .from("sales")
      .select("id, department_id, seller_id, payment_method, total_amount, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (!canBrowseAllDepartments) salesQuery = salesQuery.eq("department_id", user.departmentId);
    const { data: sales, error } = await salesQuery;
    if (error) {
      handleError(response, error, "Could not load sales history.");
      return;
    }
    const ids = (sales ?? []).map((sale) => sale.id);
    if (ids.length === 0) {
      response.status(200).json({ sales: [] });
      return;
    }
    const [{ data: items, error: itemsError }, { data: departments, error: departmentsError }, { data: profiles, error: profilesError }] = await Promise.all([
      admin.from("sale_items").select("sale_id, product_name, quantity, unit_price, line_total").in("sale_id", ids),
      admin.from("departments").select("id, name"),
      admin.from("profiles").select("id, display_name").in("id", [...new Set((sales ?? []).map((sale) => sale.seller_id))]),
    ]);
    const failure = itemsError ?? departmentsError ?? profilesError;
    if (failure) {
      handleError(response, failure, "Could not load sales details.");
      return;
    }
    const departmentNames = new Map((departments ?? []).map((department) => [department.id, department.name]));
    const staffNames = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name]));
    const itemsBySale = new Map<string, typeof items>();
    for (const item of items ?? []) itemsBySale.set(item.sale_id, [...(itemsBySale.get(item.sale_id) ?? []), item]);
    response.status(200).json({
      sales: (sales ?? []).map((sale) => ({
        id: sale.id,
        departmentName: departmentNames.get(sale.department_id) ?? "Department",
        sellerName: staffNames.get(sale.seller_id) ?? "Former staff member",
        paymentMethod: sale.payment_method,
        total: Number(sale.total_amount),
        createdAt: sale.created_at,
        items: (itemsBySale.get(sale.id) ?? []).map((item) => ({
          name: item.product_name,
          quantity: item.quantity,
          unitPrice: Number(item.unit_price),
          total: Number(item.line_total),
        })),
      })),
    });
  } catch (error: unknown) {
    handleError(response, error, "Could not initialize sales history.");
  }
});

router.get("/report", async (request, response) => {
  if (!canViewAdminSales(request, response)) return;
  const from = request.query.from;
  const to = request.query.to;
  if (!isValidReportDate(from) || !isValidReportDate(to)) {
    response.status(400).json({ error: "Choose valid start and end dates for the sales report." });
    return;
  }
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
  if (days < 0 || days > 365) {
    response.status(400).json({ error: "Choose a date range of up to one year." });
    return;
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data: departments, error: departmentsError } = await admin
      .from("departments")
      .select("id, name")
      .eq("company_id", request.flexbarUser?.companyId);
    if (departmentsError) {
      handleError(response, departmentsError, "Could not load administrator sales report departments.");
      return;
    }
    const departmentIds = (departments ?? []).map((department) => department.id);
    const allSales: Array<{
      id: string;
      department_id: string;
      seller_id: string;
      total_amount: number | string;
      created_at: string;
    }> = [];
    if (departmentIds.length) {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await admin
          .from("sales")
          .select("id, department_id, seller_id, total_amount, created_at")
          .in("department_id", departmentIds)
          .gte("created_at", `${from}T00:00:00.000Z`)
          .lt("created_at", new Date(end.getTime() + 86_400_000).toISOString())
          .order("created_at", { ascending: false })
          .range(offset, offset + 999);
        if (error) {
          handleError(response, error, "Could not load administrator sales report.");
          return;
        }
        allSales.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
    }

    const sales = allSales.slice(0, 100);
    const sellerIds = [...new Set(sales.map((sale) => sale.seller_id))];
    const { data: profiles, error: profilesError } = sellerIds.length
      ? await admin.from("profiles").select("id, display_name").in("id", sellerIds)
      : { data: [], error: null };
    if (profilesError) {
      handleError(response, profilesError, "Could not load sales report details.");
      return;
    }
    const purchasePayments: Array<{ amount: number | string; paid_at: string }> = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.from("vendor_purchase_payments")
        .select("amount, paid_at")
        .eq("company_id", request.flexbarUser?.companyId)
        .gte("paid_at", `${from}T00:00:00.000Z`)
        .lt("paid_at", new Date(end.getTime() + 86_400_000).toISOString())
        .order("paid_at", { ascending: true })
        .range(offset, offset + 999);
      if (error) {
        handleError(response, error, "Could not load vendor payment report details.");
        return;
      }
      purchasePayments.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const departmentNames = new Map((departments ?? []).map((department) => [department.id, department.name]));
    const staffNames = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name]));
    const dailyTotals = new Map<string, { date: string; total: number; count: number; expenditure: number; cogs: number; costedRevenue: number }>();
    let total = 0;
    for (const sale of allSales) {
      const amount = Number(sale.total_amount);
      const date = sale.created_at.slice(0, 10);
      const daily = dailyTotals.get(date) ?? { date, total: 0, count: 0, expenditure: 0, cogs: 0, costedRevenue: 0 };
      daily.total += amount;
      daily.count += 1;
      dailyTotals.set(date, daily);
      total += amount;
    }
    let expenditure = 0;
    for (const payment of purchasePayments ?? []) {
      const amount = Number(payment.amount);
      const date = payment.paid_at.slice(0, 10);
      const daily = dailyTotals.get(date) ?? { date, total: 0, count: 0, expenditure: 0, cogs: 0, costedRevenue: 0 };
      daily.expenditure += amount;
      dailyTotals.set(date, daily);
      expenditure += amount;
    }
    let cogs = 0;
    let costedRevenue = 0;
    const saleIds = allSales.map((sale) => sale.id);
    const saleDateById = new Map(allSales.map((sale) => [sale.id, sale.created_at.slice(0, 10)]));
    for (let offset = 0; offset < saleIds.length; offset += 500) {
      for (let itemOffset = 0; ; itemOffset += 1000) {
        const { data: items, error: itemsError } = await admin
          .from("sale_items")
          .select("sale_id, line_cost, line_total")
          .in("sale_id", saleIds.slice(offset, offset + 500))
          .order("id", { ascending: true })
          .range(itemOffset, itemOffset + 999);
        if (itemsError) {
          handleError(response, itemsError, "Could not load sales cost details.");
          return;
        }
        for (const item of items ?? []) {
          if (item.line_cost === null) continue;
          const amount = Number(item.line_cost);
          const revenue = Number(item.line_total);
          const date = saleDateById.get(item.sale_id);
          if (!date) continue;
          const daily = dailyTotals.get(date) ?? { date, total: 0, count: 0, expenditure: 0, cogs: 0, costedRevenue: 0 };
          daily.cogs += amount;
          daily.costedRevenue += revenue;
          dailyTotals.set(date, daily);
          cogs += amount;
          costedRevenue += revenue;
        }
        if (!items || items.length < 1000) break;
      }
    }
    for (let offset = 0; offset <= days; offset += 1) {
      const date = new Date(start.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
      if (!dailyTotals.has(date)) dailyTotals.set(date, { date, total: 0, count: 0, expenditure: 0, cogs: 0, costedRevenue: 0 });
    }
    const grossProfit = costedRevenue - cogs;
    const daily = [...dailyTotals.values()]
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((day) => ({ ...day, grossProfit: day.costedRevenue - day.cogs }));
    const projectionDays = 30;
    response.status(200).json({
      from,
      to,
      summary: {
        total,
        transactions: allSales.length,
        expenditure,
        cogs,
        grossProfit,
        costCoverage: total > 0 ? costedRevenue / total : 0,
        netCashFlow: total - expenditure,
      },
      daily,
      projection: {
        days: projectionDays,
        sales: total / (days + 1) * projectionDays,
        expenditure: expenditure / (days + 1) * projectionDays,
        grossProfit: grossProfit / (days + 1) * projectionDays,
        netCashFlow: (total - expenditure) / (days + 1) * projectionDays,
      },
      sales: sales.map((sale) => ({
        id: sale.id,
        departmentName: departmentNames.get(sale.department_id) ?? "Department",
        sellerName: staffNames.get(sale.seller_id) ?? "Former staff member",
        total: Number(sale.total_amount),
        createdAt: sale.created_at,
      })),
    });
  } catch (error: unknown) {
    handleError(response, error, "Could not initialize administrator sales report.");
  }
});

router.get("/notifications", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to view your notifications." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const [notificationsResult, unreadResult] = await Promise.all([
      admin
        .from("notifications")
        .select("id, type, title, detail, sale_id, created_at, read_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100),
      admin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("read_at", null),
    ]);
    if (notificationsResult.error || unreadResult.error) {
      handleError(response, notificationsResult.error ?? unreadResult.error, "Could not load notifications.");
      return;
    }
    response.status(200).json({
      unreadCount: unreadResult.count ?? 0,
      notifications: (notificationsResult.data ?? []).map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        detail: item.detail,
        saleId: item.sale_id,
        createdAt: item.created_at,
        readAt: item.read_at,
      })),
    });
  } catch (error: unknown) {
    handleError(response, error, "Could not initialize notifications.");
  }
});

router.patch("/notifications/read", async (request, response) => {
  const user = request.flexbarUser;
  if (!user) {
    response.status(401).json({ error: "Please sign in to update your notifications." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .is("read_at", null);
    if (error) {
      handleError(response, error, "Could not mark notifications as read.");
      return;
    }
    response.status(200).json({ message: "Notifications marked as read." });
  } catch (error: unknown) {
    handleError(response, error, "Could not update notifications.");
  }
});

router.patch("/notifications/:notificationId/read", async (request, response) => {
  const user = request.flexbarUser;
  const notificationId = request.params.notificationId;
  if (!user) {
    response.status(401).json({ error: "Please sign in to update your notifications." });
    return;
  }
  if (!notificationId || !uuidPattern.test(notificationId)) {
    response.status(400).json({ error: "Choose a valid notification." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId)
      .eq("user_id", user.id);
    if (error) {
      handleError(response, error, "Could not mark the notification as read.");
      return;
    }
    response.status(200).json({ message: "Notification marked as read." });
  } catch (error: unknown) {
    handleError(response, error, "Could not update the notification.");
  }
});

router.get("/handover-options", async (request, response) => {
  const user = request.flexbarUser;
  const departmentId = userDepartment(request, response);
  if (!user || !departmentId) return;
  try {
    const admin = createSupabaseAdminClient();
    const [{ data: products, error: productsError }, { data: staff, error: staffError }] = await Promise.all([
      admin.from("products").select("id, name, stock_quantity, unit, department_id").eq("department_id", departmentId).order("name"),
      admin.from("profiles").select("id, display_name").eq("department_id", departmentId).eq("is_active", true).eq("is_archived", false).neq("id", user.id).order("display_name"),
    ]);
    if (productsError || staffError) {
      handleError(response, productsError ?? staffError, "Could not load handover options.");
      return;
    }
    response.status(200).json({
      products: (products ?? []).map((product) => ({ id: product.id, name: product.name, stock: product.stock_quantity, unit: product.unit })),
      staff: (staff ?? []).map((person) => ({ id: person.id, name: person.display_name ?? "Team member" })),
    });
  } catch (error: unknown) {
    handleError(response, error, "Could not initialize handover options.");
  }
});

router.get("/handovers", async (request, response) => {
  const user = request.flexbarUser;
  const departmentId = userDepartment(request, response);
  if (!user || !departmentId) return;
  try {
    const admin = createSupabaseAdminClient();
    const { data: handovers, error } = await admin
      .from("stock_handovers")
      .select("id, sender_id, receiver_id, status, created_at, accepted_at")
      .eq("department_id", departmentId)
      .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      handleError(response, error, "Could not load shift handovers.");
      return;
    }
    const ids = (handovers ?? []).map((handover) => handover.id);
    if (ids.length === 0) {
      response.status(200).json({ handovers: [] });
      return;
    }
    const profileIds = [...new Set((handovers ?? []).flatMap((handover) => [handover.sender_id, handover.receiver_id]))];
    const [{ data: items, error: itemsError }, { data: profiles, error: profilesError }] = await Promise.all([
      admin.from("stock_handover_items").select("handover_id, product_id, product_name, sent_quantity, received_quantity").in("handover_id", ids),
      admin.from("profiles").select("id, display_name").in("id", profileIds),
    ]);
    if (itemsError || profilesError) {
      handleError(response, itemsError ?? profilesError, "Could not load handover details.");
      return;
    }
    const names = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name ?? "Team member"]));
    const itemsByHandover = new Map<string, typeof items>();
    for (const item of items ?? []) itemsByHandover.set(item.handover_id, [...(itemsByHandover.get(item.handover_id) ?? []), item]);
    response.status(200).json({
      handovers: (handovers ?? []).map((handover) => ({
        id: handover.id,
        senderId: handover.sender_id,
        senderName: names.get(handover.sender_id) ?? "Former staff member",
        receiverId: handover.receiver_id,
        receiverName: names.get(handover.receiver_id) ?? "Former staff member",
        status: handover.status,
        createdAt: handover.created_at,
        acceptedAt: handover.accepted_at,
        items: (itemsByHandover.get(handover.id) ?? []).map((item) => ({
          productId: item.product_id,
          productName: item.product_name,
          sentQuantity: item.sent_quantity,
          receivedQuantity: item.received_quantity,
        })),
      })),
    });
  } catch (error: unknown) {
    handleError(response, error, "Could not initialize shift handovers.");
  }
});

router.post("/handovers", async (request, response) => {
  const user = request.flexbarUser;
  const departmentId = userDepartment(request, response);
  if (!user || !departmentId) return;
  if (
    !isRecord(request.body) ||
    typeof request.body.receiverId !== "string" || !uuidPattern.test(request.body.receiverId) ||
    !Array.isArray(request.body.items) || request.body.items.length === 0 || request.body.items.length > 200 ||
    request.body.items.some((item: unknown) =>
      !isRecord(item) || typeof item.productId !== "string" || !uuidPattern.test(item.productId) ||
      !Number.isInteger(item.quantity) || (item.quantity as number) < 0,
    )
  ) {
    response.status(400).json({ error: "Select the next-shift staff member and enter a non-negative count for each item." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("create_stock_handover", {
      p_sender_id: user.id,
      p_receiver_id: request.body.receiverId,
      p_department_id: departmentId,
      p_items: request.body.items,
    });
    if (error) {
      rpcError(response, error);
      return;
    }
    response.status(201).json({ handoverId: data, message: "Stock handover sent for receiver confirmation." });
  } catch (error: unknown) {
    handleError(response, error, "Could not create a stock handover.");
  }
});

router.post("/handovers/:handoverId/accept", async (request, response) => {
  const user = request.flexbarUser;
  const handoverId = request.params.handoverId;
  if (!user || typeof handoverId !== "string" || !uuidPattern.test(handoverId)) {
    response.status(400).json({ error: "Choose a valid shift handover." });
    return;
  }
  if (!Array.isArray(request.body?.items) || request.body.items.length === 0 || request.body.items.length > 200 || request.body.items.some((item: unknown) =>
    !isRecord(item) || typeof item.productId !== "string" || !uuidPattern.test(item.productId) ||
    !Number.isInteger(item.quantity) || (item.quantity as number) < 0,
  )) {
    response.status(400).json({ error: "Enter a non-negative received count for each handed-over item." });
    return;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.rpc("accept_stock_handover", {
      p_handover_id: handoverId,
      p_receiver_id: user.id,
      p_items: request.body.items,
    });
    if (error) {
      rpcError(response, error);
      return;
    }
    response.status(200).json({ message: "Handover accepted and stock levels reconciled." });
  } catch (error: unknown) {
    handleError(response, error, "Could not accept a stock handover.");
  }
});

export { router as salesRouter };
