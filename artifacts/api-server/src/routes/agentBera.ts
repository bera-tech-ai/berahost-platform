import { Router } from "express";
import { db, agentBuildsTable, usersTable, webDeploymentsTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAny } from "../middlewares/requireAuth";
import { getPlan, isSubscriptionActive } from "../lib/subscriptions";
import { decryptGithubToken } from "../lib/github";
import { runAgentBuild } from "../lib/agentBuild";
import { logger } from "../lib/logger";

const router = Router();
const MANAGED_PUBLIC_URL = "https://berahost-cywge4uc.manus.space";
function publicUrl(slug: string) {
  const base = (process.env.PUBLIC_URL || process.env.FRONTEND_URL || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "") || MANAGED_PUBLIC_URL).replace(/\/$/, "");
  return `${base}/web/${slug}`;
}

// Same entitlement rule as web deployments: an active subscription, with
// the plan's web-app allowance as the ceiling.
async function activeUser(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user || user.isBanned || user.deletedAt) return null;
  if (user.isAdmin) return { user, plan: { id: "admin", name: "Administrator", maxDeployments: 9999, maxBots: 9999, maxWebApps: 9999, priceKes: 0, features: ["Administrator access"] } };
  return isSubscriptionActive(user) ? { user, plan: getPlan(user.subscriptionPlan) } : null;
}

function serialize(build: any, deployment?: { slug: string; status: string } | null) {
  // A build whose deployment has come up is live, even if the build's own
  // wait loop timed out before it saw the deployment running.
  const live = Boolean(deployment && deployment.status === "running");
  return {
    id: build.id,
    prompt: build.prompt,
    name: build.name,
    status: live && ["deploying", "verifying"].includes(build.status) ? "live" : build.status,
    error: build.error,
    plan: build.plan ?? null,
    // Only the variable NAMES are ever returned — values are secrets and
    // stay server-side (sandbox tests + the deployment's env).
    envVarKeys: build.envVars && typeof build.envVars === "object" ? Object.keys(build.envVars) : [],
    testResults: build.testResults ?? null,
    liveCheck: build.liveCheck ?? null,
    buildLog: build.buildLog ?? null,
    repoUrl: build.repoUrl,
    repoFullName: build.repoFullName,
    webDeploymentId: build.webDeploymentId,
    deploymentStatus: deployment?.status ?? null,
    publicUrl: deployment ? publicUrl(deployment.slug) : null,
    createdAt: build.createdAt?.toISOString?.() ?? build.createdAt,
    updatedAt: build.updatedAt?.toISOString?.() ?? null
  };
}

async function deploymentsById(ids: number[]) {
  if (!ids.length) return new Map<number, { slug: string; status: string }>();
  const rows = await db.select({ id: webDeploymentsTable.id, slug: webDeploymentsTable.slug, status: webDeploymentsTable.status })
    .from(webDeploymentsTable).where(inArray(webDeploymentsTable.id, ids));
  return new Map(rows.map(r => [r.id, { slug: r.slug, status: r.status }]));
}

router.get("/agent-bera/builds", requireAny("read"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const builds = await db.select().from(agentBuildsTable).where(eq(agentBuildsTable.userId, user.id)).orderBy(desc(agentBuildsTable.createdAt));
  const deps = await deploymentsById(builds.map(b => b.webDeploymentId).filter((x): x is number => typeof x === "number"));
  res.json(builds.map(b => serialize(b, b.webDeploymentId ? deps.get(b.webDeploymentId) : null)));
});

router.post("/agent-bera/builds", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const entitlement = await activeUser(user.id);
  if (!entitlement) { res.status(402).json({ error: "An active monthly subscription is required before Agent Bera can build for you." }); return; }
  const prompt = String(req.body?.prompt || "").trim();
  if (prompt.length < 8) { res.status(400).json({ error: "Describe the website you want in a sentence or two." }); return; }
  if (prompt.length > 2000) { res.status(400).json({ error: "That description is too long — keep it under 2,000 characters." }); return; }
  const token = decryptGithubToken(entitlement.user.githubAccessTokenEncrypted);
  if (!token) { res.status(409).json({ error: "Connect GitHub first — Agent Bera publishes the site it builds to your GitHub account.", code: "GITHUB_NOT_CONNECTED" }); return; }

  // Capacity: finished deployments plus builds already in flight must stay
  // within the plan's web-app allowance — a build becomes a deployment.
  const existing = await db.select({ id: webDeploymentsTable.id }).from(webDeploymentsTable).where(eq(webDeploymentsTable.userId, user.id));
  const inFlight = await db.select({ id: agentBuildsTable.id }).from(agentBuildsTable)
    .where(and(eq(agentBuildsTable.userId, user.id), inArray(agentBuildsTable.status, ["planning", "generating", "testing", "publishing", "deploying", "verifying"])));
  if (existing.length + inFlight.length >= entitlement.plan.maxWebApps) {
    res.status(403).json({ error: `${entitlement.plan.name} supports up to ${entitlement.plan.maxWebApps} web apps.`, limit: entitlement.plan.maxWebApps });
    return;
  }

  // Optional environment variables for the built app (e.g. DATABASE_URL).
  // The agent plans and codes around the variable NAMES; the values are
  // passed to the sandbox endpoint tests and stored on the deployment,
  // and are never returned by the API again.
  let envVars: Record<string, string> = {};
  if (req.body?.envVars !== undefined) {
    const raw = req.body.envVars;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { res.status(400).json({ error: "envVars must be an object of KEY: value pairs." }); return; }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > 30) { res.status(400).json({ error: "At most 30 environment variables per build." }); return; }
    for (const [key, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) { res.status(400).json({ error: `Invalid environment variable name: ${key}` }); return; }
      if (typeof value !== "string" || value.length > 4096) { res.status(400).json({ error: `Invalid value for ${key} — values are text up to 4,096 characters.` }); return; }
      envVars[key] = value;
    }
  }

  const name = prompt.replace(/\s+/g, " ").slice(0, 60);
  const [build] = await db.insert(agentBuildsTable).values({ userId: user.id, prompt, name, status: "planning", envVars }).returning();
  runAgentBuild(build.id).catch((err) => logger.error({ err, buildId: build.id }, "Agent Bera build crashed"));
  res.status(202).json(serialize(build, null));
});

export default router;
