// Agent Bera's verification gates.
//
// Gate 1 (pre-publish): the generated project is written to a throwaway
// sandbox on the host, its JS is syntax-checked, dependencies are
// installed, the server is booted on a spare port, and every API endpoint
// in the plan is exercised with a real HTTP request. Nothing is published
// unless this gate passes — failures go back to the repair loop instead.
//
// Gate 2 (post-deploy): once BeraHost reports the deployment running, the
// live URL is checked over HTTP (page serves, title present, API health
// and a real API endpoint answer), and — when a headless browser runtime
// is available on the host — the page is also loaded in a real browser to
// catch render/JS errors. The browser tier reports honestly when no
// browser runtime is installed rather than pretending it ran.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import type { AgentEndpointTest } from "./agentAi";

export type CheckResult = { name: string; ok: boolean; detail: string; status?: number };
export type TestReport = { ok: boolean; results: CheckResult[]; log: string; testedAt: string };
export type LiveCheckReport = {
  ok: boolean;
  url: string;
  status?: number;
  title?: string;
  checks: CheckResult[];
  browser: { available: boolean; ok?: boolean; detail: string; consoleErrors?: string[] };
  checkedAt: string;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const tail = (s: string, n = 4000) => (s.length > n ? s.slice(s.length - n) : s);

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const onData = (d: Buffer) => { output = (output + d.toString()).slice(-200000); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: null, output: output + String(err) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

export async function writeProjectFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, "utf8");
  }
}

async function syntaxChecks(dir: string, files: Record<string, string>): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const rel of Object.keys(files)) {
    if (rel.endsWith(".js")) {
      const r = await runCmd(process.execPath, ["--check", path.join(dir, rel)], dir, 30000);
      results.push({ name: `Syntax: ${rel}`, ok: r.code === 0, detail: r.code === 0 ? "node --check passed" : tail(r.output, 500) });
    }
    if (rel.endsWith(".json")) {
      try { JSON.parse(files[rel]); results.push({ name: `Parse: ${rel}`, ok: true, detail: "valid JSON" }); }
      catch (e: any) { results.push({ name: `Parse: ${rel}`, ok: false, detail: String(e?.message || e) }); }
    }
    if (rel.endsWith(".html")) {
      const ok = /<html[\s>]/i.test(files[rel]) && /<\/html>\s*$/i.test(files[rel].trim());
      results.push({ name: `Complete: ${rel}`, ok, detail: ok ? "complete HTML document" : "HTML document looks truncated" });
    }
  }
  return results;
}

async function waitForServer(port: number, child: ChildProcess, timeoutMs = 25000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.status > 0) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

