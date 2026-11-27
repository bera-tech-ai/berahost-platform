import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { db, agentBuildsTable, usersTable, webDeploymentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createGithubRepository, createRepositoryFile, getRepositoryFile, upsertRepositoryFile, decryptGithubToken, githubRepoUrl } from "./github";
import { planProject, generateProjectFiles, repairBackendServer, editProjectFiles, GENERATED_STORE, slugify, type AgentProjectPlan } from "./agentAi";
import { writeProjectFiles, testProject, runLiveCheck, type TestReport, type LiveCheckReport } from "./agentTest";
import { provisionBuiltinDb } from "./agentDb";
import { generateSlug, startWebDeployment } from "./webProcess";
import { logger } from "./logger";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const MANAGED_PUBLIC_URL = "https://berahost-cywge4uc.manus.space";
function publicUrlFor(slug: string) {
  const base = (process.env.PUBLIC_URL || process.env.FRONTEND_URL || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "") || MANAGED_PUBLIC_URL).replace(/\/$/, "");
  return `${base}/web/${slug}`;
}

async function setBuild(id: number, patch: Record<string, any>): Promise<void> {
  await db.update(agentBuildsTable).set({ ...patch, updatedAt: new Date() }).where(eq(agentBuildsTable.id, id)).catch(() => {});
}

function failureSummary(report: TestReport): string {
  return report.results.filter(r => !r.ok).map(r => `${r.name}: ${r.detail}`).join("\n") + "\n" + report.log;
}

function envOf(build: any): Record<string, string> {
  return build.envVars && typeof build.envVars === "object" && !Array.isArray(build.envVars) ? build.envVars as Record<string, string> : {};
}

// Wait until a deployment reports running; returns its slug, or null when
// it is still starting after the wait (the build then stays "deploying").
async function waitForDeployment(deploymentId: number, timeoutMs = 300000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(6000);
    const [dep] = await db.select({ status: webDeploymentsTable.status, slug: webDeploymentsTable.slug }).from(webDeploymentsTable).where(eq(webDeploymentsTable.id, deploymentId));
    if (!dep) return null;
    if (dep.status === "running") return dep.slug;
    if (["failed", "crashed", "stopped"].includes(dep.status)) {
      throw new Error("The app passed its endpoint tests and was published, but its BeraHost deployment failed to start. Open the deployment to see its build log.");
    }
  }
  return null;
}

async function restartDeployment(deploymentId: number): Promise<void> {
  await db.update(webDeploymentsTable).set({ status: "queued", updatedAt: new Date() }).where(eq(webDeploymentsTable.id, deploymentId));
  startWebDeployment(deploymentId).catch((err) => logger.error({ err, webDeploymentId: deploymentId }, "Agent Bera web deployment restart failed"));
}

