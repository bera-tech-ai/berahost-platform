import crypto from "crypto";
import { db, agentBuildsTable, usersTable, webDeploymentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createGithubRepository, createRepositoryFile, decryptGithubToken, githubRepoUrl } from "./github";
import { generateSite, looksComplete, slugify, GENERATED_STATIC_SERVER } from "./agentAi";
import { generateSlug, startWebDeployment } from "./webProcess";
import { logger } from "./logger";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function setBuild(id: number, patch: Partial<{ status: string; error: string | null; name: string; repoUrl: string; repoFullName: string; webDeploymentId: number }>): Promise<void> {
  await db.update(agentBuildsTable).set({ ...patch, updatedAt: new Date() }).where(eq(agentBuildsTable.id, id)).catch(() => {});
}

// The Agent Bera pipeline, mirroring the proven standalone flow:
// generate the site -> publish it to a NEW repo in the user's own GitHub
// account -> create a web deployment owned by the user (counted on their
// plan like any other) -> wait for it to come up.
export async function runAgentBuild(buildId: number): Promise<void> {
  const [build] = await db.select().from(agentBuildsTable).where(eq(agentBuildsTable.id, buildId));
  if (!build) return;
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, build.userId));
    const token = decryptGithubToken(user?.githubAccessTokenEncrypted);
    if (!user || !token) throw new Error("GitHub is not connected for this account. Connect GitHub, then start the build again.");

    // 1. Generate
    await setBuild(buildId, { status: "generating" });
    const html = await generateSite(build.prompt);
    if (!looksComplete(html)) throw new Error("The built site failed its final check, so nothing was published.");

    // 2. Publish to a fresh repo under the user's GitHub account
    await setBuild(buildId, { status: "publishing" });
    const base = slugify(build.prompt.split(/\s+/).slice(0, 5).join(" "));
    let repo: Awaited<ReturnType<typeof createGithubRepository>> | null = null;
    let lastError: any = null;
    for (let attempt = 0; attempt < 3 && !repo; attempt++) {
      const name = `${base}-${crypto.randomBytes(2).toString("hex")}`;
      try { repo = await createGithubRepository(token, name, `Built with Agent Bera: ${build.prompt.slice(0, 100)}`); }
      catch (e: any) { lastError = e; if (!/already exists|422/i.test(String(e?.message || e))) throw e; }
    }
    if (!repo) throw new Error(`GitHub repo creation failed: ${lastError?.message || "unknown error"}`);
    const displayName = build.name || build.prompt.replace(/\s+/g, " ").slice(0, 60);
    const files: Record<string, string> = {
      "index.html": html,
      "server.js": GENERATED_STATIC_SERVER,
      "package.json": JSON.stringify({ name: repo.name, version: "1.0.0", private: true, scripts: { start: "node server.js" } }, null, 2),
      "README.md": `# ${displayName}\n\nBuilt with Agent Bera on BERAHOST from the prompt:\n\n> ${build.prompt}\n`
    };
    for (const [pathInRepo, content] of Object.entries(files)) {
      await createRepositoryFile(token, repo.fullName, pathInRepo, content, `Add ${pathInRepo} (built by Agent Bera)`);
    }
    await setBuild(buildId, { repoUrl: `https://github.com/${repo.fullName}`, repoFullName: repo.fullName });

    // 3. Create the web deployment (same shape as POST /web-deployments)
    await setBuild(buildId, { status: "deploying" });
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

    // 4. Wait for the deployment to come up (bounded; the builds list keeps
    // reflecting the deployment's own status afterwards either way).
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      await sleep(6000);
      const [dep] = await db.select({ status: webDeploymentsTable.status }).from(webDeploymentsTable).where(eq(webDeploymentsTable.id, row.id));
      if (!dep) break;
      if (dep.status === "running") { await setBuild(buildId, { status: "live" }); return; }
      if (["failed", "crashed", "stopped"].includes(dep.status)) {
        throw new Error("The site was published, but its BeraHost deployment failed to start. Open the deployment to see its build log.");
      }
    }
    // Still starting after the wait: leave the build in "deploying" — the
    // builds endpoint reports it as live as soon as the deployment runs.
  } catch (e: any) {
    await setBuild(buildId, { status: "failed", error: String(e?.message || e) });
    logger.error({ err: e, buildId }, "Agent Bera build failed");
  }
}
