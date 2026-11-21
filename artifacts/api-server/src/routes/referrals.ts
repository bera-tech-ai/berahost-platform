import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAny } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

const router = Router();

router.get("/referrals/my", requireAny("read"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const referralLink = `${process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : ""}/register?ref=${user.referralCode}`;
  const [countResult, recentResult] = await Promise.all([
    db.execute(sql`SELECT COUNT(*)::int AS total FROM referrals WHERE referrer_id = ${user.id}`),
    db.execute(sql`SELECT id, created_at FROM referrals WHERE referrer_id = ${user.id} ORDER BY created_at DESC LIMIT 50`),
  ]);
  const totalReferrals = Number((countResult.rows[0] as any)?.total ?? 0);
  res.json({
    referralCode: user.referralCode,
    referralLink,
    totalReferrals,
    referrals: (recentResult.rows as any[]).map((row) => ({ id: row.id, createdAt: row.created_at })),
  });
});

router.post("/referrals/apply", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const referralCode = typeof req.body?.referralCode === "string" ? req.body.referralCode.trim() : "";
  if (!referralCode) { res.status(400).json({ error: "Referral code is required" }); return; }

  const existing = await db.execute(sql`SELECT id FROM referrals WHERE referred_id = ${user.id} LIMIT 1`);
  if ((existing.rows as any[]).length > 0) {
    res.status(400).json({ error: "You have already used a referral code" });
    return;
  }

  const [referrer] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.referralCode, referralCode));
  if (!referrer) { res.status(404).json({ error: "Invalid referral code" }); return; }
  if (referrer.id === user.id) { res.status(400).json({ error: "You cannot refer yourself" }); return; }

  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ referredBy: referrer.id }).where(eq(usersTable.id, user.id));
    await tx.execute(sql`INSERT INTO referrals (referrer_id, referred_id, coins_awarded) VALUES (${referrer.id}, ${user.id}, 0)`);
  });
  logger.info({ referrerId: referrer.id, referredId: user.id }, "Referral applied");
  res.json({ message: "Referral applied successfully." });
});

export default router;
