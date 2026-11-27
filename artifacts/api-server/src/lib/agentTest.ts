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
import { builtinModules } from "module";
import fs from "fs/promises";
import path from "path";
import { undeclaredSeedNames } from "./agentAi";
import type { AgentEndpointTest } from "./agentAi";

export type CheckResult = { name: string; ok: boolean; detail: string; status?: number };
export type TestReport = { ok: boolean; results: CheckResult[]; log: string; testedAt: string };
export type LiveCheckReport = {
  ok: boolean;
  url: string;
  status?: number;
  title?: string;
  checks: CheckResult[];
  browser: {
    available: boolean; ok?: boolean; detail: string; consoleErrors?: string[]; screenshot?: string;
    flow?: { attempted: boolean; ok: boolean; detail: string };
    vision?: { ok: boolean | null; issues: string[]; detail: string };
  };
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
  // Undeclared-dependency check: a require() of a package that is not in
  // package.json passes syntax checks and installs fine, then crashes the
  // server at boot (the generator once produced require('axios')). Catch
  // it statically so the failure is named precisely for the repair loop.
  let declared: Set<string> = new Set();
  try { declared = new Set(Object.keys(JSON.parse(files["package.json"] || "{}").dependencies || {})); } catch { /* parse check already reported */ }
  const builtins = new Set(builtinModules.flatMap(m => [m, m.replace(/^node:/, "")]));
  for (const rel of Object.keys(files)) {
    if (!rel.endsWith(".js")) continue;
    const requires = new Set<string>();
    for (const match of files[rel].matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = match[1];
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!builtins.has(pkg) && !builtins.has(spec)) requires.add(pkg);
    }
    for (const pkg of requires) {
      if (!declared.has(pkg)) {
        results.push({ name: `Dependency: ${pkg} (${rel})`, ok: false, detail: `'${pkg}' is required by ${rel} but is not declared in package.json — remove the require or use an allowed package` });
      }
    }
  }
  return results;
}

// Smoke-load every dependency declared in the sandbox's package.json.
// An npm install that exits 0 can still leave a corrupted tree (seen
// live: the `debug` package half-installed, so express died with
// MODULE_NOT_FOUND only at boot). Loading each package once here turns
// that into a precise, repairable failure instead of a dead server.
async function smokeLoadDeps(dir: string): Promise<{ ok: boolean; detail: string }> {
  let deps: string[] = [];
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    deps = Object.keys(pkg.dependencies || {});
  } catch {
    return { ok: true, detail: "no readable package.json — nothing to smoke-load" };
  }
  if (!deps.length) return { ok: true, detail: "no runtime dependencies declared" };
  const script = [
    "const { createRequire } = require('module');",
    "const req = createRequire(process.argv[1]);",
    "const bad = [];",
    "for (const d of process.argv.slice(2)) { try { req(d); } catch (e) { bad.push(d + ': ' + String((e && e.message) || e)); } }",
    "if (bad.length) { console.error(bad.join(' | ')); process.exit(1); }"
  ].join("\n");
  const r = await runCmd(process.execPath, ["-e", script, path.join(dir, "package.json"), ...deps], dir, 60000);
  return r.code === 0
    ? { ok: true, detail: `all ${deps.length} declared dependencies load (${deps.join(", ")})` }
    : { ok: false, detail: tail(r.output.trim(), 400) || "a dependency failed to load" };
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

// Static route-presence checks derived from the plan: for a planned
// get-one like GET /api/bookings/1, server.js must register the
// parameterised route '/api/bookings/:'. A missing route otherwise shows
// up only as an unexplained 404 in the live tests.
export function routeChecks(files: Record<string, string>, tests: AgentEndpointTest[]): CheckResult[] {
  const code = String(files["server.js"] || "");
  const out: CheckResult[] = [];
  for (const t of tests) {
    const m = t.path.match(/^(\/api\/[a-z0-9-]+)\/(\d+)$/i);
    if (t.method === "GET" && m) {
      const prefix = `${m[1]}/:`;
      const ok = code.includes(prefix);
      out.push({ name: `Route: GET ${m[1]}/:id`, ok, detail: ok ? "get-one route registered" : `server.js never registers a get-one route like app.get('${m[1]}/:id', ...) — implement it with store.get(Number(req.params.id))` });
    }
  }
  return out;
}

