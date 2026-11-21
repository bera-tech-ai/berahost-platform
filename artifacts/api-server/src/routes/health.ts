import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/status", async (_req, res): Promise<void> => {
  let database: "operational" | "degraded" = "operational";
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    database = "degraded";
  }

  res.json({
    checkedAt: new Date().toISOString(),
    services: [
      { id: "dashboard-api", name: "Dashboard & API", status: "operational", detail: "This live status check is responding." },
      { id: "database", name: "Database", status: database, detail: database === "operational" ? "Database probe succeeded." : "Database probe failed." },
      { id: "bot-hosting", name: "Bot hosting", status: "not_monitored", detail: "Individual bot health is shown in the customer workspace; no aggregate monitor is configured." },
      { id: "web-hosting", name: "Web hosting", status: "not_monitored", detail: "Individual web deployment health is shown in the customer workspace; no aggregate monitor is configured." },
      { id: "payments", name: "PayHero payments", status: "not_monitored", detail: "Payment state is confirmed per transaction through PayHero callbacks; provider availability is not polled here." },
    ],
  });
});

export default router;
