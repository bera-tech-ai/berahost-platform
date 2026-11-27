import { Router } from "express";
import crypto from "crypto";
import dns from "dns/promises";
import { db, webDeploymentsTable, domainOrdersTable, usersTable, deploymentsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireAny } from "../middlewares/requireAuth";
import { getPlan, isSubscriptionActive } from "../lib/subscriptions";
import { deleteWebDeployment, generateSlug, normalizeGithubUrl, startWebDeployment, stopWebDeployment } from "../lib/webProcess";
import { decryptGithubToken, ensureWebDeploymentWebhook, getGithubRepository, githubRepoUrl, managedGithubWebhookUrl, removeWebDeploymentWebhook, withRequestOrigin } from "../lib/github";
import { logger } from "../lib/logger";

const router = Router();
const MANAGED_PUBLIC_URL = "https://berahost-gbyspbc3.manus.space";
function publicUrl(slug: string) {
  const base = (process.env.PUBLIC_URL || process.env.FRONTEND_URL || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "") || MANAGED_PUBLIC_URL).replace(/\/$/, "");
  return `${base}/web/${slug}`;
}
function serialize(row: any, apiKeySafe = false, req?: { protocol: string; get(name: string): string | undefined }) {
  const { envVars, ...safeRow } = row;
  // Rebase the minted URL onto the requesting host at read time — the
  // public origin changes across redeploys, so a URL minted under a
  // previous host would otherwise point at a dead origin.
  return { ...(apiKeySafe ? safeRow : row), ...(apiKeySafe ? {} : { envVars: envVars || {} }), scannedVars: row.scannedVars || [], publicUrl: withRequestOrigin(publicUrl(row.slug), req), createdAt: row.createdAt?.toISOString?.() ?? row.createdAt, updatedAt: row.updatedAt?.toISOString?.() ?? null, expiresAt: row.expiresAt?.toISOString?.() ?? null };
}
async function activeUser(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user || user.isBanned || user.deletedAt) return null;
  if (user.isAdmin) return { user, plan: { id: "admin", name: "Administrator", maxDeployments: 9999, maxBots: 9999, maxWebApps: 9999, priceKes: 0, features: ["Administrator access"] } };
  return isSubscriptionActive(user) ? { user, plan: getPlan(user.subscriptionPlan) } : null;
}

router.get("/web-deployments", requireAny("read"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const rows = await db.select().from(webDeploymentsTable).where(eq(webDeploymentsTable.userId, user.id)).orderBy(desc(webDeploymentsTable.createdAt));
  res.json(rows.map((row) => serialize(row, Boolean((req as any).apiKey), req)));
});

router.get("/web-deployments/:id", requireAny("read"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const [row] = await db.select().from(webDeploymentsTable).where(and(eq(webDeploymentsTable.id, id), eq(webDeploymentsTable.userId, user.id)));
  if (!row) { res.status(404).json({ error: "Web deployment not found" }); return; }
  res.json(serialize(row, Boolean((req as any).apiKey), req));
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
  const selectedRepo = req.body?.githubRepo && typeof req.body.githubRepo === "object" ? req.body.githubRepo : null;
  let repoUrl = normalizeGithubUrl(req.body?.repoUrl);
  let githubRepoId: number | null = null;
  let githubFullName: string | null = null;
  let githubPrivate = false;
  let defaultBranch = "main";
  if (selectedRepo?.fullName) {
    const token = decryptGithubToken(entitlement.user.githubAccessTokenEncrypted);
    if (!token) { res.status(409).json({ error: "Connect GitHub before deploying a selected repository." }); return; }
    try {
      const verified = await getGithubRepository(token, String(selectedRepo.fullName));
      repoUrl = githubRepoUrl(verified.fullName);
      githubRepoId = verified.id;
      githubFullName = verified.fullName;
      githubPrivate = verified.private;
      defaultBranch = verified.defaultBranch;
    } catch (error: any) {
      res.status(403).json({ error: error?.message || "You do not have access to this GitHub repository." });
      return;
    }
  }
  if (!repoUrl) { res.status(400).json({ error: "Choose a connected GitHub repository or enter a public GitHub repository URL." }); return; }
  const branch = String(req.body?.branch || defaultBranch).trim();
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.includes("..")) { res.status(400).json({ error: "Invalid branch name" }); return; }
  const existing = await db.select({ id: webDeploymentsTable.id }).from(webDeploymentsTable).where(eq(webDeploymentsTable.userId, user.id));
  if (existing.length >= entitlement.plan.maxWebApps) { res.status(403).json({ error: `${entitlement.plan.name} supports up to ${entitlement.plan.maxWebApps} web apps.`, limit: entitlement.plan.maxWebApps }); return; }
  const envVars = typeof req.body?.envVars === "object" && req.body.envVars ? req.body.envVars : {};
  const autoDeploy = Boolean(selectedRepo) && req.body?.autoDeploy !== false;
  const [row] = await db.insert(webDeploymentsTable).values({ userId: user.id, repoUrl, githubRepoId, githubFullName, githubPrivate, branch, customName: typeof req.body?.customName === "string" ? req.body.customName.trim().slice(0, 100) || null : null, slug: generateSlug(), buildCommand: typeof req.body?.buildCommand === "string" ? req.body.buildCommand.trim() || null : null, startCommand: typeof req.body?.startCommand === "string" ? req.body.startCommand.trim() || null : null, envVars, expiresAt: user.subscriptionExpiresAt, status: "queued", autoDeploy }).returning();
  let automationWarning: string | undefined;
  if (autoDeploy) {
    try { await ensureWebDeploymentWebhook(row.id, managedGithubWebhookUrl(req as any)); }
    catch (error: any) {
      automationWarning = error?.message || "Automatic deployment could not be enabled.";
      await db.update(webDeploymentsTable).set({ autoDeploy: false, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, row.id));
      row.autoDeploy = false;
    }
  }
  startWebDeployment(row.id).catch((err) => logger.error({ err, webDeploymentId: row.id }, "Web deployment start failed"));
  res.status(201).json({ ...serialize(row, Boolean((req as any).apiKey), req), automationWarning });
});

