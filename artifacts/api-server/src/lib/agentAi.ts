// Agent Bera's generation engine: the same Casper chat providers Bera AI
// uses, plus the continuation-stitching the WhatsApp builder relies on.
// The chat endpoints cap each reply at a few thousand characters — far
// less than a complete website — so generation asks for continuations and
// stitches them until the file genuinely ends with </html>.

import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

const textFrom = (data: any, depth = 0): string => {
  if (depth > 6 || data == null) return "";
  if (typeof data === "string") return data.trim();
  if (Array.isArray(data)) {
    for (const v of data) { const t = textFrom(v, depth + 1); if (t) return t; }
    return "";
  }
  if (typeof data !== "object") return "";
  const fields = ["reply", "result", "response", "answer", "text", "content", "message", "output", "generated_text", "completion", "choices", "candidates", "data"];
  for (const key of fields) {
    if (!(key in data)) continue;
    const v = data[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") { const t = textFrom(v, depth + 1); if (t) return t; }
  }
  const keys = Object.keys(data);
  if (keys.length && keys.every(k => /^\d+$/.test(k) && typeof (data as any)[k] === "string")) {
    return keys.sort((a, b) => Number(a) - Number(b)).map(k => (data as any)[k]).join("").trim();
  }
  return "";
};

export async function agentChat(prompt: string, timeoutMs = 120000): Promise<string> {
  const providers: Array<(q: string) => string> = [
    q => "https://apiz.xcasper.space/api/ai/deepseek?model=v4-flash&query=" + encodeURIComponent(q),
    q => "https://apiz.xcasper.space/api/ai/publicai-chat?message=" + encodeURIComponent(q),
    q => "https://apiz.xcasper.space/api/ai/gemini?query=" + encodeURIComponent(q),
    q => "https://apiz.xcasper.space/api/ai/keithai?prompt=" + encodeURIComponent(q)
  ];
  const errors: string[] = [];
  for (const make of providers) {
    try {
      const r = await fetch(make(prompt), { signal: AbortSignal.timeout(timeoutMs) });
      const j: any = await r.json().catch(() => null);
      const t = textFrom(j);
      if (t) return t;
      errors.push("empty response");
    } catch (e: any) { errors.push(String(e?.message || e)); }
  }
  throw new Error(`The AI builder is unavailable right now (${errors.join("; ")}). Please try again in a moment.`);
}

const DESIGN_RULES = [
  "You are Agent Bera, an expert web developer. Build the website the user describes as ONE complete, self-contained HTML file.",
  "Rules:",
  "- Output ONLY the HTML code. No markdown fences, no explanations, no commentary.",
  "- All CSS in a <style> tag in <head>, all JS in a <script> tag before </body>. No external files.",
  "- Modern, professional, agency-quality design: strong typography (Google Fonts via CDN link is allowed), generous spacing, real copy written for the business (never lorem ipsum).",
  "- Commit to a visual theme that fits the business (e.g. dark + neon accent for gyms/tech, warm tones for coffee/food, clean light for professional services).",
  "- Mobile-friendly: include <meta name=\"viewport\"> and responsive CSS with media queries.",
  "- Use real photos from Unsplash source URLs (https://images.unsplash.com/photo-<id>?w=1200&q=80) where images help; pick photo IDs that plausibly match the business type.",
  "- Include the sections a real site needs: header/nav, hero, about/services, highlights or menu/pricing where relevant, testimonials, contact section with a footer.",
  "- Interactive touches with vanilla JS: mobile menu, smooth scroll, a working contact form (front-end only, shows a success message).",
  "- The file MUST be complete: end with </body></html> and never stop mid-tag."
].join("\n");

const stripFences = (s: string) => String(s || "").replace(/^\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
export const looksComplete = (h: string) => /<html[\s>]/i.test(h) && /<\/html>\s*$/i.test(h) && h.length > 600;

export async function generateSite(promptText: string): Promise<string> {
  const full = "System: " + DESIGN_RULES + "\n\nUser: Build this website: " + promptText +
    "\n\nKeep the code tight and efficient (compact CSS, no repetition) so the complete file stays as short as a polished site allows.";
  let html = stripFences(await agentChat(full, 150000));
  if (!/<html[\s>]/i.test(html)) throw new Error("The AI builder did not return a website. Please try again.");
  for (let i = 0; i < 6 && !/<\/html>\s*$/i.test(html); i++) {
    const tail = html.slice(-1500);
    const cont = stripFences(await agentChat(
      "System: You are continuing a single HTML file you were writing. Output ONLY the continuation of the code — no markdown fences, no explanations, do NOT restart the file and do NOT repeat anything already written. Finish the whole file, ending with </body></html>.\n\nUser: The file so far ends with this exact text:\n...\n" + tail + "\n\nContinue exactly from where that text stops.",
      150000));
    if (!cont) break;
    // If the continuation repeated a chunk of the existing tail, drop the
    // repeated prefix (longest overlap wins, minimum 40 chars to count).
    let append = cont;
    const maxOverlap = Math.min(800, html.length, cont.length);
    for (let k = maxOverlap; k >= 40; k--) {
      if (html.endsWith(cont.slice(0, k))) { append = cont.slice(k); break; }
    }
    html += append;
  }
  html = html.trim();
  if (!looksComplete(html)) throw new Error("The generated site came back incomplete, so nothing was published. Please try again.");
  return html;
}

export const slugify = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "my-site";

// The tiny static server every generated site ships with, so BeraHost can
// run it like any other Node web deployment (listens on the assigned PORT).
export const GENERATED_STATIC_SERVER = `'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, p);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>404 — Not found</h1>'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Serving on port ' + PORT));
`;

// ---------------------------------------------------------------------------
// Full-stack project generation (Agent Bera v2)
//
// The builder no longer stops at a static page. It plans a small Node +
// Express project (server.js backend + public/index.html frontend that
// talks to the API), generates each code file separately with the same
// continuation stitching, and declares the API endpoints up front so the
// build can be smoke-tested before anything is published.

export type AgentEndpointTest = {
  name?: string;
  method: string;
  path: string;
  body?: Record<string, any>;
  expected?: number[];
};

export type AgentResourcePlan = {
  name: string;
  endpoints: AgentEndpointTest[];
};

export type AgentProjectPlan = {
  appName: string;
  summary: string;
  resource: string;
  resources: AgentResourcePlan[];
  endpoints: AgentEndpointTest[];
};

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const defaultExpected = (method: string): number[] =>
  method === "POST" ? [200, 201] : method === "DELETE" ? [200, 204] : [200];

function sanitizeEndpoint(raw: any): AgentEndpointTest | null {
  if (!raw || typeof raw !== "object") return null;
  const method = String(raw.method || "GET").toUpperCase();
  if (!HTTP_METHODS.includes(method)) return null;
  let p = String(raw.path || "").trim();
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\s+/g, "").replace(/:id\b/g, "1").replace(/\{[^}]*\}/g, "1");
  if (!/^\/[A-Za-z0-9/_-]*$/.test(p)) return null;
  const expectedNums: number[] = Array.isArray(raw.expected)
    ? raw.expected.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n >= 100 && n <= 599)
    : [];
  // The gate is a smoke gate: an endpoint only counts as working when it
  // answers with a success status. A planner-supplied 4xx expectation
  // (e.g. "400 for invalid input") must never let a broken create/update
  // endpoint pass, so expectations are the planner's 2xx codes plus the
  // method's default success codes — nothing else.
  const expected = [...new Set([...expectedNums.filter(n => n >= 200 && n < 300), ...defaultExpected(method)])].slice(0, 4);
  const body = raw.body && typeof raw.body === "object" && !Array.isArray(raw.body) ? raw.body : undefined;
  return { name: raw.name ? String(raw.name).slice(0, 80) : undefined, method, path: p, body, expected: expected.length ? expected : defaultExpected(method) };
}

