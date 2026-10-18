import cors from "cors";
import express from "express";
import { requireUser } from "./auth/requireUser.js";
import { attendanceRouter } from "./routes/attendance.js";
import { adminRouter } from "./routes/admin.js";
import { profileRouter } from "./routes/profile.js";
import { inventoryRouter } from "./routes/inventory.js";
import { salesRouter } from "./routes/sales.js";
import { departmentRouter } from "./routes/department.js";
import { chatRouter } from "./routes/chat.js";
import { callsRouter } from "./routes/calls.js";
import { accountSessionRouter } from "./routes/accountSession.js";
import { callPushRouter } from "./routes/callPush.js";
import { pushNotificationsRouter } from "./routes/pushNotifications.js";

const app = express();
const allowedOrigins = (process.env.FRONTEND_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("This origin is not allowed to access the Flex Bar API."));
    },
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/v1/health", (_request, response) => {
  response.status(200).json({ status: "ok", service: "flexbar-api" });
});

app.get("/api/v1/me", requireUser, (request, response) => {
  if (!request.flexbarUser) {
    response.status(500).json({ error: "The authenticated user profile is unavailable." });
    return;
  }

  response.status(200).json({
    id: request.flexbarUser.id,
    companyId: request.flexbarUser.companyId,
    companyName: request.flexbarUser.companyName,
    businessType: request.flexbarUser.businessType,
    email: request.flexbarUser.email,
    displayName: request.flexbarUser.displayName,
    avatarPath: request.flexbarUser.avatarPath,
    hasLockPin: request.flexbarUser.hasLockPin,
    departmentId: request.flexbarUser.departmentId,
    salesEnabled: request.flexbarUser.salesEnabled,
    role: request.flexbarUser.role,
  });
});

app.use("/api/v1/session", accountSessionRouter);
app.use("/api/v1/call-push", callPushRouter);
app.use("/api/v1/push-notifications", pushNotificationsRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/attendance", attendanceRouter);
app.use("/api/v1/profile", profileRouter);
app.use("/api/v1/inventory", inventoryRouter);
app.use("/api/v1/sales", salesRouter);
app.use("/api/v1/department", departmentRouter);
app.use("/api/v1/chat", chatRouter);
app.use("/api/v1/calls", callsRouter);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled API request error.", error);
  if (response.headersSent) return;
  response.status(500).json({ error: "An unexpected server error occurred." });
});

export { app };
export default app;
