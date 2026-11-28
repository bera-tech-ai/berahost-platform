import { Router } from "express";
import { db, agentBuildsTable, usersTable, webDeploymentsTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAny } from "../middlewares/requireAuth";
import { getPlan, isSubscriptionActive } from "../lib/subscriptions";
import { decryptGithubToken, withRequestOrigin } from "../lib/github";
import { runAgentBuild, runAgentEdit } from "../lib/agentBuild";
import { assertPublicUrl } from "../lib/agentExplore";
import { startWebDeployment } from "../lib/webProcess";
import { logger } from "../lib/logger";

const router = Router();
const MANAGED_PUBLIC_URL = "https://berahost-gbyspbc3.manus.space";
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

function serialize(build: any, deployment?: { slug: string; status: string } | null, req?: { protocol: string; get(name: string): string | undefined }) {
  // A build whose deployment has come up is live, even if the build's own
  // wait loop timed out before it saw the deployment running.
  const live = Boolean(deployment && deployment.status === "running");
  // URLs are rebased onto the requesting host at read time: the public
  // origin changes across redeploys, and previously minted URLs (and the
  // live check's stored URL) would otherwise point at a dead host.
  const liveCheck = build.liveCheck && typeof build.liveCheck === "object"
    ? { ...build.liveCheck, url: withRequestOrigin(build.liveCheck.url, req) }
    : build.liveCheck ?? null;
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
    liveCheck,
    buildLog: build.buildLog ?? null,
    parentId: build.parentId ?? null,
    builtinDb: Boolean(build.builtinDb),
    apiUrl: (build as any).apiUrl ?? null,
    repoUrl: build.repoUrl,
    repoFullName: build.repoFullName,
    webDeploymentId: build.webDeploymentId,
    deploymentStatus: deployment?.status ?? null,
    publicUrl: deployment ? withRequestOrigin(publicUrl(deployment.slug), req) : null,
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
  res.json(builds.map(b => serialize(b, b.webDeploymentId ? deps.get(b.webDeploymentId) : null, req)));
});

// Shared env-var validation: an object of KEY: value pairs, names like
// shell identifiers, values capped. Returns null + message on bad input.
function validateEnvVars(raw: unknown): { envVars: Record<string, string> } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "envVars must be an object of KEY: value pairs." };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 30) return { error: "At most 30 environment variables per build." };
  const envVars: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) return { error: `Invalid environment variable name: ${key}` };
    if (typeof value !== "string" || value.length > 4096) return { error: `Invalid value for ${key} — values are text up to 4,096 characters.` };
    envVars[key] = value;
  }
  return { envVars };
}

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
    const checked = validateEnvVars(req.body.envVars);
    if ("error" in checked) { res.status(400).json({ error: checked.error }); return; }
    envVars = checked.envVars;
  }
  const builtinDb = req.body?.useBuiltinDb === true;
  if (builtinDb && envVars.DATABASE_URL) { res.status(400).json({ error: "Choose either a built-in database or your own DATABASE_URL, not both." }); return; }
  let apiUrl: string | null = null;
  if (req.body?.apiUrl !== undefined && String(req.body.apiUrl).trim() !== "") {
    try { apiUrl = (await assertPublicUrl(String(req.body.apiUrl))).toString(); }
    catch (e: any) { res.status(400).json({ error: e?.message || "That API URL cannot be used." }); return; }
  }

  const name = prompt.replace(/\s+/g, " ").slice(0, 60);
  const [build] = await db.insert(agentBuildsTable).values({ userId: user.id, prompt, name, status: "planning", envVars, builtinDb, apiUrl } as any).returning();
  runAgentBuild(build.id).catch((err) => logger.error({ err, buildId: build.id }, "Agent Bera build crashed"));
  res.status(202).json(serialize(build, null, req));
});