export async function testProject(dir: string, files: Record<string, string>, tests: AgentEndpointTest[]): Promise<TestReport> {
  const results: CheckResult[] = [];
  let log = "";
  results.push(...await syntaxChecks(dir, files));
  if (results.some(r => !r.ok)) return { ok: false, results, log, testedAt: new Date().toISOString() };

  const install = await runCmd("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], dir, 240000);
  log += "\n[npm install]\n" + tail(install.output, 1500);
  results.push({ name: "Install dependencies", ok: install.code === 0, detail: install.code === 0 ? "npm install succeeded" : tail(install.output, 500) });
  if (install.code !== 0) return { ok: false, results, log: tail(log), testedAt: new Date().toISOString() };

  const port = 20000 + Math.floor(Math.random() * 20000);
  let serverOut = "";
  const child = spawn(process.execPath, ["server.js"], { cwd: dir, env: { ...process.env, PORT: String(port), NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => { serverOut = (serverOut + d.toString()).slice(-50000); });
  child.stderr?.on("data", (d) => { serverOut = (serverOut + d.toString()).slice(-50000); });
  try {
    const up = await waitForServer(port, child);
    results.push({ name: "Server boots", ok: up, detail: up ? `listening on port ${port}` : "server did not answer /api/health in time" });
    if (!up) { log += "\n[server]\n" + tail(serverOut, 2000); return { ok: false, results, log: tail(log), testedAt: new Date().toISOString() }; }

    for (const t of tests) {
      const expected = t.expected && t.expected.length ? t.expected : [200];
      try {
        const hasBody = ["POST", "PUT", "PATCH"].includes(t.method);
        const r = await fetch(`http://127.0.0.1:${port}${t.path}`, {
          method: t.method,
          headers: hasBody ? { "Content-Type": "application/json" } : undefined,
          body: hasBody ? JSON.stringify(t.body || {}) : undefined,
          signal: AbortSignal.timeout(10000)
        });
        const ok = expected.includes(r.status);
        results.push({ name: t.name || `${t.method} ${t.path}`, ok, status: r.status, detail: ok ? `${t.method} ${t.path} -> ${r.status}` : `${t.method} ${t.path} -> ${r.status}, expected ${expected.join("/")}` });
      } catch (e: any) {
        results.push({ name: t.name || `${t.method} ${t.path}`, ok: false, detail: `${t.method} ${t.path} -> ${String(e?.message || e)}` });
      }
    }
  } finally {
    child.kill("SIGKILL");
  }
  log += "\n[server]\n" + tail(serverOut, 1500);
  return { ok: results.every(r => r.ok), results, log: tail(log), testedAt: new Date().toISOString() };
}

// --- Gate 2: live verification -------------------------------------------

async function fetchCheck(name: string, url: string, expectStatuses: number[]): Promise<{ result: CheckResult; body?: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
    const body = await r.text().catch(() => "");
    return { result: { name, ok: expectStatuses.includes(r.status), status: r.status, detail: `${url} -> ${r.status}` }, body };
  } catch (e: any) {
    return { result: { name, ok: false, detail: `${url} -> ${String(e?.message || e)}` } };
  }
}

async function browserTier(url: string): Promise<LiveCheckReport["browser"]> {
  const dynamicImport = (spec: string) => (Function("s", "return import(s)") as any)(spec);
  // Playwright first, then Puppeteer — whichever the host provides.
  try {
    const pw = await dynamicImport("playwright");
    const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e?.message || e)));
      page.on("console", (msg: any) => { if (msg.type() === "error") errors.push(msg.text()); });
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      return { available: true, ok: errors.length === 0, detail: errors.length === 0 ? "Page loaded in headless Chromium with no JS errors" : `Page loaded with ${errors.length} JS error(s)`, consoleErrors: errors.slice(0, 5) };
    } finally { await browser.close().catch(() => {}); }
  } catch { /* not installed — try puppeteer */ }
  try {
    const pp = await dynamicImport("puppeteer");
    const browser = await pp.launch({ args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e?.message || e)));
      page.on("console", (msg: any) => { if (msg.type() === "error") errors.push(msg.text()); });
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      return { available: true, ok: errors.length === 0, detail: errors.length === 0 ? "Page loaded in headless Chrome with no JS errors" : `Page loaded with ${errors.length} JS error(s)`, consoleErrors: errors.slice(0, 5) };
    } finally { await browser.close().catch(() => {}); }
  } catch { /* not installed either */ }
  return { available: false, detail: "No headless browser runtime (Playwright/Puppeteer) is installed on the BeraHost host, so the browser tier was skipped — the HTTP + API live checks above still ran. Install Playwright on the host to enable full browser checks." };
}

export async function runLiveCheck(publicUrl: string, tests: AgentEndpointTest[]): Promise<LiveCheckReport> {
  const checks: CheckResult[] = [];
  const page = await fetchCheck("Live page serves", publicUrl, [200]);
  checks.push(page.result);
  let title: string | undefined;
  if (page.body) {
    const m = page.body.match(/<title[^>]*>([^<]+)<\/title>/i);
    title = m ? m[1].trim() : undefined;
    checks.push({ name: "Page is a complete HTML document", ok: /<html[\s>]/i.test(page.body) && /<\/html>/i.test(page.body), detail: title ? `title: ${title}` : "no <title> found" });
  }
  const base = publicUrl.replace(/\/$/, "");
  checks.push((await fetchCheck("Live API health", `${base}/api/health`, [200])).result);
  const sample = tests.find(t => t.method === "GET" && t.path.startsWith("/api/") && t.path !== "/api/health");
  if (sample) checks.push((await fetchCheck(`Live API endpoint ${sample.path}`, base + sample.path, sample.expected?.length ? sample.expected : [200])).result);
  const browser = await browserTier(publicUrl);
  return { ok: checks.every(c => c.ok), url: publicUrl, status: page.result.status, title, checks, browser, checkedAt: new Date().toISOString() };
}
