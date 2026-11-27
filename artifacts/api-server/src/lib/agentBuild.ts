import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { db, agentBuildsTable, usersTable, webDeploymentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createGithubRepository, createRepositoryFile, decryptGithubToken, githubRepoUrl } from "./github";
import { planProject, generateProjectFiles, repairBackendServer, slugify, type AgentProjectPlan } from "./agentAi";
import { writeProjectFiles, testProject, runLiveCheck, type TestReport } from "./agentTest";
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

// The full Agent Bera pipeline:
// plan -> generate a full-stack project (Express backend + API-driven
// frontend) -> TEST it in a sandbox (syntax, install, boot, every planned
// API endpoint) with a repair loop -> only then publish to a NEW repo in
// the user's own GitHub account -> deploy as a web deployment the user
// owns -> verify the live URL (HTTP + API checks, browser tier when the
// host has a headless browser).
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

    // 1. Plan
    await setBuild(buildId, { status: "planning" });
    const plan: AgentProjectPlan = await planProject(build.prompt);
    await setBuild(buildId, { plan, name: plan.appName || build.name });
    await note(`Plan: ${plan.appName} — ${plan.endpoints.length} API endpoints (${plan.endpoints.map(e => `${e.method} ${e.path}`).join(", ")})`);

    // 2. Generate the full-stack project
    await setBuild(buildId, { status: "generating" });
    const base = slugify(plan.appName || build.prompt.split(/\s+/).slice(0, 5).join(" "));
    const files = await generateProjectFiles(build.prompt, plan, base);
    await note(`Generated ${Object.keys(files).length} files: ${Object.keys(files).join(", ")}`);

    // 3. Test in a sandbox — nothing publishes unless this passes
    await setBuild(buildId, { status: "testing" });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bera-"));
    await writeProjectFiles(tmpDir, files);
    let report = await testProject(tmpDir, files, plan.endpoints);
    await setBuild(buildId, { testResults: report });
    await note(`Endpoint tests: ${report.results.filter(r => r.ok).length}/${report.results.length} checks passed`);
    // Repair loop: always repair from the BEST version seen so far, and
    // never let a worse repair replace it — a regeneration that breaks
    // previously-passing endpoints is discarded, not kept.
    let bestFiles = { ...files };
    let bestReport = report;
    const score = (r: TestReport) => r.results.filter(x => x.ok).length;
    for (let round = 1; round <= 2 && !bestReport.ok; round++) {
      await note(`Repair round ${round}: fixing the failing checks in the backend`);
      const candidate = { ...bestFiles, "server.js": await repairBackendServer(build.prompt, plan, bestFiles["server.js"], failureSummary(bestReport)) };
      await writeProjectFiles(tmpDir, { "server.js": candidate["server.js"] });
      report = await testProject(tmpDir, candidate, plan.endpoints);
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
    for (const pathInRepo of ["package.json", "server.js", "public/index.html", "README.md"]) {
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
      envVars: {},
      expiresAt: user.subscriptionExpiresAt,
      status: "queued",
      autoDeploy: false
    }).returning();
    await setBuild(buildId, { webDeploymentId: row.id });
    startWebDeployment(row.id).catch((err) => logger.error({ err, webDeploymentId: row.id }, "Agent Bera web deployment start failed"));

    // 6. Wait for it to come up, then verify the live deployment
    const deadline = Date.now() + 300000;
    let liveSlug: string | null = null;
    while (Date.now() < deadline) {
      await sleep(6000);
      const [dep] = await db.select({ status: webDeploymentsTable.status, slug: webDeploymentsTable.slug }).from(webDeploymentsTable).where(eq(webDeploymentsTable.id, row.id));
      if (!dep) break;
      if (dep.status === "running") { liveSlug = dep.slug; break; }
      if (["failed", "crashed", "stopped"].includes(dep.status)) {
        throw new Error("The app passed its endpoint tests and was published, but its BeraHost deployment failed to start. Open the deployment to see its build log.");
      }
    }
    if (liveSlug) {
      await setBuild(buildId, { status: "verifying" });
      const url = publicUrlFor(liveSlug);
      // Give the proxy a moment to route the freshly started app.
      await sleep(5000);
      const live = await runLiveCheck(url, plan.endpoints);
      await setBuild(buildId, { liveCheck: live });
      await note(live.ok ? `Live check passed at ${url}` : `Live check reported problems at ${url} — see the build card`);
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