// Edit an existing live app in place. The edit is its own build row
// (parentId -> the original) that reuses the original's repo, deployment,
// plan and env vars; runAgentEdit applies the same test gate before
// anything is pushed.
router.post("/agent-bera/builds/:id/edit", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const entitlement = await activeUser(user.id);
  if (!entitlement) { res.status(402).json({ error: "An active monthly subscription is required before Agent Bera can edit for you." }); return; }
  const instruction = String(req.body?.instruction || "").trim();
  if (instruction.length < 3) { res.status(400).json({ error: "Describe the change you want in a sentence." }); return; }
  if (instruction.length > 1000) { res.status(400).json({ error: "That instruction is too long — keep it under 1,000 characters." }); return; }
  const token = decryptGithubToken(entitlement.user.githubAccessTokenEncrypted);
  if (!token) { res.status(409).json({ error: "Connect GitHub first — Agent Bera updates the app in your GitHub account.", code: "GITHUB_NOT_CONNECTED" }); return; }
  const parentId = Number(req.params.id);
  const [parent] = await db.select().from(agentBuildsTable).where(and(eq(agentBuildsTable.id, parentId), eq(agentBuildsTable.userId, user.id)));
  if (!parent) { res.status(404).json({ error: "Build not found." }); return; }
  const root = parent.parentId ? await db.select().from(agentBuildsTable).where(eq(agentBuildsTable.id, parent.parentId)).then(r => r[0]) : parent;
  if (!root?.repoFullName || !root.webDeploymentId) { res.status(409).json({ error: "This app is not live yet — only a live app can be edited." }); return; }
  const [edit] = await db.insert(agentBuildsTable).values({
    userId: user.id,
    prompt: instruction,
    name: root.name,
    status: "planning",
    parentId: root.id,
    plan: root.plan as any,
    envVars: root.envVars as any,
    builtinDb: root.builtinDb,
    apiUrl: (root as any).apiUrl ?? null,
    repoUrl: root.repoUrl,
    repoFullName: root.repoFullName,
    webDeploymentId: root.webDeploymentId
  }).returning();
  runAgentEdit(edit.id).catch((err) => logger.error({ err, buildId: edit.id }, "Agent Bera edit crashed"));
  res.status(202).json(serialize(edit, null, req));
});

// Replace a live app's environment variables and restart it with the new
// set. Values are write-only: the response carries names only, like every
// other build response. The built-in DATABASE_URL (when the app has one)
// is platform-managed and cannot be removed here.
router.patch("/agent-bera/builds/:id/env", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const entitlement = await activeUser(user.id);
  if (!entitlement) { res.status(402).json({ error: "An active monthly subscription is required to change an app's variables." }); return; }
  const checked = validateEnvVars(req.body?.envVars);
  if ("error" in checked) { res.status(400).json({ error: checked.error }); return; }
  const id = Number(req.params.id);
  const [build] = await db.select().from(agentBuildsTable).where(and(eq(agentBuildsTable.id, id), eq(agentBuildsTable.userId, user.id)));
  if (!build) { res.status(404).json({ error: "Build not found." }); return; }
  const root = build.parentId ? await db.select().from(agentBuildsTable).where(eq(agentBuildsTable.id, build.parentId)).then(r => r[0]) : build;
  if (!root?.webDeploymentId) { res.status(409).json({ error: "This app has no deployment yet — variables are set when it is built." }); return; }
  const next: Record<string, string> = { ...checked.envVars };
  const current = root.envVars && typeof root.envVars === "object" ? root.envVars as Record<string, string> : {};
  if (root.builtinDb && current.DATABASE_URL && !next.DATABASE_URL) next.DATABASE_URL = current.DATABASE_URL;
  if ((root as any).apiUrl) next.EXTERNAL_API_URL = String((root as any).apiUrl);
  await db.update(agentBuildsTable).set({ envVars: next, updatedAt: new Date() }).where(eq(agentBuildsTable.id, root.id));
  await db.update(webDeploymentsTable).set({ envVars: next, status: "queued", updatedAt: new Date() }).where(eq(webDeploymentsTable.id, root.webDeploymentId));
  startWebDeployment(root.webDeploymentId).catch((err) => logger.error({ err, webDeploymentId: root.webDeploymentId }, "Agent Bera env-change restart failed"));
  const [updated] = await db.select().from(agentBuildsTable).where(eq(agentBuildsTable.id, root.id));
  const [dep] = await db.select({ slug: webDeploymentsTable.slug, status: webDeploymentsTable.status }).from(webDeploymentsTable).where(eq(webDeploymentsTable.id, root.webDeploymentId));
  res.json(serialize(updated, dep ?? null, req));
});

export default router;