export function fallbackPlan(promptText: string): AgentProjectPlan {
  const p = promptText.toLowerCase();
  const resource = /booking|appointment|reservation/.test(p) ? "bookings"
    : /\b(products?|shop|store|inventory|menu|catalog)\b/.test(p) ? "products"
    : /\border/.test(p) ? "orders"
    : /task|todo/.test(p) ? "tasks"
    : /contact|message|enquir|inquir/.test(p) ? "messages"
    : "items";
  const appName = promptText.replace(/\s+/g, " ").trim().slice(0, 60) || "My App";
  const endpoints: AgentEndpointTest[] = [
    { name: "Health check", method: "GET", path: "/api/health", expected: [200] },
    { name: `List ${resource}`, method: "GET", path: `/api/${resource}`, expected: [200] },
    { name: `Create ${resource}`, method: "POST", path: `/api/${resource}`, body: { name: "Sample", price: 100, description: "Created by the Agent Bera endpoint test" }, expected: [200, 201] },
    { name: `Get one ${resource}`, method: "GET", path: `/api/${resource}/1`, expected: [200] }
  ];
  return {
    appName,
    summary: `Full-stack app for: ${promptText.slice(0, 160)}`,
    resource,
    resources: [{ name: resource, endpoints: endpoints.slice(1) }],
    endpoints
  };
}

