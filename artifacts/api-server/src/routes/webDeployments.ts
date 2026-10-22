import { Router } from "express";
import crypto from "crypto";
import dns from "dns/promises";
import { db, webDeploymentsTable, domainOrdersTable, usersTable, deploymentsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireAny } from "../middlewares/requireAuth";
import { getPlan, isSubscriptionActive } from "../lib/subscriptions";
import { generateSlug, normalizeGithubUrl, startWebDeployment, stopWebDeployment } from "../lib/webProcess";
import { logger } from "../lib/logger";

const router = Router();
function publicUrl(slug: string) {
  const base = (process.env.PUBLIC_URL || process.env.FRONTEND_URL || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "")).replace(/\/$/, "");
  return `${base}/web/${slug}`;
}
function serialize(row: any) {
  return { ...row, envVars: row.envVars || {}, scannedVars: row.scannedVars || [], publicUrl: publicUrl(row.slug), createdAt: row.createdAt?.toISOString?.() ?? row.createdAt, updatedAt: row.updatedAt?.toISOString?.() ?? null, expiresAt: row.expiresAt?.toISOString?.() ?? null };
}
async function activeUser(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user || user.isBanned || user.deletedAt) return null;
  if (user.isAdmin) return { user, plan: { id: "admin", name: "Administrator", maxDeployments: 9999, priceKes: 0, features: ["Administrator access"] } };
  return isSubscriptionActive(user) ? { user, plan: getPlan(user.subscriptionPlan) } : null;
}

router.get("/web-deployments", requireAny("read"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const rows = await db.select().from(webDeploymentsTable).where(eq(webDeploymentsTable.userId, user.id)).orderBy(desc(webDeploymentsTable.createdAt));
  res.json(rows.map(serialize));
});

router.get("/web-deployments/:id", requireAny("read"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const [row] = await db.select().from(webDeploymentsTable).where(and(eq(webDeploymentsTable.id, id), eq(webDeploymentsTable.userId, user.id)));
  if (!row) { res.status(404).json({ error: "Web deployment not found" }); return; }
  res.json(serialize(row));
});

router.post("/web-deployments/scan", requireAny("write"), async (req, res): Promise<void> => {
  const repoUrl = normalizeGithubUrl(req.body?.repoUrl);
  if (!repoUrl) { res.status(400).json({ error: "Enter a public GitHub repository URL such as https://github.com/owner/repository" }); return; }
  res.json({ repoUrl, message: "Environment variables are scanned during the first build. Add values only for the variables your project requires." });
});

router.post("/web-deployments", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const entitlement = await activeUser(user.id);
  if (!entitlement) { res.status(402).json({ error: "An active monthly subscription is required before deploying a web application." }); return; }
  const repoUrl = normalizeGithubUrl(req.body?.repoUrl);
  if (!repoUrl) { res.status(400).json({ error: "Only public GitHub repository URLs are supported." }); return; }
  const branch = String(req.body?.branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.includes("..")) { res.status(400).json({ error: "Invalid branch name" }); return; }
  const existing = await db.select({ id: webDeploymentsTable.id }).from(webDeploymentsTable).where(eq(webDeploymentsTable.userId, user.id));
  const botRows = await db.select({ id: deploymentsTable.id }).from(deploymentsTable).where(eq(deploymentsTable.userId, user.id));
  if (existing.length + botRows.length >= entitlement.plan.maxDeployments) { res.status(403).json({ error: `${entitlement.plan.name} supports up to ${entitlement.plan.maxDeployments} hosted deployments.`, limit: entitlement.plan.maxDeployments }); return; }
  const envVars = typeof req.body?.envVars === "object" && req.body.envVars ? req.body.envVars : {};
  const [row] = await db.insert(webDeploymentsTable).values({ userId: user.id, repoUrl, branch, customName: typeof req.body?.customName === "string" ? req.body.customName.trim().slice(0, 100) || null : null, slug: generateSlug(), buildCommand: typeof req.body?.buildCommand === "string" ? req.body.buildCommand.trim() || null : null, startCommand: typeof req.body?.startCommand === "string" ? req.body.startCommand.trim() || null : null, envVars, expiresAt: user.subscriptionExpiresAt, status: "queued" }).returning();
  startWebDeployment(row.id).catch((err) => logger.error({ err, webDeploymentId: row.id }, "Web deployment start failed"));
  res.status(201).json(serialize(row));
});