function liveFailureText(live: LiveCheckReport): string {
  const parts = live.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`);
  if (live.browser.consoleErrors?.length) parts.push(`Browser console errors: ${live.browser.consoleErrors.join(" | ")}`);
  return parts.join("\n") || "The live check failed without a specific failing check.";
}

type VerifyCtx = {
  buildId: number;
  prompt: string;
  plan: AgentProjectPlan;
  envVars: Record<string, string>;
  token: string;
  repoFullName: string;
  deploymentId: number;
  files: Record<string, string>;
  note: (line: string) => Promise<void>;
};

// Post-deploy verification with ONE repair attempt: when the live check
// fails, the backend is repaired against the live failures, the repair
// must pass the same sandbox gate as a fresh build, and only then is it
// pushed to the repo and redeployed. A repair that fails the gate changes
// nothing — the original live check stays on the build, honestly.
async function verifyWithRepair(ctx: VerifyCtx, slug: string): Promise<LiveCheckReport> {
  const url = publicUrlFor(slug);
  // Give the proxy a moment to route the freshly started app.
  await sleep(5000);
  let live = await runLiveCheck(url, ctx.plan.endpoints);
  if (live.ok) return live;
  await ctx.note(`Live check failed at ${url} — attempting one post-deploy repair`);
  let tmpDir: string | null = null;
  try {
    const repaired = await repairBackendServer(ctx.prompt, ctx.plan, ctx.files["server.js"], "The app is DEPLOYED and live, but its live verification failed:\n" + liveFailureText(live), Object.keys(ctx.envVars));
    const candidate = { ...ctx.files, "server.js": repaired };
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bera-live-"));
    await writeProjectFiles(tmpDir, candidate);
    const gate = await testProject(tmpDir, candidate, ctx.plan.endpoints, ctx.envVars);
    if (!gate.ok) {
      await ctx.note("Post-deploy repair did not pass the endpoint tests, so the live app was left unchanged");
      return live;
    }
    await upsertRepositoryFile(ctx.token, ctx.repoFullName, "server.js", repaired, "Fix live verification failures (Agent Bera post-deploy repair)");
    ctx.files["server.js"] = repaired;
    await ctx.note("Post-deploy repair passed its tests — redeploying");
    await restartDeployment(ctx.deploymentId);
    const slug2 = await waitForDeployment(ctx.deploymentId);
    if (!slug2) return live;
    await sleep(5000);
    live = await runLiveCheck(publicUrlFor(slug2), ctx.plan.endpoints);
    await ctx.note(live.ok ? `Live check passed after repair at ${publicUrlFor(slug2)}` : "Live check still reports problems after the repair — see the build card");
    return live;
  } catch (e: any) {
    await ctx.note(`Post-deploy repair could not run: ${String(e?.message || e)}`);
    return live;
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The full Agent Bera pipeline:
// plan -> generate a full-stack project (Express backend + API-driven
// frontend, reviewer pass included) -> TEST it in a sandbox (syntax,
// install, boot, every planned API endpoint) with a repair loop -> only
// then publish to a NEW repo in the user's own GitHub account -> deploy
// as a web deployment the user owns -> verify the live URL (HTTP + API +
// real browser), repairing once after deploy if verification fails.
export async function runAgentBuild(buildId: number): Promise<void> {
  const [build] = await db.select().from(agentBuildsTable).where(eq(agentBuildsTable.id, buildId));
  if (!build) return;
  const lines: string[] = [];
  const note = async (line: string) => { lines.push(`[${new Date().toISOString()}] ${line}`); await setBuild(buildId, { buildLog: lines.join("\n") }); };
  let tmpDir: string | null = null;
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, build.userId));
    const token = decryptGithubToken(user?.githubAccessTokenEncrypted);
    if (!user || !token) throw new Error("GitHub is not connected for this account. Connect GitHub, then start the build again.");

    // The user's environment variables for this app (e.g. DATABASE_URL).
    // The agent plans and codes around the NAMES; the values go to the
    // sandbox tests and the deployment, and are never logged or returned.
    const envVars: Record<string, string> = envOf(build);

    // Built-in database: provision an isolated Postgres role + schema in
    // the platform cluster and use its connection string as DATABASE_URL.
    if ((build as any).builtinDb && !envVars.DATABASE_URL) {
      const provisioned = await provisionBuiltinDb(buildId);
      if (provisioned) {
        envVars.DATABASE_URL = provisioned.connectionString;
        await setBuild(buildId, { envVars });
        await note("Built-in database provisioned (isolated Postgres schema for this app)");
      }
    }
    const envKeys = Object.keys(envVars);

    // 1. Plan
    await setBuild(buildId, { status: "planning" });
    const plan: AgentProjectPlan = await planProject(build.prompt, envKeys);
    await setBuild(buildId, { plan, name: plan.appName || build.name });
    await note(`Plan: ${plan.appName} — ${plan.resources.length} resource(s), ${plan.endpoints.length} API endpoints (${plan.endpoints.map(e => `${e.method} ${e.path}`).join(", ")})`);
    if (envKeys.length) await note(`Environment variables provided: ${envKeys.join(", ")}`);

    // 2. Generate the full-stack project
    await setBuild(buildId, { status: "generating" });
    const base = slugify(plan.appName || build.prompt.split(/\s+/).slice(0, 5).join(" "));
    const files = await generateProjectFiles(build.prompt, plan, base, envKeys);
    await note(`Generated ${Object.keys(files).length} files: ${Object.keys(files).join(", ")}`);

    // 3. Test in a sandbox — nothing publishes unless this passes
    await setBuild(buildId, { status: "testing" });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bera-"));
    await writeProjectFiles(tmpDir, files);
    let report = await testProject(tmpDir, files, plan.endpoints, envVars);
    await setBuild(buildId, { testResults: report });
    await note(`Endpoint tests: ${report.results.filter(r => r.ok).length}/${report.results.length} checks passed`);
    // Repair loop: always repair from the BEST version seen so far, and
    // never let a worse repair replace it — a regeneration that breaks
    // previously-passing endpoints is discarded, not kept.
    let bestFiles = { ...files };
    let bestReport = report;
    const score = (r: TestReport) => r.results.filter(x => x.ok).length;
    for (let round = 1; round <= 3 && !bestReport.ok; round++) {
      await note(`Repair round ${round}: fixing the failing checks in the backend`);
      const candidate = { ...bestFiles, "server.js": await repairBackendServer(build.prompt, plan, bestFiles["server.js"], failureSummary(bestReport), envKeys) };
      await writeProjectFiles(tmpDir, { "server.js": candidate["server.js"] });
      report = await testProject(tmpDir, candidate, plan.endpoints, envVars);
      await note(`Endpoint tests after repair ${round}: ${score(report)}/${report.results.length} checks passed`);
      if (score(report) > score(bestReport)) { bestFiles = candidate; bestReport = report; }
      await setBuild(buildId, { testResults: bestReport });
    }
    report = bestReport;
    Object.assign(files, bestFiles);
    if (!report.ok) {
      const failed = report.results.filter(r => !r.ok).map(r => r.name).join(", ");
      throw new Error(`The build failed its pre-publish endpoint tests (${failed}), so nothing was published. The failing checks are listed on the build.`);
    }

    // 4. Publish to a fresh repo under the user's GitHub account
    await setBuild(buildId, { status: "publishing" });
    let repo: Awaited<ReturnType<typeof createGithubRepository>> | null = null;
    let lastError: any = null;
    for (let attempt = 0; attempt < 3 && !repo; attempt++) {
      const name = `${base}-${crypto.randomBytes(2).toString("hex")}`;
      try { repo = await createGithubRepository(token, name, `Built with Agent Bera: ${build.prompt.slice(0, 100)}`); }
      catch (e: any) { lastError = e; if (!/already exists|422/i.test(String(e?.message || e))) throw e; }
    }
    if (!repo) throw new Error(`GitHub repo creation failed: ${lastError?.message || "unknown error"}`);
    files["package.json"] = JSON.stringify({ ...JSON.parse(files["package.json"]), name: repo.name }, null, 2);
    for (const pathInRepo of Object.keys(files)) {
      await createRepositoryFile(token, repo.fullName, pathInRepo, files[pathInRepo], `Add ${pathInRepo} (built by Agent Bera)`);
    }
    await setBuild(buildId, { repoUrl: `https://github.com/${repo.fullName}`, repoFullName: repo.fullName });
    await note(`Published to github.com/${repo.fullName}`);

    // 5. Create the web deployment (same shape as POST /web-deployments;
    // the platform installs dependencies and runs the start command)
    await setBuild(buildId, { status: "deploying" });
    const displayName = plan.appName || build.name || build.prompt.replace(/\s+/g, " ").slice(0, 60);
    const [row] = await db.insert(webDeploymentsTable).values({
      userId: build.userId,
      repoUrl: githubRepoUrl(repo.fullName),
      githubRepoId: repo.id,
      githubFullName: repo.fullName,
      githubPrivate: repo.private,
      branch: repo.defaultBranch || "main",
      customName: displayName.slice(0, 100),
      slug: generateSlug(),
      buildCommand: null,
      startCommand: "node server.js",
      envVars,
      expiresAt: user.subscriptionExpiresAt,
      status: "queued",
      autoDeploy: false
    }).returning();
    await setBuild(buildId, { webDeploymentId: row.id });
    startWebDeployment(row.id).catch((err) => logger.error({ err, webDeploymentId: row.id }, "Agent Bera web deployment start failed"));

    // 6. Wait for it to come up, then verify the live deployment
    const liveSlug = await waitForDeployment(row.id);
    if (liveSlug) {
      await setBuild(buildId, { status: "verifying" });
      const live = await verifyWithRepair({ buildId, prompt: build.prompt, plan, envVars, token, repoFullName: repo.fullName, deploymentId: row.id, files, note }, liveSlug);
      await setBuild(buildId, { liveCheck: live });
      await note(live.ok ? `Live check passed at ${publicUrlFor(liveSlug)}` : `Live check reported problems at ${publicUrlFor(liveSlug)} — see the build card`);
      await setBuild(buildId, { status: "live" });
    }
    // If the deployment is still starting after the wait, the build stays
    // in "deploying" — the builds endpoint reports it as live as soon as
    // the deployment runs.
  } catch (e: any) {
    await setBuild(buildId, { status: "failed", error: String(e?.message || e) });
    logger.error({ err: e, buildId }, "Agent Bera build failed");
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Edit an existing app in place: read the app's current code back from its
// repo, apply the user's instruction file-by-file (each edited file is
// validated on its own; a bad edit keeps the current file), run the same
// pre-publish test gate, then update the SAME repo and restart the SAME
// deployment. A failed gate changes nothing.
export async function runAgentEdit(buildId: number): Promise<void> {
  const [build] = await db.select().from(agentBuildsTable).where(eq(agentBuildsTable.id, buildId));
  if (!build || !build.parentId) return;
  const lines: string[] = [];
  const note = async (line: string) => { lines.push(`[${new Date().toISOString()}] ${line}`); await setBuild(buildId, { buildLog: lines.join("\n") }); };
  let tmpDir: string | null = null;
  try {
    const [parent] = await db.select().from(agentBuildsTable).where(eq(agentBuildsTable.id, build.parentId));
    if (!parent?.repoFullName || !parent.webDeploymentId) throw new Error("The original build has no repo or deployment to edit.");
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, build.userId));
    const token = decryptGithubToken(user?.githubAccessTokenEncrypted);
    if (!user || !token) throw new Error("GitHub is not connected for this account. Connect GitHub, then try the edit again.");
    const plan = (build.plan || parent.plan) as AgentProjectPlan | null;
    if (!plan) throw new Error("The original build has no plan to test the edit against.");
    const envVars = envOf(build);
    const envKeys = Object.keys(envVars);

    await note(`Edit requested for ${parent.name || parent.repoFullName}: ${build.prompt}`);
    const serverFile = await getRepositoryFile(token, parent.repoFullName, "server.js");
    const frontFile = await getRepositoryFile(token, parent.repoFullName, "public/index.html");
    const pkgFile = await getRepositoryFile(token, parent.repoFullName, "package.json").catch(() => null);
    if (!serverFile || !frontFile) throw new Error("Could not read the app's current code from GitHub, so the edit was not applied.");

    await setBuild(buildId, { status: "generating" });
    const edited = await editProjectFiles(build.prompt, plan, { server: serverFile.content, frontend: frontFile.content }, envKeys);
    const files: Record<string, string> = {
      "package.json": pkgFile?.content || JSON.stringify({ name: slugify(plan.appName || "app"), version: "1.0.0", private: true, scripts: { start: "node server.js" }, dependencies: { express: "^4.19.2", pg: "^8.12.0" } }, null, 2),
      "server.js": edited.server,
      "lib/store.js": GENERATED_STORE,
      "public/index.html": edited.frontend
    };
    const changed = [
      ...(edited.server !== serverFile.content ? ["server.js"] : []),
      ...(edited.frontend !== frontFile.content ? ["public/index.html"] : [])
    ];
    await note(changed.length ? `Edited files: ${changed.join(", ")}` : "The edit produced no changes to the app's files");
    if (!changed.length) throw new Error("The edit did not produce a valid change to the app, so nothing was updated.");

    // Same gate as a fresh build — an edit that breaks the API never ships.
    await setBuild(buildId, { status: "testing" });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bera-edit-"));
    await writeProjectFiles(tmpDir, files);
    let report = await testProject(tmpDir, files, plan.endpoints, envVars);
    let bestFiles = { ...files };
    let bestReport = report;
    const score = (r: TestReport) => r.results.filter(x => x.ok).length;
    for (let round = 1; round <= 2 && !bestReport.ok; round++) {
      await note(`Repair round ${round}: fixing the failing checks in the edited backend`);
      const candidate = { ...bestFiles, "server.js": await repairBackendServer(build.prompt, plan, bestFiles["server.js"], failureSummary(bestReport), envKeys) };
      await writeProjectFiles(tmpDir, { "server.js": candidate["server.js"] });
      report = await testProject(tmpDir, candidate, plan.endpoints, envVars);
      if (score(report) > score(bestReport)) { bestFiles = candidate; bestReport = report; }
      await setBuild(buildId, { testResults: bestReport });
    }
    report = bestReport;
    Object.assign(files, bestFiles);
    await setBuild(buildId, { testResults: report });
    if (!report.ok) {
      const failed = report.results.filter(r => !r.ok).map(r => r.name).join(", ");
      throw new Error(`The edit failed its endpoint tests (${failed}), so the live app was left unchanged.`);
    }

    await setBuild(buildId, { status: "publishing" });
    await upsertRepositoryFile(token, parent.repoFullName, "server.js", files["server.js"], `Edit: ${build.prompt.slice(0, 80)} (Agent Bera)`);
    await upsertRepositoryFile(token, parent.repoFullName, "public/index.html", files["public/index.html"], `Edit: ${build.prompt.slice(0, 80)} (Agent Bera)`);
    await upsertRepositoryFile(token, parent.repoFullName, "lib/store.js", files["lib/store.js"], "Update the Agent Bera data store");
    await note(`Updated github.com/${parent.repoFullName}`);

    await setBuild(buildId, { status: "deploying" });
    await restartDeployment(parent.webDeploymentId);
    const liveSlug = await waitForDeployment(parent.webDeploymentId);
    if (liveSlug) {
      await setBuild(buildId, { status: "verifying" });
      const live = await verifyWithRepair({ buildId, prompt: build.prompt, plan, envVars, token, repoFullName: parent.repoFullName, deploymentId: parent.webDeploymentId, files, note }, liveSlug);
      await setBuild(buildId, { liveCheck: live });
      await setBuild(buildId, { status: "live" });
    }
  } catch (e: any) {
    await setBuild(buildId, { status: "failed", error: String(e?.message || e) });
    logger.error({ err: e, buildId }, "Agent Bera edit failed");
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