router.patch("/web-deployments/:id", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const [row] = await db.select().from(webDeploymentsTable).where(and(eq(webDeploymentsTable.id, id), eq(webDeploymentsTable.userId, user.id)));
  if (!row) { res.status(404).json({ error: "Web deployment not found" }); return; }
  const nextAutoDeploy = req.body?.autoDeploy === undefined ? row.autoDeploy : Boolean(req.body.autoDeploy);
  const nextBranch = req.body?.branch === undefined ? row.branch : String(req.body.branch).trim();
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(nextBranch) || nextBranch.includes("..")) { res.status(400).json({ error: "Invalid branch name" }); return; }
  if (row.autoDeploy && (!nextAutoDeploy || nextBranch !== row.branch)) await removeWebDeploymentWebhook(id).catch(() => {});
  const [updated] = await db.update(webDeploymentsTable).set({ branch: nextBranch, autoDeploy: nextAutoDeploy, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id)).returning();
  let automationWarning: string | undefined;
  if (nextAutoDeploy) {
    try { await ensureWebDeploymentWebhook(id, managedGithubWebhookUrl(req as any)); }
    catch (error: any) { automationWarning = error?.message || "Automatic deployment could not be enabled."; await db.update(webDeploymentsTable).set({ autoDeploy: false }).where(eq(webDeploymentsTable.id, id)); updated.autoDeploy = false; }
  }
  res.json({ ...serialize(updated, Boolean((req as any).apiKey), req), automationWarning });
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

router.delete("/web-deployments/:id", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const [row] = await db.select({ id: webDeploymentsTable.id }).from(webDeploymentsTable).where(and(eq(webDeploymentsTable.id, id), eq(webDeploymentsTable.userId, user.id)));
  if (!row) { res.status(404).json({ error: "Web deployment not found" }); return; }

  await deleteWebDeployment(id);
  await removeWebDeploymentWebhook(id).catch(() => {});
  await db.delete(domainOrdersTable).where(and(eq(domainOrdersTable.webDeploymentId, id), eq(domainOrdersTable.userId, user.id)));
  await db.delete(webDeploymentsTable).where(and(eq(webDeploymentsTable.id, id), eq(webDeploymentsTable.userId, user.id)));
  res.json({ message: "Web deployment deleted" });
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
    if (!verified) { res.status(400).json({ verified: false, error: `Add a TXT record at _berahost.${order.hostname} using the verification token returned when this domain request was created, then try again.` }); return; }
    await db.update(domainOrdersTable).set({ status: "active", verifiedAt: new Date(), updatedAt: new Date() }).where(eq(domainOrdersTable.id, order.id));
    res.json({ verified: true, message: "Domain verified and routed to your hosted web deployment." });
  } catch {
    res.status(400).json({ verified: false, error: `DNS record not found. Add a TXT record at _berahost.${order.hostname} using the verification token returned when this domain request was created, then try again.` });
  }
});

export default router;