router.post("/web-deployments/:id/start", requireAny("write"), async (req, res): Promise<void> => {
  const user = (await activeUser((req as any).user.id));
  if (!user) { res.status(402).json({ error: "Your subscription is inactive. Renew to start this web deployment." }); return; }
  const id = Number(req.params.id);
  const [row] = await db.select().from(webDeploymentsTable).where(and(eq(webDeploymentsTable.id, id), eq(webDeploymentsTable.userId, user.user.id)));
  if (!row) { res.status(404).json({ error: "Web deployment not found" }); return; }
  await db.update(webDeploymentsTable).set({ expiresAt: user.user.subscriptionExpiresAt, status: "queued", updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
  startWebDeployment(id).catch((err) => logger.error({ err, webDeploymentId: id }, "Web deployment restart failed"));
  res.json({ message: "Web deployment starting" });
});

router.post("/web-deployments/:id/stop", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const [row] = await db.select().from(webDeploymentsTable).where(and(eq(webDeploymentsTable.id, id), eq(webDeploymentsTable.userId, user.id)));
  if (!row) { res.status(404).json({ error: "Web deployment not found" }); return; }
  await stopWebDeployment(id);
  res.json({ message: "Web deployment stopped" });
});

router.post("/web-deployments/:id/domains", requireAny("payments"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const entitlement = await activeUser(user.id);
  if (!entitlement || (!user.isAdmin && entitlement.plan.id !== "gold")) { res.status(403).json({ error: "Custom domain requests are available on the Gold plan." }); return; }
  const id = Number(req.params.id);
  const hostname = String(req.body?.hostname || "").trim().toLowerCase();
  if (!/^(?=.{4,255}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) { res.status(400).json({ error: "Enter a valid domain name" }); return; }
  const [deployment] = await db.select().from(webDeploymentsTable).where(and(eq(webDeploymentsTable.id, id), eq(webDeploymentsTable.userId, user.id)));
  if (!deployment) { res.status(404).json({ error: "Web deployment not found" }); return; }
  const token = `bera-verify-${crypto.randomBytes(16).toString("hex")}`;
  const adminFree = Boolean(user.isAdmin);
  const [order] = await db.insert(domainOrdersTable).values({ userId: user.id, webDeploymentId: id, hostname, priceKes: adminFree ? 0 : 134, verificationToken: token, status: adminFree ? "paid" : "pending" }).returning();
  res.status(201).json({ id: order.id, hostname, amountKes: adminFree ? 0 : 134, adminFree, verificationToken: token, message: adminFree ? "Domain request created for the administrator at no charge. Add the verification TXT record shown here." : "Domain request created. Complete the KES 134 PayHero payment, then add the verification TXT record shown here." });
});

router.post("/web-deployments/domains/:id/verify", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const [order] = await db.select().from(domainOrdersTable).where(and(eq(domainOrdersTable.id, id), eq(domainOrdersTable.userId, user.id)));
  if (!order) { res.status(404).json({ error: "Domain order not found" }); return; }
  if (order.status !== "paid") { res.status(400).json({ error: "The domain order must be paid before verification." }); return; }
  try {
    const records = await dns.resolveTxt(`_berahost.${order.hostname}`);
    const verified = records.flat().some((record) => record === order.verificationToken);
    if (!verified) { res.status(400).json({ verified: false, error: `Add a TXT record at _berahost.${order.hostname} with value ${order.verificationToken}, then try again.` }); return; }
    await db.update(domainOrdersTable).set({ status: "active", verifiedAt: new Date(), updatedAt: new Date() }).where(eq(domainOrdersTable.id, order.id));
    res.json({ verified: true, message: "Domain verified and routed to your hosted web deployment." });
  } catch {
    res.status(400).json({ verified: false, error: `DNS record not found. Add a TXT record at _berahost.${order.hostname} with value ${order.verificationToken}, then try again.` });
  }
});

export default router;
