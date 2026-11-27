import fs from "fs/promises";
import path from "path";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import net from "net";
import crypto from "crypto";
import { db, webDeploymentsTable, domainOrdersTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { decryptGithubToken } from "./github";
import { isSubscriptionActive } from "./subscriptions";

const execFileAsync = promisify(execFile);
const runningWebProcesses = new Map<number, ReturnType<typeof spawn>>();
const WEB_PORT_START = 4200;

export type ScannedEnvVar = { key: string; defaultValue: string; description: string; required: boolean };

function deploymentRoot(id: number) { return `/tmp/berahost_web_${id}`; }
function isSafeSlug(value: string) { return /^[a-z0-9-]{6,80}$/.test(value); }

export function normalizeGithubUrl(raw: string): string | null {
  const input = String(raw || "").trim().replace(/\.git$/, "");
  const match = input.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? `https://github.com/${match[1]}/${match[2]}.git` : null;
}

function parseEnvFile(content: string): ScannedEnvVar[] {
  const result: ScannedEnvVar[] = [];
  let description = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) { description = trimmed.replace(/^#+\s*/, ""); continue; }
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*(?:=\s*(.*))?$/i);
    if (!match) { description = ""; continue; }
    const defaultValue = (match[2] || "").trim().replace(/^['"]|['"]$/g, "");
    result.push({ key: match[1], defaultValue, description, required: defaultValue === "" });
    description = "";
  }
  return result;
}

export async function scanWebEnv(root: string): Promise<ScannedEnvVar[]> {
  const names = [".env.example", ".env.sample", ".env.template", ".env.defaults"];
  const all = new Map<string, ScannedEnvVar>();
  for (const name of names) {
    try {
      const vars = parseEnvFile(await fs.readFile(path.join(root, name), "utf8"));
      for (const item of vars) if (!all.has(item.key)) all.set(item.key, item);
    } catch { /* optional config file */ }
  }
  return [...all.values()];
}

async function run(command: string, cwd: string, env: Record<string, string>, timeout = 15 * 60 * 1000) {
  const result = await execFileAsync("bash", ["-lc", command], { cwd, env: { ...process.env, ...env }, timeout, maxBuffer: 8 * 1024 * 1024 });
  return `${result.stdout || ""}${result.stderr || ""}`.slice(-120000);
}

async function appendBuildLog(id: number, message: string): Promise<string> {
  const [current] = await db.select({ buildLog: webDeploymentsTable.buildLog }).from(webDeploymentsTable).where(eq(webDeploymentsTable.id, id));
  const next = `${current?.buildLog ? `${current.buildLog}\n` : ""}${message}`.slice(-120000);
  await db.update(webDeploymentsTable).set({ buildLog: next, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
  return next;
}

function detectBuildCommand(pkg: any): string {
  if (pkg?.scripts?.build) return "npm run build";
  if (pkg?.scripts?.compile) return "npm run compile";
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps.next) return "npx next build";
  if (deps.vite) return "npx vite build";
  if (deps["react-scripts"]) return "npx react-scripts build";
  if (deps.astro) return "npx astro build";
  if (deps.parcel) return "npx parcel build";
  return "";
}

function detectStartCommand(pkg: any, hasStaticOutput: boolean): string {
  if (hasStaticOutput) return "";
  if (pkg?.scripts?.start) return "npm start";
  for (const name of ["serve", "app", "run", "launch", "begin", "dev"]) if (pkg?.scripts?.[name]) return `npm run ${name}`;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps.next) return "npx next start -H 0.0.0.0";
  if (deps.vite) return "npx vite preview --host 0.0.0.0";
  if (pkg?.main) return `node ${pkg.main}`;
  return "";
}

async function findPackageRoot(root: string): Promise<{ root: string; pkg: any }> {
  const candidates = [root, "frontend", "client", "app", "website", "web"];
  const visited = new Set<string>();
  const queue = candidates.map((relative) => path.resolve(root, relative));
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(candidate, "package.json"), "utf8"));
      return { root: candidate, pkg };
    } catch { /* inspect supported nested project directories below */ }
    const relativeDepth = path.relative(root, candidate).split(path.sep).filter(Boolean).length;
    if (relativeDepth >= 3) continue;
    for (const entry of await fs.readdir(candidate, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        queue.push(path.join(candidate, entry.name));
      }
    }
  }
  return { root, pkg: {} };
}