export async function testProject(dir: string, files: Record<string, string>, tests: AgentEndpointTest[], env: Record<string, string> = {}): Promise<TestReport> {
  const results: CheckResult[] = [];
  let log = "";
  const envKeys = Object.keys(env);
  if (envKeys.length) log += `\n[env] sandbox running with variables: ${envKeys.join(", ")} (values never logged)\n`;
  // Store wiring check: the store must be required once at the top of
  // server.js — a require inside one handler leaves `store` undefined in
  // the others, which crashes the server on the first POST (seen live).
  const serverCode = String(files["server.js"] || "");
  const storeReqIdx = serverCode.search(/const\s+store\s*=\s*require\(['"]\.\/lib\/store['"]\)/);
  const firstRouteIdx = serverCode.search(/app\.(get|post|put|patch|delete|use)\(/);
  const storeWired = storeReqIdx >= 0 && (firstRouteIdx < 0 || storeReqIdx < firstRouteIdx);
  results.push({ name: "Store wiring", ok: storeWired, detail: storeWired ? "store required once at the top of server.js" : "server.js must require('./lib/store') once at the top of the file, before any route" });
  if (!storeWired) return { ok: false, results, log, testedAt: new Date().toISOString() };
  // Database wiring check: when the build provides DATABASE_URL, the
  // backend must actually read it — a server that silently uses its own
  // localhost defaults passes syntax checks and then fails every boot.
  if (env.DATABASE_URL) {
    const wired = Object.values(files).some(c => String(c).includes("DATABASE_URL"));
    results.push({ name: "Database wiring", ok: wired, detail: wired ? "the data store reads process.env.DATABASE_URL" : "DATABASE_URL was provided but no project file reads it" });
    if (!wired) return { ok: false, results, log, testedAt: new Date().toISOString() };
  }
  results.push(...routeChecks(files, tests));
  // Seed declarations check: the generator sometimes passes SEED /
  // SEED_<RESOURCE> to store.init without declaring the arrays — a
  // runtime ReferenceError no syntax check can see. Generation injects
  // missing declarations deterministically (see agentAi), so this only
  // fails for a shape the normalizer could not map; naming the exact
  // identifier gives the repair loop a precise target.
  const undeclaredSeeds = undeclaredSeedNames(serverCode);
  results.push({
    name: "Seed declarations",
    ok: undeclaredSeeds.length === 0,
    detail: undeclaredSeeds.length === 0
      ? "every SEED array the code uses is declared"
      : `server.js uses ${undeclaredSeeds.join(", ")} without declaring ${undeclaredSeeds.length === 1 ? "it" : "them"} — declare each as a const array of at least 3 seed items near the top of the file`
  });
  results.push(...await syntaxChecks(dir, files));
  if (results.some(r => !r.ok)) return { ok: false, results, log, testedAt: new Date().toISOString() };

  const install = await runCmd("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], dir, 240000);
  log += "\n[npm install]\n" + tail(install.output, 1500);
  results.push({ name: "Install dependencies", ok: install.code === 0, detail: install.code === 0 ? "npm install succeeded" : tail(install.output, 500) });
  if (install.code !== 0) return { ok: false, results, log: tail(log), testedAt: new Date().toISOString() };

  // Install integrity: verify the installed tree actually loads before
  // blaming the app for a boot failure. A corrupt tree earns ONE clean
  // reinstall (node_modules wiped) — only a tree that still cannot load
  // afterwards fails the gate here.
  const integrity = await smokeLoadDeps(dir);
  if (integrity.ok) {
    results.push({ name: "Install integrity", ok: true, detail: integrity.detail });
  } else {
    log += `\n[install integrity] dependency smoke-load failed (${integrity.detail}) — wiping node_modules and reinstalling once\n`;
    await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true }).catch(() => {});
    const reinstall = await runCmd("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], dir, 240000);
    log += "\n[npm install — clean reinstall]\n" + tail(reinstall.output, 1500);
    if (reinstall.code !== 0) {
      results.push({ name: "Install integrity", ok: false, detail: `dependency smoke-load failed (${integrity.detail}) and the clean reinstall also failed: ${tail(reinstall.output, 300)}` });
      return { ok: false, results, log: tail(log), testedAt: new Date().toISOString() };
    }
    const retry = await smokeLoadDeps(dir);
    results.push({
      name: "Install integrity",
      ok: retry.ok,
      detail: retry.ok
        ? `the first install was corrupt (${integrity.detail}); a clean reinstall loads correctly`
        : `dependencies still fail to load after a clean reinstall: ${retry.detail}`
    });
    if (!retry.ok) return { ok: false, results, log: tail(log), testedAt: new Date().toISOString() };
  }

  const port = 20000 + Math.floor(Math.random() * 20000);
  let serverOut = "";
  const child = spawn(process.execPath, ["server.js"], { cwd: dir, env: { ...process.env, ...env, PORT: String(port), NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => { serverOut = (serverOut + d.toString()).slice(-50000); });
  child.stderr?.on("data", (d) => { serverOut = (serverOut + d.toString()).slice(-50000); });
  try {
    const up = await waitForServer(port, child);
    results.push({ name: "Server boots", ok: up, detail: up ? `listening on port ${port}` : `server did not answer /api/health in time — output: ${tail(serverOut, 300)}` });
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

// Vision pass on the screenshot — the same Qwen endpoint Bera AI uses
// for image understanding (verified contract: {imageBase64, query} ->
// {data:{reply}}). Judges only CLEAR breakage; any failure of the vision
// service itself returns ok:null and never blocks a build.
async function visionCheck(jpegDataUri: string): Promise<{ ok: boolean | null; issues: string[]; detail: string }> {
  try {
    const r = await fetch("https://apiz.xcasper.space/api/ai/qwen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: jpegDataUri,
        query: "This is a screenshot of a newly deployed web app. Is the page VISIBLY broken? Reply with ONLY a JSON object: {\"ok\": boolean, \"issues\": [short strings]}. ok=false ONLY for clear breakage: an error message or stack trace shown on the page, a blank or missing content area, placeholder/lorem ipsum text, raw JSON or code dumped as the page, or overlapping unreadable layout. Simple or plain styling is FINE — ok=true."
      }),
      signal: AbortSignal.timeout(45000)
    });
    const data: any = await r.json().catch(() => null);
    const reply = String(data?.data?.reply || "");
    const m = reply.match(/\{[\s\S]*\}/);
    if (!m) return { ok: null, issues: [], detail: "Vision check replied without a verdict — treated as unavailable" };
    const parsed = JSON.parse(m[0]);
    const issues = Array.isArray(parsed.issues) ? parsed.issues.map((i: any) => String(i)).slice(0, 5) : [];
    const ok = parsed.ok === false ? false : true;
    return { ok, issues, detail: ok ? "Vision check: the page looks intact" : `Vision check: the page looks broken — ${issues.join("; ") || "unspecified"}` };
  } catch {
    return { ok: null, issues: [], detail: "Vision check unavailable (the vision service did not answer)" };
  }
}

async function browserTier(url: string, tests: AgentEndpointTest[] = []): Promise<LiveCheckReport["browser"]> {
  const dynamicImport = (spec: string) => (Function("s", "return import(s)") as any)(spec);
  // Shared page run for any puppeteer/playwright-shaped browser: load the
  // page, collect JS errors, measure the rendered text (a page that loads
  // but renders nothing is a failure the HTTP checks cannot see), and
  // capture a screenshot for the build card.
  const runWithPage = async (browser: any): Promise<LiveCheckReport["browser"]> => {
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e?.message || e)));
      page.on("console", (msg: any) => { if (msg.type() === "error") errors.push(msg.text()); });
      try { await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 }); }
      catch { await page.goto(url, { timeout: 30000 }); }

      // --- Interaction flow: behave like a user. If the page has a form
      // and the plan has a create sample, fill the form with the sample
      // values, submit it, and require the sample's marker text to show
      // up in the page afterwards (and no new JS errors while doing it).
      const sample = tests.find(t => ["POST", "PUT", "PATCH"].includes(t.method) && t.body && Object.keys(t.body).length > 0);
      const marker = sample ? (Object.values(sample.body as Record<string, unknown>).filter(v => typeof v === "string") as string[]).sort((a, b) => b.length - a.length)[0] : undefined;
      let flow: LiveCheckReport["browser"]["flow"];
      if (!sample) {
        flow = { attempted: false, ok: true, detail: "No create action in the plan — no interaction to test" };
      } else {
        const filled: any = await page.evaluate((sampleBody: any) => {
          const form = document.querySelector("form");
          if (!form) return { hasForm: false, filled: 0 };
          const keys = Object.keys(sampleBody || {});
          let n = 0;
          form.querySelectorAll("input, select, textarea").forEach((el: any) => {
            const type = String(el.getAttribute("type") || "text").toLowerCase();
            if (["submit", "button", "hidden", "file", "checkbox", "radio", "reset"].includes(type) || el.disabled) return;
            const hint = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
            let v: any;
            for (const k of keys) { if (hint.includes(k.toLowerCase())) { v = sampleBody[k]; break; } }
            if (v === undefined) {
              if (type === "number" || type === "range") v = 42;
              else if (type === "email") v = "test@example.com";
              else if (type === "tel") v = "0700000000";
              else if (type === "date") v = new Date().toISOString().slice(0, 10);
              else v = "Test entry";
            }
            if (el.tagName === "SELECT") {
              const opt = [...el.options].find((o: any) => String(o.value) === String(v)) || el.options[1] || el.options[0];
              if (!opt) return;
              el.value = opt.value;
            } else { el.value = String(v); }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            n++;
          });
          return { hasForm: true, filled: n };
        }, sample.body).catch(() => ({ hasForm: false, filled: 0 }));
        if (!filled.hasForm) {
          flow = { attempted: false, ok: true, detail: "The page has no form — no interaction to test" };
        } else {
          const errorsBefore = errors.length;
          await page.evaluate(() => {
            const form = document.querySelector("form") as any;
            if (!form) return;
            const btn = form.querySelector('[type="submit"], button');
            if (btn) btn.click(); else if (form.requestSubmit) form.requestSubmit(); else form.submit();
          }).catch(() => {});
          if (page.waitForNetworkIdle) await page.waitForNetworkIdle({ timeout: 6000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 1500));
          const afterText: string = await page.evaluate(() => (document.body?.innerText || "")).catch(() => "");
          const newErrors = errors.slice(errorsBefore);
          const markerSeen = marker ? afterText.includes(marker) : afterText.trim().length > 0;
          if (newErrors.length) flow = { attempted: true, ok: false, detail: `Submitting the form produced JS error(s): ${newErrors[0]}` };
          else if (!markerSeen) flow = { attempted: true, ok: false, detail: `Submitted the form (${filled.filled} field(s) filled with the plan's sample data) but the new entry ("${marker}") never appeared on the page — the create flow looks broken` };
          else flow = { attempted: true, ok: true, detail: `Filled and submitted the form like a user; the new entry ("${marker}") appeared on the page` };
        }
      }

      const text: string = await page.evaluate(() => (document.body?.innerText || "").trim()).catch(() => "");
      let screenshot: string | undefined;
      let vision: LiveCheckReport["browser"]["vision"];
      try {
        const shot = await page.screenshot({ type: "png" });
        screenshot = "data:image/png;base64," + Buffer.from(shot as any).toString("base64");
      } catch { /* screenshot is a bonus; the checks above still count */ }
      try {
        const jpeg = await page.screenshot({ type: "jpeg", quality: 70 });
        vision = await visionCheck("data:image/jpeg;base64," + Buffer.from(jpeg as any).toString("base64"));
      } catch { vision = { ok: null, issues: [], detail: "Vision check unavailable (screenshot failed)" }; }

      const blank = text.length < 20;
      const ok = errors.length === 0 && !blank && flow.ok && vision.ok !== false;
      const bits: string[] = [];
      bits.push(blank ? "Page loaded in a real browser but rendered almost no content (blank page)"
        : errors.length === 0 ? "Page loaded in a real browser with no JS errors and visible content"
        : `Page loaded with ${errors.length} JS error(s)`);
      if (flow.attempted) bits.push(flow.detail);
      if (vision.ok === false) bits.push(vision.detail);
      return { available: true, ok, detail: bits.join(" — "), consoleErrors: errors.slice(0, 5), screenshot, flow, vision };
    } finally { await browser.close().catch(() => {}); }
  };
  // 1. The Chromium bundled WITH the platform (@sparticuz/chromium +
  // puppeteer-core are api-server dependencies, so this tier is always
  // installed — the live check no longer depends on the host's setup).
  try {
    const chromium = (await dynamicImport("@sparticuz/chromium")).default;
    const puppeteer = (await dynamicImport("puppeteer-core")).default;
    const browser = await puppeteer.launch({
      args: [...(chromium.args || []), "--no-sandbox"],
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: chromium.defaultViewport || { width: 1280, height: 800 }
    });
    return await runWithPage(browser);
  } catch { /* bundled runtime failed — try host-provided browsers */ }
  // 2. Playwright, then full Puppeteer, if the host provides them.
  try {
    const pw = await dynamicImport("playwright");
    const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
    return await runWithPage(browser);
  } catch { /* not installed — try puppeteer */ }
  try {
    const pp = await dynamicImport("puppeteer");
    const browser = await pp.launch({ args: ["--no-sandbox"] });
    return await runWithPage(browser);
  } catch { /* not installed either */ }
  return { available: false, detail: "The bundled Chromium runtime failed to start on this host and no Playwright/Puppeteer fallback is installed, so the browser tier was skipped — the HTTP + API live checks above still ran." };
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
  const browser = await browserTier(publicUrl, tests);
  if (browser.available) {
    checks.push({ name: "Browser render check", ok: Boolean(browser.ok), detail: browser.detail + (browser.consoleErrors?.length ? ` — ${browser.consoleErrors.join(" | ")}` : "") });
  }
  return { ok: checks.every(c => c.ok), url: publicUrl, status: page.result.status, title, checks, browser, checkedAt: new Date().toISOString() };
}
