import cors from "cors";
import express from "express";
import { requireUser } from "./auth/requireUser.js";
import { attendanceRouter } from "./routes/attendance.js";
import { adminRouter } from "./routes/admin.js";

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
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
    email: request.flexbarUser.email,
    displayName: request.flexbarUser.displayName,
    role: request.flexbarUser.role,
  });
});

app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/attendance", attendanceRouter);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled API request error.", error);
  if (response.headersSent) return;
  response.status(500).json({ error: "An unexpected server error occurred." });
});

export { app };
export default app;