async function waitForPort(port: number, child: ReturnType<typeof spawn>, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode) throw new Error("Web process exited before opening its assigned port.");
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });
    if (reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Web process did not listen on port ${port} within ${timeoutMs / 1000}s.`);
}

async function downloadGithubRepository(repoUrl: string, branch: string, root: string, accessToken?: string | null): Promise<void> {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error("Only GitHub repository URLs are supported.");
  const owner = match[1];
  const repository = match[2];
  const headers: Record<string, string> = { "User-Agent": "BERAHOST-GitHub-Integration/1.0", Accept: "application/vnd.github+json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(`https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tar.gz/refs/heads/${encodeURIComponent(branch)}`, { headers });
  if (!response.ok) throw new Error(`GitHub repository download failed (${response.status}). Check that the repository, branch, and GitHub access are valid.`);
  const archive = path.join(root, ".github-source.tar.gz");
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
  await execFileAsync("tar", ["-xzf", archive, "-C", root, "--strip-components=1"], { timeout: 5 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
  await fs.rm(archive, { force: true });
}

function publicBaseUrl() {
  return (process.env.PUBLIC_URL || process.env.FRONTEND_URL || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "") || "https://berahost-cywge4uc.manus.space").replace(/\/$/, "");
}

export function webUrl(slug: string) { return `${publicBaseUrl()}/web/${slug}`; }

export async function startWebDeployment(id: number): Promise<void> {
  const [deployment] = await db.select().from(webDeploymentsTable).where(eq(webDeploymentsTable.id, id));
  if (!deployment) return;
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, deployment.userId));
  if (!owner || owner.isBanned || owner.deletedAt || (!owner.isAdmin && !isSubscriptionActive(owner))) {
    await db.update(webDeploymentsTable).set({ status: "stopped", pid: null, runtimePort: null, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
    return;
  }
  const root = deploymentRoot(id);
  const envVars = (deployment.envVars as Record<string, string>) || {};
  const port = WEB_PORT_START + id;
  try {
    const repo = normalizeGithubUrl(deployment.repoUrl);
    if (!repo) throw new Error("Only GitHub repository URLs are supported.");
    const accessToken = decryptGithubToken(owner.githubAccessTokenEncrypted);
    if (deployment.githubPrivate && !accessToken) throw new Error("Reconnect GitHub to access this private repository.");
    await db.update(webDeploymentsTable).set({ status: "building", updatedAt: new Date(), buildLog: "[BERAHOST] Cloning repository..." }).where(eq(webDeploymentsTable.id, id));
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    await downloadGithubRepository(repo, deployment.branch, root, accessToken);
    const scannedVars = await scanWebEnv(root);
    await appendBuildLog(id, "[BERAHOST] Repository cloned. Installing dependencies...");
    await db.update(webDeploymentsTable).set({ scannedVars }).where(eq(webDeploymentsTable.id, id));
    const project = await findPackageRoot(root);
    const packageRoot = project.root;
    const pkg = project.pkg;
    if (Object.keys(pkg).length > 0) {
      await appendBuildLog(id, `[BERAHOST] Detected package manifest in ${path.relative(root, packageRoot) || "."}.`);
    } else {
      await appendBuildLog(id, "[BERAHOST] No readable package.json was found in the extracted repository.");
    }
    const installCommand = await fs.access(path.join(packageRoot, "pnpm-lock.yaml")).then(() => "corepack pnpm install --frozen-lockfile").catch(async () => await fs.access(path.join(packageRoot, "yarn.lock")).then(() => "corepack yarn install --frozen-lockfile").catch(() => "npm_config_legacy_peer_deps=true npm install --legacy-peer-deps --no-audit --no-fund || (rm -rf node_modules && corepack pnpm install --no-frozen-lockfile --no-audit)"));
    if (Object.keys(pkg).length > 0) {
      const installLog = await run(installCommand, packageRoot, envVars);
      await appendBuildLog(id, `[BERAHOST] Dependencies installed.\n${installLog}`);
    }
    const buildCommand = deployment.buildCommand || detectBuildCommand(pkg);
    if (buildCommand) {
      await appendBuildLog(id, `[BERAHOST] Build command detected: ${buildCommand}`);
      const buildLog = await run(buildCommand, packageRoot, { ...envVars, PORT: String(port) });
      await appendBuildLog(id, `[BERAHOST] Build completed.\n${buildLog}`);
    }
    const candidates = ["dist", "build", "out", "public"].map((dir) => path.join(packageRoot, dir));
    let staticRoot = (await Promise.all(candidates.map(async (candidate) => (await fs.stat(candidate).catch(() => null))?.isDirectory() ? candidate : null))).find(Boolean) as string | undefined;
    if (!staticRoot && (await fs.stat(path.join(packageRoot, "index.html")).catch(() => null))?.isFile()) staticRoot = packageRoot;
    const startCommand = deployment.startCommand || detectStartCommand(pkg, Boolean(staticRoot));
    if (buildCommand || startCommand) await appendBuildLog(id, `[BERAHOST] ${buildCommand ? `Build: ${buildCommand}` : "No build script"}; ${startCommand ? `Start: ${startCommand}` : "static output detected"}`);
    if (staticRoot && !startCommand) {
      await appendBuildLog(id, "[BERAHOST] Static site built and ready.");
      await db.update(webDeploymentsTable).set({ status: "running", outputDirectory: path.relative(root, staticRoot) || ".", runtimePort: null, pid: null }).where(eq(webDeploymentsTable.id, id));
      return;
    }
    if (!startCommand) throw new Error("No build output or start command was found. Add a build/start command or a package.json script.");
    const child = spawn("bash", ["-lc", startCommand], { cwd: packageRoot, env: { ...process.env, ...envVars, PORT: String(port), NODE_ENV: "production" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    runningWebProcesses.set(id, child);
    let log = (await db.select({ buildLog: webDeploymentsTable.buildLog }).from(webDeploymentsTable).where(eq(webDeploymentsTable.id, id)))[0]?.buildLog || "";
    log = `${log}\n[BERAHOST] Node web process started.\n`.slice(-120000);
    let logFlush: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      log = `${log}${chunk.toString()}`.slice(-120000);
      if (!logFlush) {
        logFlush = setTimeout(async () => {
          logFlush = undefined;
          await db.update(webDeploymentsTable).set({ buildLog: log, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id)).catch(() => {});
        }, 250);
      }
    };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    child.on("exit", async (code) => {
      if (logFlush) clearTimeout(logFlush);
      runningWebProcesses.delete(id);
      await db.update(webDeploymentsTable).set({ status: code === 0 ? "stopped" : "crashed", pid: null, runtimePort: null, buildLog: log, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id)).catch(() => {});
    });
    await waitForPort(port, child);
    await db.update(webDeploymentsTable).set({ status: "running", outputDirectory: null, runtimePort: port, pid: child.pid ?? null, buildLog: log, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
    child.unref();
  } catch (err: any) {
    logger.error({ err, webDeploymentId: id }, "Web deployment failed");
    await appendBuildLog(id, `[BERAHOST] ERROR: ${String(err?.stderr || err?.message || err)}`).catch(() => {});
    await db.update(webDeploymentsTable).set({ status: "failed" }).where(eq(webDeploymentsTable.id, id)).catch(() => {});
  }
}

export async function stopWebDeployment(id: number): Promise<void> {
  const child = runningWebProcesses.get(id);
  if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} } }
  runningWebProcesses.delete(id);
  await db.update(webDeploymentsTable).set({ status: "stopped", pid: null, runtimePort: null, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
}

const redeployingWeb = new Set<number>();

export async function redeployWebDeployment(id: number, commitSha?: string, commitMessage?: string): Promise<void> {
  if (redeployingWeb.has(id)) return;
  redeployingWeb.add(id);
  try {
    const [deployment] = await db.select().from(webDeploymentsTable).where(eq(webDeploymentsTable.id, id));
    if (!deployment || !deployment.autoDeploy) return;
    await db.update(webDeploymentsTable).set({ lastCommitSha: commitSha || deployment.lastCommitSha, lastCommitMessage: commitMessage || deployment.lastCommitMessage, status: "queued", updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
    await stopWebDeployment(id);
    await startWebDeployment(id);
  } finally {
    redeployingWeb.delete(id);
  }
}

export async function deleteWebDeployment(id: number): Promise<void> {
  await stopWebDeployment(id);
  await fs.rm(deploymentRoot(id), { recursive: true, force: true });
}

async function resolveDeployment(reqPath: string, host: string) {
  const slug = reqPath.split("/").filter(Boolean)[1];
  if (slug && isSafeSlug(slug)) {
    const [deployment] = await db.select().from(webDeploymentsTable).where(eq(webDeploymentsTable.slug, slug));
    return { deployment, assetPath: reqPath.split("/").filter(Boolean).slice(2).join("/") };
  }
  const [domain] = await db.select().from(domainOrdersTable).where(and(eq(domainOrdersTable.hostname, host.split(":")[0].toLowerCase()), eq(domainOrdersTable.status, "active")));
  if (!domain) return { deployment: null, assetPath: "" };
  const [deployment] = await db.select().from(webDeploymentsTable).where(eq(webDeploymentsTable.id, domain.webDeploymentId));
  return { deployment, assetPath: reqPath.replace(/^\//, "") };
}

export async function handleWebRequest(req: any, res: any, next: any): Promise<void> {
  const isWebPath = req.path === "/web" || req.path.startsWith("/web/");
  const host = String(req.headers.host || "").toLowerCase();
  const isCustomDomain = !host.includes("localhost") && !host.includes("127.0.0.1") && !host.includes("replit") && !host.includes("manus");
  if (!isWebPath && !isCustomDomain) return next();
  const { deployment, assetPath } = await resolveDeployment(req.path, host);
  if (!deployment) return next();
  if (deployment.status !== "running") return res.status(503).send("This web deployment is currently suspended or unavailable.");
  if (deployment.outputDirectory) {
    const root = deploymentRoot(deployment.id);
    const relative = assetPath || "index.html";
    const filePath = path.resolve(root, deployment.outputDirectory, relative);
    const base = path.resolve(root, deployment.outputDirectory);
    const safePath = filePath.startsWith(`${base}${path.sep}`) ? filePath : path.join(base, "index.html");
    try { return res.sendFile(safePath); } catch { return res.status(404).send("Page not found"); }
  }
  if (!deployment.runtimePort) return res.status(503).send("Web runtime is not ready.");
  try {
    // Preserve the query string — it was previously dropped, breaking any
    // deployed app that reads query params (search, callbacks, pagination).
    const query = req.url && req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const target = `http://127.0.0.1:${deployment.runtimePort}/${assetPath}${query}`;
    // Forward the request body EXACTLY as the client sent it. The previous
    // code sent JSON.stringify(req.body) while also forwarding the original
    // Content-Length header: the re-serialized body almost never has the
    // same byte length, so the deployment's server waited for bytes that
    // would never arrive (or read a truncated body) and every form/API POST
    // hung until the outer proxy timed out. GETs were unaffected, which is
    // why deployed sites loaded but no form submission ever completed.
    let body: Buffer | undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      if ((req as any).rawBody) {
        // Captured byte-for-byte by the body parsers' verify hooks (app.ts).
        body = (req as any).rawBody;
      } else if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
        // A parser consumed the stream without leaving raw bytes behind.
        // Re-serializing is lossy; it is only a last resort so the request
        // can still complete instead of hanging.
        body = Buffer.from(JSON.stringify(req.body));
      } else {
        // No parser touched this request (e.g. multipart uploads, plain
        // text, octet-stream): the raw stream is still intact — read it.
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
        if (chunks.length) body = Buffer.concat(chunks);
      }
    }
    const headers = { ...req.headers, host: `127.0.0.1:${deployment.runtimePort}` };
    // Never forward the original Content-Length: fetch computes it from the
    // body actually sent. A stale length is what made targets hang.
    delete headers["content-length"];
    const response = await fetch(target, { method: req.method, headers: headers as any, body, redirect: "manual" });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== "transfer-encoding" && lowerKey !== "set-cookie") res.setHeader(key, value);
    });
    const headersWithCookies = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = headersWithCookies.getSetCookie?.() ?? headersWithCookies.get("set-cookie");
    if (setCookies) res.setHeader("Set-Cookie", Array.isArray(setCookies) ? setCookies : [setCookies]);
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch { res.status(502).send("Web runtime is not responding."); }
}

export function generateSlug() { return `site-${crypto.randomBytes(7).toString("hex")}`; }
