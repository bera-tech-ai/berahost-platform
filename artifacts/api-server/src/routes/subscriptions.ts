import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { FREE_PLAN, SUBSCRIPTION_PLANS, getPlan, isSubscriptionActive } from "../lib/subscriptions";

const router = Router();
router.get("/subscriptions/plans", async (_req, res): Promise<void> => {
  res.json([FREE_PLAN, ...Object.values(SUBSCRIPTION_PLANS).map((plan) => ({ ...plan, billing: "monthly", botLimit: plan.maxDeployments, webLimit: plan.maxDeployments }))]);
});
router.get("/subscriptions/status", requireAuth, async (req, res): Promise<void> => {
  const user = (req as any).user;
  const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.id));
  const active = !!dbUser && isSubscriptionActive(dbUser);
  res.json({ plan: dbUser ? getPlan(dbUser.subscriptionPlan).id : "free", planDetails: dbUser ? getPlan(dbUser.subscriptionPlan) : FREE_PLAN, expiresAt: dbUser?.subscriptionExpiresAt?.toISOString() ?? null, isActive: active, billing: "monthly" });
});
router.post("/subscriptions/subscribe", requireAuth, async (_req, res): Promise<void> => {
  res.status(410).json({ error: "Use the PayHero subscription checkout from the subscription page." });
});
export default router;