function extractJsonObject(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export async function planProject(promptText: string, envKeys: string[] = []): Promise<AgentProjectPlan> {
  try {
    const raw = await agentChat(
      "System: You are Agent Bera's project planner. Reply with ONLY a JSON object, no markdown, no commentary.\n" +
      "Shape: {\"appName\": string, \"summary\": string, \"resources\": [{\"name\": string (one lowercase plural word for a data collection, e.g. products), \"endpoints\": [{\"name\": string, \"method\": \"GET|POST|PUT|PATCH|DELETE\", \"path\": \"/api/...\", \"body\": object (POST/PUT only, realistic sample data), \"expected\": [status codes]}]}]}\n" +
      "Rules: plan 1-3 resources — use MORE THAN ONE when the app naturally has several kinds of data (e.g. a gym has members AND payments AND checkins; a school has students AND fees). Each resource gets a list endpoint, a create endpoint with a realistic sample body, and a get-one endpoint using a concrete id like /api/products/1 (the app seeds data, so id 1 must exist). Add update/delete endpoints where they are natural. Keep the TOTAL across all resources to at most 10 endpoints. Paths must be concrete — no :params or placeholders.\n" +
      (envKeys.length ? `\nThe app will run with these environment variables available (names only): ${envKeys.join(", ")}. Plan the data layer around them (e.g. DATABASE_URL means a real Postgres database).\n` : "") +
      "\nUser: Plan a full-stack web app for this request: " + promptText,
      90000);
    const parsed = extractJsonObject(raw);
    if (!parsed) return fallbackPlan(promptText);
    const seen = new Set<string>();
    const cleanEndpoints = (list: any): AgentEndpointTest[] => (Array.isArray(list) ? list : [])
      .map(sanitizeEndpoint).filter(Boolean)
      .filter((e: any) => { const k = `${(e as AgentEndpointTest).method} ${(e as AgentEndpointTest).path}`; if (seen.has(k)) return false; seen.add(k); return true; }) as AgentEndpointTest[];
    let resources: AgentResourcePlan[] = [];
    if (Array.isArray(parsed.resources) && parsed.resources.length) {
      resources = parsed.resources.slice(0, 3).map((r: any) => ({
        name: String(r?.name || "items").toLowerCase().replace(/[^a-z]/g, "").slice(0, 24) || "items",
        endpoints: cleanEndpoints(r?.endpoints)
      })).filter((r: AgentResourcePlan) => r.endpoints.length > 0);
    }
    if (!resources.length && Array.isArray(parsed.endpoints)) {
      // Single-resource shape from earlier planner versions.
      const resource = String(parsed.resource || "items").toLowerCase().replace(/[^a-z]/g, "").slice(0, 24) || "items";
      resources = [{ name: resource, endpoints: cleanEndpoints(parsed.endpoints).filter(e => e.path !== "/api/health") }];
    }
    if (!resources.length || resources.every(r => r.endpoints.length === 0)) return fallbackPlan(promptText);
    const endpoints: AgentEndpointTest[] = [{ name: "Health check", method: "GET", path: "/api/health", expected: [200] },
      ...resources.flatMap(r => r.endpoints).filter(e => e.path !== "/api/health")].slice(0, 11);
    if (endpoints.length < 3) return fallbackPlan(promptText);
    return {
      appName: String(parsed.appName || "").replace(/\s+/g, " ").trim().slice(0, 60) || fallbackPlan(promptText).appName,
      summary: String(parsed.summary || "").replace(/\s+/g, " ").trim().slice(0, 240),
      resource: resources[0].name,
      resources,
      endpoints
    };
  } catch {
    return fallbackPlan(promptText);
  }
}

const stripAnyFences = (s: string) => String(s || "").replace(/^\s*```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/i, "").trim();

function trimOverlap(existing: string, cont: string): string {
  const maxOverlap = Math.min(800, existing.length, cont.length);
  for (let k = maxOverlap; k >= 40; k--) {
    if (existing.endsWith(cont.slice(0, k))) return cont.slice(k);
  }
  return cont;
}

// Generate one code file, stitching continuations until `isComplete` says
// the file is finished (the chat endpoints truncate long replies).
async function stitchCode(firstPrompt: string, fileLabel: string, isComplete: (code: string) => boolean, maxRounds = 5): Promise<string> {
  let code = stripAnyFences(await agentChat(firstPrompt, 150000));
  for (let i = 0; i < maxRounds && !isComplete(code); i++) {
    const tail = code.slice(-1500);
    let cont = stripAnyFences(await agentChat(
      `System: You are continuing a single ${fileLabel} file you were writing. Output ONLY the continuation of the code — no markdown fences, no explanations, do NOT restart the file and do NOT repeat anything already written. Do NOT redeclare any variable, function or constant that already exists earlier in the file. Finish the whole file completely.\n\nUser: The file so far ends with this exact text:\n...\n${tail}\n\nContinue exactly from where that text stops.`,
      150000));
    if (!cont) {
      // A single empty reply from the provider is usually transient —
      // wait and ask once more before giving up on the file.
      await new Promise(r => setTimeout(r, 3000));
      cont = stripAnyFences(await agentChat(
        `System: You are continuing a single ${fileLabel} file you were writing. Output ONLY the continuation of the code — no markdown fences, no explanations, do NOT restart the file. Finish the whole file completely.\n\nUser: The file so far ends with this exact text:\n...\n${tail}\n\nContinue exactly from where that text stops.`,
        150000));
      if (!cont) break;
    }
    code += trimOverlap(code, cont);
  }
  return code.trim();
}

const BACKEND_RULES = [
  "You are Agent Bera, an expert Node.js backend developer. Write ONE complete server.js file (CommonJS) for the app described.",
  "Rules:",
  "- Output ONLY the JavaScript code. No markdown fences, no explanations.",
  "- Use ONLY the 'express' npm package plus Node built-ins (path, fs). No other dependencies. NEVER require axios, node-fetch or any other undeclared package — if you need to call an API, use the built-in fetch.",
  "- app.use(express.json()) and serve the frontend with express.static(path.join(__dirname, 'public')). NEVER use body-parser — Express already includes it as express.json() / express.urlencoded().",
  "- Implement GET /api/health returning JSON {ok:true}.",
  "- DATA LAYER IS PROVIDED: the project already contains lib/store.js exporting an async store — init(seedItems), list(), get(id), create(data), update(id, data), remove(id). NEVER write SQL, NEVER create a database pool, NEVER keep your own array as the store. Require it exactly like this: const store = require('./lib/store');",
  "- MULTI-RESOURCE APPS: when the plan has several resources, use ONE collection per resource: const orders = store.collection('orders'); — every collection has the SAME async init/list/get/create/update/remove interface. The default store methods (store.list() etc.) serve the FIRST resource; name a collection for each additional one.",
  "- Define a SEED array per resource (const SEED = [...] for the first, const SEED_<RESOURCE> = [...] for the others) with at least 3 realistic items each as plain objects (NO id field — the store assigns ids 1, 2, 3). Start inside an async function: await the init of EVERY collection BEFORE app.listen, so GET /api/<resource>/1 returns the first seeded item of each resource.",
  "- Require the store ONCE at the very top of the file (const store = require('./lib/store');) — NEVER inside a route handler, and never re-require it. Every store method is async: ALWAYS await store calls. store.create(data) and store.update(id, data) return the item object directly (update returns null when missing) — there is NO { data, error } wrapper.",
  "- Wrap EVERY route handler body in try { ... } catch (e) { res.status(500).json({ error: 'internal error' }); } — a throwing async handler crashes the whole server and fails the build.",
  "- Validation: only check the exact fields present in the plan's sample POST body, and accept that body — never require fields the plan does not use.",
  "- Get-one MUST be its own concrete handler: app.get('/api/<resource>/:id', ...) with store.get(Number(req.params.id)). NEVER write generic placeholder routes like app.get('/api/:category') — every planned endpoint gets a real handler.",
  "- Implement every API endpoint in the plan exactly as specified using the store: list = await store.list(); get-one = await store.get(Number(req.params.id)) (null -> 404 JSON); create = await store.create(body) (answer 201); update = await store.update(Number(req.params.id), body) (null -> 404); remove = await store.remove(Number(req.params.id)) (true -> 204, false -> 404).",
  "- Register specific routes (e.g. /api/products/low-stock) BEFORE parameterised routes (e.g. /api/products/:id), or Express will swallow them.",
  "- POST create endpoints validate the body, assign the next numeric id, and answer 201 with the created item as JSON.",
  "- Unknown /api/* routes answer 404 JSON. Add a JSON error handler. Never crash on bad input.",
  "- Listen on process.env.PORT || 3000 and log a startup line.",
  "- Declare every top-level name (app, PORT, pool, stores) exactly ONCE — a duplicated const declaration is a syntax error that fails the build.",
  "- Output code only: no prose, no notes, no explanations, no markdown anywhere in the file.",
  "- The file MUST be complete and syntactically valid — finish it, never stop mid-function."
].join("\n");

// The deterministic data layer every generated app ships with. The AI
// writes routes and pages; it does NOT write storage code — experience
// (five failed verification runs) showed pool setup, seeding and SQL are
// exactly where generated backends break. This store is fixed, tested
// code: Postgres via DATABASE_URL when set, in-memory otherwise, with an
// identical async interface either way.
export const GENERATED_STORE = `'use strict';
// Data store provided by Agent Bera — do not edit; server.js builds on it.
// Postgres (DATABASE_URL) when available, in-memory otherwise.
// A default collection (init/list/get/create/update/remove) plus named
// collections via store.collection('orders') for multi-resource apps.
let pool = null;
async function db() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}
function tableFor(name) {
  const clean = String(name || 'items').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) || 'items';
  return clean === 'items' ? 'items' : 'items_' + clean;
}
function makeCollection(name) {
  const table = tableFor(name);
  let dbReady = false;
  let memory = [];
  let nextId = 1;
  async function init(seedItems) {
    const seeds = Array.isArray(seedItems) ? seedItems : [];
    if (process.env.DATABASE_URL) {
      try {
        const p = await db();
        await p.query('CREATE TABLE IF NOT EXISTS ' + table + ' (id SERIAL PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())');
        const found = await p.query('SELECT COUNT(*)::int AS n FROM ' + table);
        if (found.rows[0].n === 0) {
          for (let i = 0; i < seeds.length; i++) {
            await p.query('INSERT INTO ' + table + ' (id, data) VALUES ($1, $2)', [i + 1, JSON.stringify(seeds[i])]);
          }
          if (seeds.length) await p.query("SELECT setval(pg_get_serial_sequence('" + table + "', 'id'), (SELECT MAX(id) FROM " + table + "))");
        }
        dbReady = true;
        return;
      } catch (e) {
        console.error('[store] database unavailable for ' + table + ', using memory instead:', e.message);
        dbReady = false;
      }
    }
    memory = seeds.map((item, i) => ({ id: i + 1, ...item }));
    nextId = memory.length + 1;
  }
  async function list() {
    if (dbReady) {
      const p = await db();
      const r = await p.query('SELECT id, data FROM ' + table + ' ORDER BY id ASC');
      return r.rows.map(row => ({ id: row.id, ...row.data }));
    }
    return [...memory];
  }
  async function get(id) {
    if (dbReady) {
      const p = await db();
      const r = await p.query('SELECT id, data FROM ' + table + ' WHERE id = $1', [id]);
      return r.rows.length ? { id: r.rows[0].id, ...r.rows[0].data } : null;
    }
    return memory.find(item => item.id === Number(id)) || null;
  }
  async function create(data) {
    if (dbReady) {
      const p = await db();
      const r = await p.query('INSERT INTO ' + table + ' (data) VALUES ($1) RETURNING id', [JSON.stringify(data || {})]);
      return { id: r.rows[0].id, ...(data || {}) };
    }
    const item = { id: nextId++, ...(data || {}) };
    memory.push(item);
    return item;
  }
  async function update(id, data) {
    if (dbReady) {
      const p = await db();
      const r = await p.query('UPDATE ' + table + ' SET data = data || $2::jsonb WHERE id = $1 RETURNING id, data', [id, JSON.stringify(data || {})]);
      return r.rows.length ? { id: r.rows[0].id, ...r.rows[0].data } : null;
    }
    const idx = memory.findIndex(item => item.id === Number(id));
    if (idx < 0) return null;
    memory[idx] = { ...memory[idx], ...(data || {}), id: memory[idx].id };
    return memory[idx];
  }
  async function remove(id) {
    if (dbReady) {
      const p = await db();
      const r = await p.query('DELETE FROM ' + table + ' WHERE id = $1', [id]);
      return r.rowCount > 0;
    }
    const idx = memory.findIndex(item => item.id === Number(id));
    if (idx < 0) return false;
    memory.splice(idx, 1);
    return true;
  }
  return { init, list, get, create, update, remove };
}
const collections = new Map();
function collection(name) {
  const key = tableFor(name);
  if (!collections.has(key)) collections.set(key, makeCollection(name));
  return collections.get(key);
}
const main = collection('items');
module.exports = { init: main.init, list: main.list, get: main.get, create: main.create, update: main.update, remove: main.remove, collection };
`;

function backendRules(envKeys: string[]): string {
  let rules = BACKEND_RULES;
  if (envKeys.length) {
    rules += `\n- The app runs with these environment variables set: ${envKeys.join(", ")}. The provided lib/store.js already uses DATABASE_URL when present — you never handle database connections yourself.`;
  }
  return rules;
}

// Deterministic cleanup for a known generator habit: the model loves
// require('body-parser') even though Express ships the same functions
// built in (this exact habit broke a Bera AI build in Nov 2026). The
// rewrite is mechanical and safe: drop the require, point its calls at
// express.* equivalents.
export function normalizeServerCode(code: string): string {
  let out = code;
  const varMatch = out.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]body-parser['"]\s*\)\s*;?/);
  if (varMatch) {
    const name = varMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*require\\(\\s*['"]body-parser['"]\\s*\\)\\s*;?`), "");
    out = out.replace(new RegExp(`\\b${name}\\.(json|urlencoded|text|raw)\\(`, "g"), "express.$1(");
  }
  out = out.replace(/require\(\s*['"]body-parser['"]\s*\)\.(json|urlencoded|text|raw)\(/g, "express.$1(");
  return out;
}

// The model sometimes wraps code in prose ("Note: this response assumes
// ..."). Cut a prose preamble before the first code-looking line and any
// trailing note block; the sandbox syntax check verifies the result.
export function stripProseAroundCode(code: string): string {
  const lines = code.split("\n");
  const codeStart = /^\s*(const\b|let\b|var\b|function\b|async\b|require\(|import\b|process\.|module\.exports|'use strict'|"use strict"|\/\/|\/\*|app\.|express\b|\/\/)/;
  let start = lines.findIndex(l => codeStart.test(l));
  if (start < 0) start = 0;
  let end = lines.length;
  for (let i = start + 5; i < lines.length; i++) {
    if (/^\s*(Note:|Please note|This (response|code|implementation|version)|In summary|I hope|Let me know)/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}

// Syntax self-check with the real Node parser, so a broken generation is
// retried inside the generator instead of burning a sandbox repair round.
export async function jsParses(code: string): Promise<boolean> {
  const file = path.join(os.tmpdir(), `agent-bera-check-${Date.now()}-${Math.floor(Math.random() * 1e6)}.js`);
  try {
    await fs.writeFile(file, code);
    return await new Promise<boolean>((resolve) => {
      const child = spawn(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"] });
      child.on("close", (c) => resolve(c === 0));
      child.on("error", () => resolve(false));
    });
  } catch { return false; }
  finally { await fs.rm(file, { force: true }).catch(() => {}); }
}

function endpointListText(plan: AgentProjectPlan, withBodies: boolean): string {
  const line = (e: AgentEndpointTest) => `- ${e.method} ${e.path}${withBodies && e.body ? " (JSON body fields: " + Object.keys(e.body).join(", ") + ")" : ""}`;
  if (!plan.resources || plan.resources.length <= 1) return plan.endpoints.map(line).join("\n");
  return plan.resources.map(r => `Resource "${r.name}" (data: store.collection('${r.name}')):\n` + r.endpoints.map(line).join("\n")).join("\n\n") +
    "\n\nAlso: GET /api/health";
}

export async function generateBackendServer(promptText: string, plan: AgentProjectPlan, envKeys: string[] = []): Promise<string> {
  const endpointList = endpointListText(plan, true);
  let code = await stitchCode(
    "System: " + backendRules(envKeys) + "\n\nUser: App: " + plan.appName + " — " + plan.summary + "\nOriginal request: " + promptText + "\n\nEndpoints to implement:\n" + endpointList,
    "server.js",
    (c) => c.includes("express") && c.includes("listen") && c.includes("lib/store") && c.length > 500);
  code = stripProseAroundCode(normalizeServerCode(code));
  if (!code.includes("express") || !code.includes("/api/health")) {
    throw new Error("The generated backend was incomplete, so nothing was published. Please try again.");
  }
  if (!(await jsParses(code))) {
    // One internal regeneration when the stitched file does not parse —
    // a fresh attempt usually beats repairing a broken file.
    try {
      const retry = stripProseAroundCode(normalizeServerCode(await stitchCode(
        "System: " + backendRules(envKeys) + "\n\nUser: App: " + plan.appName + " — " + plan.summary + "\nOriginal request: " + promptText + "\n\nEndpoints to implement:\n" + endpointList + "\n\nIMPORTANT: the previous attempt was syntactically invalid JavaScript. Write clean, simple, valid code. Output ONLY code.",
        "server.js",
        (c) => c.includes("express") && c.includes("listen") && c.includes("lib/store") && c.length > 500)));
      if ((await jsParses(retry)) && retry.includes("/api/health")) code = retry;
    } catch { /* keep the first attempt; the sandbox gate decides */ }
  }
  return code;
}

export async function repairBackendServer(promptText: string, plan: AgentProjectPlan, currentCode: string, failureText: string, envKeys: string[] = []): Promise<string> {
  const endpointList = endpointListText(plan, false);
  // When the failure is a syntax error, the current file is poison as a
  // reference — repairs anchored on it kept reproducing the breakage in
  // testing. Regenerate cleanly instead, with the error named.
  const syntaxFailure = /SyntaxError|Syntax:/i.test(failureText);
  const instruction = syntaxFailure
    ? "\n\nThe previous server.js was SYNTACTICALLY INVALID:\n" + failureText.slice(0, 1500) +
      "\n\nWrite a brand-new, clean, complete server.js from scratch. Output ONLY code — no prose or notes anywhere. Declare every top-level name exactly once."
    : "\n\nThe current server.js below FAILED its pre-publish tests with these problems:\n" + failureText.slice(0, 1800) +
      "\n\nReturn the COMPLETE corrected server.js. Keep every working endpoint and all working code exactly as it is — change only what the failures require.\n\nCurrent server.js:\n" + currentCode.slice(0, 6500);
  let code = await stitchCode(
    "System: " + backendRules(envKeys) + "\n\nUser: App: " + plan.appName + " — " + plan.summary + "\nOriginal request: " + promptText +
    "\n\nEndpoints to implement:\n" + endpointList + instruction,
    "server.js",
    (c) => c.includes("express") && c.includes("listen") && c.includes("lib/store") && c.length > 500);
  code = stripProseAroundCode(normalizeServerCode(code));
  if (!code.includes("express") || !code.includes("/api/health")) {
    throw new Error("The repaired backend was still incomplete.");
  }
  return code;
}

const FRONTEND_RULES = [
  "You are Agent Bera, an expert front-end developer. Build the app's frontend as ONE complete HTML file saved as public/index.html.",
  "Rules:",
  "- Output ONLY the HTML code. No markdown fences, no explanations.",
  "- All CSS in a <style> tag in <head>, all JS in a <script> tag before </body>.",
  "- Keep the file compact and efficient (concise CSS, no repeated blocks) so the COMPLETE file stays as short as a polished page allows — target at most ~12,000 characters. An unfinished file is a failed build.",
  "- The page MUST load its real data from the backend API with fetch() — call the plan's main GET list endpoint and render the items dynamically (cards or a table). Never hard-code the data as the only source.",
  "- If the plan has a POST create endpoint, include a working form that POSTs JSON to it and refreshes the list, showing a success/error message.",
  "- On load, check GET /api/health and show a small 'API online/offline' status indicator.",
  "- Modern, professional design that fits the business: strong typography (Google Fonts CDN allowed), real copy (never lorem ipsum), a committed colour theme.",
  "- Mobile-friendly: <meta name=\"viewport\"> and responsive CSS with media queries.",
  "- The file MUST be complete: end with </body></html>."
].join("\n");

export async function generateFrontend(promptText: string, plan: AgentProjectPlan): Promise<string> {
  const endpointList = plan.endpoints.map(e => `- ${e.method} ${e.path}`).join("\n");
  const attempt = () => stitchCode(
    "System: " + FRONTEND_RULES + "\n\nUser: App: " + plan.appName + " — " + plan.summary + "\nOriginal request: " + promptText + "\n\nBackend API endpoints available:\n" + endpointList,
    "HTML",
    (c) => looksComplete(c),
    8);
  let html = await attempt();
  // Fresh regenerations if stitching still left the file unfinished —
  // a new attempt usually completes where a truncated one could not.
  for (let i = 0; i < 2 && !looksComplete(html); i++) html = await attempt();
  if (!looksComplete(html)) throw new Error("The generated frontend came back incomplete, so nothing was published. Please try again.");
  return html;
}

// An independent reviewer pass over the generated backend: a separate AI
// call whose only job is to find defects (missing endpoints, wrong status
// codes, store misuse) before the deterministic test gate runs. Advisory
// only — the sandbox gate stays the decider — but it catches design-level
// mistakes the endpoint tests would only surface as bare 404s.
export async function reviewBackendServer(plan: AgentProjectPlan, serverCode: string): Promise<string[]> {
  try {
    const raw = await agentChat(
      "System: You are a strict, independent code reviewer for Node.js/Express backends. Reply with ONLY a JSON object: {\"issues\": [string, ...]} — at most 6 short, concrete defects, or an empty array if the code is correct.\n" +
      "Check ONLY these things: (1) every planned endpoint is implemented with the exact method and path; (2) get-one routes use a parameterised path like /api/<resource>/:id; (3) the provided lib/store is required once at the top and every store/collection call is awaited; (4) each resource in the plan uses its own store collection; (5) create answers 201, missing items answer 404; (6) GET /api/health exists; (7) no require() of packages other than express and Node built-ins. Do NOT comment on style, naming or anything else.\n\n" +
      "Planned endpoints:\n" + endpointListText(plan, false) + "\n\nserver.js:\n" + serverCode.slice(0, 9000),
      90000);
    const parsed = extractJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.issues)) return [];
    return parsed.issues.map((x: any) => String(x).slice(0, 300)).filter(Boolean).slice(0, 6);
  } catch { return []; }
}

// Apply a follow-up instruction to an EXISTING app ("make the header
// blue", "add a phone field to orders"). Each file is edited separately
// and validated on its own — a file whose edit fails validation keeps its
// current version, so an edit can never make the app worse.
export async function editProjectFiles(instruction: string, plan: AgentProjectPlan, current: { server: string; frontend: string }, envKeys: string[] = []): Promise<{ server: string; frontend: string }> {
  let server = current.server;
  try {
    let code = await stitchCode(
      "System: " + backendRules(envKeys) + "\n\nUser: App: " + plan.appName + " — " + plan.summary +
      "\n\nApply this change to the app: " + instruction +
      "\n\nReturn the COMPLETE updated server.js. Keep every working endpoint and all working behaviour exactly as it is — change only what the instruction requires.\n\nEndpoints in the plan:\n" + endpointListText(plan, false) +
      "\n\nCurrent server.js:\n" + current.server.slice(0, 9000),
      "server.js",
      (c) => c.includes("express") && c.includes("listen") && c.includes("lib/store") && c.length > 500);
    code = stripProseAroundCode(normalizeServerCode(code));
    if (code.includes("express") && code.includes("/api/health") && (await jsParses(code))) server = code;
  } catch { /* keep the current backend */ }
  let frontend = current.frontend;
  try {
    const html = await stitchCode(
      "System: " + FRONTEND_RULES + "\n\nUser: App: " + plan.appName + " — " + plan.summary +
      "\n\nApply this change to the app's page: " + instruction +
      "\n\nReturn the COMPLETE updated HTML file. Keep everything else about the page exactly as it is — change only what the instruction requires.\n\nCurrent public/index.html:\n" + current.frontend.slice(0, 11000),
      "HTML",
      (c) => looksComplete(c),
      8);
    if (looksComplete(html)) frontend = html;
  } catch { /* keep the current frontend */ }
  return { server, frontend };
}

export async function generateProjectFiles(promptText: string, plan: AgentProjectPlan, packageName: string, envKeys: string[] = []): Promise<Record<string, string>> {
  const genBackend = async (): Promise<string> => {
    try { return await generateBackendServer(promptText, plan, envKeys); }
    catch { return await generateBackendServer(promptText, plan, envKeys); }
  };
  // Backend and frontend are independent files — generate them in
  // parallel instead of one after the other.
  const [generatedServer, frontend] = await Promise.all([genBackend(), generateFrontend(promptText, plan)]);
  let server = generatedServer;
  // Independent reviewer pass: fix design-level defects before the gate.
  const issues = await reviewBackendServer(plan, server);
  if (issues.length) {
    try {
      const repaired = await repairBackendServer(promptText, plan, server,
        "An independent reviewer found these defects in the generated backend:\n" + issues.map(i => "- " + i).join("\n"), envKeys);
      if ((await jsParses(repaired)) && repaired.includes("/api/health")) server = repaired;
    } catch { /* keep the original; the sandbox gate decides */ }
  }
  const endpointDocs = plan.endpoints.map(e => `- \`${e.method} ${e.path}\``).join("\n");
  // pg is always declared: lib/store.js requires it lazily, only when
  // DATABASE_URL is actually set at runtime.
  const dependencies: Record<string, string> = { express: "^4.19.2", pg: "^8.12.0" };
  return {
    "package.json": JSON.stringify({
      name: packageName,
      version: "1.0.0",
      private: true,
      description: plan.summary || `Built with Agent Bera: ${promptText.slice(0, 100)}`,
      scripts: { start: "node server.js" },
      dependencies
    }, null, 2),
    "server.js": server + "\n\n// Safety net added by Agent Bera: a throwing handler must not kill the app.\nprocess.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.message); });\n",
    "lib/store.js": GENERATED_STORE,
    "public/index.html": frontend,
    "README.md": `# ${plan.appName}\n\nBuilt with Agent Bera on BERAHOST from the prompt:\n\n> ${promptText}\n\n## API\n\n${endpointDocs}\n\n## Run\n\n\`\`\`\nnpm install\nnpm start\n\`\`\`\n\nThe server listens on \`process.env.PORT\`. Data is stored in Postgres when DATABASE_URL is set, otherwise in memory (resetting on restart).\n`
  };
}
