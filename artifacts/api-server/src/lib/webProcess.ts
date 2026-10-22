import fs from "fs/promises";
import path from "path";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import net from "net";
import crypto from "crypto";
import { db, webDeploymentsTable, domainOrdersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

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

async function downloadGithubRepository(repoUrl: string, branch: string, root: string): Promise<void> {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error("Only public GitHub repositories are supported.");
  const owner = match[1];
  const repository = match[2];
  const response = await fetch(`https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tar.gz/refs/heads/${encodeURIComponent(branch)}`);
  if (!response.ok) throw new Error(`GitHub repository download failed (${response.status}). Check that the repository and branch are public and valid.`);
  const archive = path.join(root, ".github-source.tar.gz");
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
  await execFileAsync("tar", ["-xzf", archive, "-C", root, "--strip-components=1"], { timeout: 5 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
  await fs.rm(archive, { force: true });
}

function publicBaseUrl() {
  return (process.env.PUBLIC_URL || process.env.FRONTEND_URL || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "")).replace(/\/$/, "");
}

export function webUrl(slug: string) { return `${publicBaseUrl()}/web/${slug}`; }

export async function startWebDeployment(id: number): Promise<void> {
  const [deployment] = await db.select().from(webDeploymentsTable).where(eq(webDeploymentsTable.id, id));
  if (!deployment) return;
  const root = deploymentRoot(id);
  const envVars = (deployment.envVars as Record<string, string>) || {};
  const port = WEB_PORT_START + id;
  try {
    const repo = normalizeGithubUrl(deployment.repoUrl);
    if (!repo) throw new Error("Only public GitHub repository URLs are supported.");
    await db.update(webDeploymentsTable).set({ status: "building", updatedAt: new Date(), buildLog: "Cloning repository..." }).where(eq(webDeploymentsTable.id, id));
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    await downloadGithubRepository(repo, deployment.branch, root);
    const scannedVars = await scanWebEnv(root);
    await db.update(webDeploymentsTable).set({ scannedVars, buildLog: "Repository cloned. Installing dependencies..." }).where(eq(webDeploymentsTable.id, id));
    const packagePath = path.join(root, "package.json");
    let pkg: any = {};
    try { pkg = JSON.parse(await fs.readFile(packagePath, "utf8")); } catch { /* static repository */ }
    const installCommand = await fs.access(path.join(root, "pnpm-lock.yaml")).then(() => "corepack pnpm install --frozen-lockfile").catch(async () => await fs.access(path.join(root, "yarn.lock")).then(() => "corepack yarn install --frozen-lockfile").catch(() => "npm install --no-audit --no-fund"));
    if (pkg.scripts || Object.keys(pkg).length === 0) {
      const installLog = await run(installCommand, root, envVars);
      await db.update(webDeploymentsTable).set({ buildLog: `Dependencies installed.\n${installLog}`, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
    }
    const buildCommand = deployment.buildCommand || (pkg.scripts?.build ? "npm run build" : "");
    if (buildCommand) {
      const buildLog = await run(buildCommand, root, { ...envVars, PORT: String(port) });
      await db.update(webDeploymentsTable).set({ buildLog: `Build completed.\n${buildLog}`, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
    }
    const candidates = ["dist", "build", "out", "public"].map((dir) => path.join(root, dir));
    const staticRoot = (await Promise.all(candidates.map(async (candidate) => (await fs.stat(candidate).catch(() => null))?.isDirectory() ? candidate : null))).find(Boolean) as string | undefined;
    const startCommand = deployment.startCommand || (pkg.scripts?.start ? "npm start" : "");
    if (staticRoot && !startCommand) {
      await db.update(webDeploymentsTable).set({ status: "running", outputDirectory: path.relative(root, staticRoot), runtimePort: null, pid: null, buildLog: "Static site built and ready.", updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
      return;
    }
    if (!startCommand) throw new Error("No build output or start command was found. Add a build/start command or a package.json script.");
    const child = spawn("bash", ["-lc", startCommand], { cwd: root, env: { ...process.env, ...envVars, PORT: String(port), NODE_ENV: "production" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    runningWebProcesses.set(id, child);
    let log = "Node web process started.\n";
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
    await db.update(webDeploymentsTable).set({ status: "failed", buildLog: String(err?.stderr || err?.message || err), updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id)).catch(() => {});
  }
}

export async function stopWebDeployment(id: number): Promise<void> {
  const child = runningWebProcesses.get(id);
  if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} } }
  runningWebProcesses.delete(id);
  await db.update(webDeploymentsTable).set({ status: "stopped", pid: null, runtimePort: null, updatedAt: new Date() }).where(eq(webDeploymentsTable.id, id));
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
    const target = `http://127.0.0.1:${deployment.runtimePort}/${assetPath}`;
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {});
    const response = await fetch(target, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${deployment.runtimePort}` } as any, body });
    res.status(response.status);
    response.headers.forEach((value, key) => { if (key.toLowerCase() !== "transfer-encoding") res.setHeader(key, value); });
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch { res.status(502).send("Web runtime is not responding."); }
}

export function generateSlug() { return `site-${crypto.randomBytes(7).toString("hex")}`; }
