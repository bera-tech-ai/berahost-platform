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
  // Internal integrity marker: true when this plan came from the
  // deterministic keyword fallback (fallbackPlan) rather than the AI
  // planner — i.e. the AI plan could not be parsed and this is a guess.
  // The build's plan guard (agentBuild) uses it to detect a degraded
  // plan; it is never rendered to the user.
  degraded?: boolean;
  // Context the platform gathered before planning: the user's earlier
  // builds (memory) and, when the user supplied one, the explored
  // contract of an external API this app should be built against.
  historyNote?: string;
  externalApi?: { url: string; excerpt: string };
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
    endpoints,
    degraded: true
  };
}

function extractJsonObject(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export async function planProject(promptText: string, envKeys: string[] = [], context?: { history?: string; externalApi?: { url: string; excerpt: string } }): Promise<AgentProjectPlan> {
  const plan = await planProjectInner(promptText, envKeys, context);
  if (context?.externalApi) plan.externalApi = context.externalApi;
  if (context?.history) plan.historyNote = context.history;
  return plan;
}

async function planProjectInner(promptText: string, envKeys: string[] = [], context?: { history?: string; externalApi?: { url: string; excerpt: string } }): Promise<AgentProjectPlan> {
  try {
    const raw = await agentChat(
      "System: You are Agent Bera's project planner. Reply with ONLY a JSON object, no markdown, no commentary.\n" +
      "Shape: {\"appName\": string, \"summary\": string, \"resources\": [{\"name\": string (one lowercase plural word for a data collection, e.g. products), \"endpoints\": [{\"name\": string, \"method\": \"GET|POST|PUT|PATCH|DELETE\", \"path\": \"/api/...\", \"body\": object (POST/PUT only, realistic sample data), \"expected\": [status codes]}]}]}\n" +
      "Rules: plan 1-3 resources — use MORE THAN ONE when the app naturally has several kinds of data (e.g. a gym has members AND payments AND checkins; a school has students AND fees). Each resource gets a list endpoint, a create endpoint with a realistic sample body, and a get-one endpoint using a concrete id like /api/products/1 (the app seeds data, so id 1 must exist). Add update/delete endpoints where they are natural. Keep the TOTAL across all resources to at most 10 endpoints. Paths must be concrete — no :params or placeholders.\n" +
      (envKeys.length ? `\nThe app will run with these environment variables available (names only): ${envKeys.join(", ")}. Plan the data layer around them (e.g. DATABASE_URL means a real Postgres database).\n` : "") +
      (context?.history ? `\nThis user has built these apps before:\n${context.history}\nIf the new request refers to one of them ("like my coffee app", "similar to the gym one"), mirror that app's resources and structure, adapted to the new request.\n` : "") +
      (context?.externalApi ? `\nThe user wants this app built against an EXTERNAL API at ${context.externalApi.url} (available to the backend as the EXTERNAL_API_URL environment variable). The platform fetched that URL before planning; here is what it returned:\n---\n${context.externalApi.excerpt}\n---\nPlan this app's OWN /api endpoints so the backend can proxy and shape that external data for the frontend (the frontend only ever calls this app's own endpoints). Keep the same endpoint discipline: list, create where natural, get-one with a concrete id — for proxied data, get-one may map to the external API's own id.\n` : "") +
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

// --- Plan integrity ---------------------------------------------------------
// planProject falls back to fallbackPlan (one keyword-guessed resource)
// whenever the AI's plan JSON fails to parse — and for multi-resource
// requests the plan JSON is long, the chat reply cap truncates it, and
// parsing fails precisely on the biggest asks. Live builds 10 and 11
// (2026-11-28) both died this way: a prompt demanding users, products,
// team and enquiries was planned as products-only, and the build then
// generated the wrong (tiny) app. The guard below makes the degradation
// detectable: it extracts the resources the PROMPT itself demands,
// compares them against the plan, and lets the build re-plan once in a
// compact format (small enough to survive one reply) or stop honestly
// at the planning stage.

// Crude stemmer for comparing demanded names against plan names:
// lowercased, "-ies" -> "-y", one trailing "s" stripped ("users" and
// "user" compare equal, "enquiries" and "enquiry" compare equal).
function stemWord(w: string): string {
  let s = String(w || "").toLowerCase();
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 1 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

const DEMAND_STOPWORDS = new Set(["fields", "field", "endpoints", "endpoint", "resources", "resource", "note", "the", "a", "an", "data"]);

// The API roots a prompt DEMANDS, deterministically: every distinct
// /api/<segment> it names, plus the resource names it enumerates as
// spec lists — "(1) users — …", "1. users — …", "- users — …". An
// enumerated name only counts when a spec separator (—, – or :) follows
// it immediately, which is what keeps feature bullets ("- Product
// management.") and execution steps ("1. Build the API.") from being
// mistaken for resources.
//
// An enumerated name can run to THREE words — "(3) Team members — …"
// (build 13's prose prompt: the one-word capture demanded nothing for
// the team, so the guard never missed it). A multi-word name becomes
// ONE phrase demand ("team members") in the returned list; coverage
// accepts a plan that names the resource by either end of the phrase
// (see assessPlanCoverage).
export function demandedApiRoots(promptText: string): string[] {
  const text = String(promptText || "");
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!name || name === "health" || DEMAND_STOPWORDS.has(name) || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  const addEnum = (rawPhrase: string) => {
    const rawWords = String(rawPhrase || "").toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9-]/g, "")).filter(Boolean);
    // "health" anywhere in the item means the health endpoint, never a
    // resource; stopwords ("the", "fields", …) carry no demand.
    if (!rawWords.length || rawWords.includes("health")) return;
    const words = rawWords.filter(w => !DEMAND_STOPWORDS.has(w));
    if (!words.length) return;
    if (words.length === 1) { add(words[0]); return; }
    const phrase = words.slice(0, 3).join(" ");
    if (seen.has(phrase)) return;
    seen.add(phrase);
    out.push(phrase);
  };
  for (const m of text.matchAll(/\/api\/([a-z][a-z0-9-]*)/gi)) add(m[1]);
  const enumPatterns = [
    /\(\s*\d+\s*\)\s*([a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z][a-zA-Z0-9-]*){0,2})\s*(?:—|–|:)/g,
    /(?:^|\n)\s*\d+\s*[.)]\s+([a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z][a-zA-Z0-9-]*){0,2})\s*(?:—|–|:)/g,
    /(?:^|\n)\s*[-*•]\s+([a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z][a-zA-Z0-9-]*){0,2})\s*(?:—|–|:)/g
  ];
  for (const re of enumPatterns) for (const m of text.matchAll(re)) addEnum(m[1]);
  return out;
}

export type PlanCoverage = {
  demanded: string[];
  covered: string[];
  missing: string[];
  incomplete: boolean;
};

// Compare a plan against the prompt's own demands. A plan is INCOMPLETE
// when it leaves a demanded root uncovered AND the request was big
// enough to matter (≥2 demanded names) or the plan is the degraded
// fallback. A degraded plan that still covers the demand, and a
// non-degraded plan for a ≤1-root ask, proceed exactly as before.
export function assessPlanCoverage(plan: AgentProjectPlan, promptText: string): PlanCoverage {
  const demanded = demandedApiRoots(promptText);
  const coveredStems = new Set<string>();
  for (const r of plan.resources || []) if (r?.name) coveredStems.add(stemWord(r.name));
  for (const e of plan.endpoints || []) {
    const m = String(e?.path || "").match(/^\/api\/([a-z0-9-]+)/i);
    if (m && m[1].toLowerCase() !== "health") coveredStems.add(stemWord(m[1]));
  }
  // A single-word demand is covered by a plan stem of the same name. A
  // multi-word phrase demand ("team members") is covered when the plan
  // names the resource by EITHER end of the phrase — stemmed first word
  // ("team") or stemmed last word ("member") — because the planner
  // picks the resource name; the prompt only picked the concept.
  const isCovered = (d: string): boolean => {
    const words = d.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return coveredStems.has(stemWord(d));
    return coveredStems.has(stemWord(words[0])) || coveredStems.has(stemWord(words[words.length - 1]));
  };
  const covered = demanded.filter(isCovered);
  const missing = demanded.filter(d => !isCovered(d));
  const incomplete = missing.length > 0 && (demanded.length >= 2 || plan.degraded === true);
  return { demanded, covered, missing, incomplete };
}

// The compact re-plan: the same planner, but the reply is kept small
// enough to survive the chat endpoints' per-reply cap — appName, a
// one-line summary, and per resource ONLY a name, a fields map and bare
// endpoints (no endpoint names, no prose descriptions, no expected
// arrays). Explicitly lists the resources the request requires.
export async function planProjectCompact(promptText: string, required: string[], envKeys: string[] = [], context?: { history?: string; externalApi?: { url: string; excerpt: string } }): Promise<AgentProjectPlan> {
  let plan: AgentProjectPlan;
  try {
    const raw = await agentChat(
      "System: You are Agent Bera's project planner. Reply with ONLY a compact JSON object — no markdown, no commentary, no extra words. Keep the WHOLE reply as small as possible: it must fit one short message.\n" +
      "Shape: {\"appName\": string (short), \"summary\": string (ONE line), \"resources\": [{\"name\": string (one lowercase plural word), \"fields\": {\"fieldName\": \"string|number|boolean\"}, \"endpoints\": [{\"method\": \"GET|POST|PUT|PATCH|DELETE\", \"path\": \"/api/...\", \"body\": object (POST/PUT only)}]}]}\n" +
      "Rules: include EXACTLY these resources, no more, no fewer: " + required.join(", ") + ". Per resource include a list endpoint, a create endpoint whose body is a realistic sample built from its fields, and a get-one endpoint with a concrete id like /api/products/1; add update/delete endpoints where natural, and include any extra endpoint the request explicitly names (for example a login endpoint). Do NOT add endpoint \"name\" or \"expected\" fields — keep every endpoint to method, path and body only. Keep the TOTAL across all resources to at most 20 endpoints.\n" +
      (envKeys.length ? `\nThe app will run with these environment variables available (names only): ${envKeys.join(", ")}.\n` : "") +
      "\nUser: Plan a full-stack web app for this request: " + promptText,
      90000);
    const parsed = extractJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.resources) || !parsed.resources.length) return fallbackPlan(promptText);
    const seen = new Set<string>();
    const cleanEndpoints = (list: any): AgentEndpointTest[] => (Array.isArray(list) ? list : [])
      .map(sanitizeEndpoint).filter(Boolean)
      .filter((e: any) => { const k = `${(e as AgentEndpointTest).method} ${(e as AgentEndpointTest).path}`; if (seen.has(k)) return false; seen.add(k); return true; }) as AgentEndpointTest[];
    const resources: AgentResourcePlan[] = parsed.resources.slice(0, 6).map((r: any) => ({
      name: String(r?.name || "items").toLowerCase().replace(/[^a-z]/g, "").slice(0, 24) || "items",
      endpoints: cleanEndpoints(r?.endpoints)
    })).filter((r: AgentResourcePlan) => r.endpoints.length > 0);
    if (!resources.length) return fallbackPlan(promptText);
    const endpoints: AgentEndpointTest[] = [{ name: "Health check", method: "GET", path: "/api/health", expected: [200] },
      ...resources.flatMap(r => r.endpoints).filter(e => e.path !== "/api/health")].slice(0, 21);
    if (endpoints.length < 3) return fallbackPlan(promptText);
    plan = {
      appName: String(parsed.appName || "").replace(/\s+/g, " ").trim().slice(0, 60) || fallbackPlan(promptText).appName,
      summary: String(parsed.summary || "").replace(/\s+/g, " ").trim().slice(0, 240),
      resource: resources[0].name,
      resources,
      endpoints
    };
  } catch {
    return fallbackPlan(promptText);
  }
  if (context?.externalApi) plan.externalApi = context.externalApi;
  if (context?.history) plan.historyNote = context.history;
  return plan;
}

const stripAnyFences = (s: string) => String(s || "").replace(/^\s*```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/i, "").trim();

function trimOverlap(existing: string, cont: string): string {
  const maxOverlap = Math.min(800, existing.length, cont.length);
  for (let k = maxOverlap; k >= 40; k--) {
    if (existing.endsWith(cont.slice(0, k))) return cont.slice(k);
  }
  return cont;
}

// Continue an existing partial file: ask for continuations and stitch
// them on until `isComplete` says the file is finished (the chat
// endpoints truncate long replies, so a file rarely arrives whole).
async function continueStitching(code: string, fileLabel: string, isComplete: (code: string) => boolean, maxRounds: number): Promise<string> {
  let out = code;
  for (let i = 0; i < maxRounds && !isComplete(out); i++) {
    const tail = out.slice(-1500);
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
    out += trimOverlap(out, cont);
  }
  return out.trim();
}

// Generate one code file, stitching continuations until `isComplete` says
// the file is finished (the chat endpoints truncate long replies).
async function stitchCode(firstPrompt: string, fileLabel: string, isComplete: (code: string) => boolean, maxRounds = 5): Promise<string> {
  const first = stripAnyFences(await agentChat(firstPrompt, 150000));
  return continueStitching(first, fileLabel, isComplete, maxRounds);
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

// --- Seed declaration guarantee --------------------------------------------
// The backend rules tell the model to define `const SEED = [...]` (first
// resource) and `const SEED_<RESOURCE> = [...]` (the rest) and pass them
// to store.init(...). A live build shipped code that USED SEED without
// ever declaring it: node --check passed, then the server died at boot
// with "SEED is not defined" and three AI repair rounds never fixed it.
// Like the store itself, the seed arrays are too important to leave to
// the model: when the code references a seed name it never declares, the
// declaration is injected deterministically, built from the plan's own
// sample data (the same bodies the endpoint tests exercise).

// Blank out string literals, template text, regex literals and comments
// (positions and newlines preserved) so identifier scans see code, not
// prose. Template ${ } expressions stay visible — they are real code.
// Regex literals are recognised with the usual previous-token heuristic.
function maskNonCode(code: string): string {
  const out = code.split("");
  const blank = (idx: number) => { if (out[idx] !== "\n" && out[idx] !== "\r") out[idx] = " "; };
  const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "delete", "void", "in", "of", "new", "instanceof", "yield", "await", "else", "do"]);
  let state: "code" | "sq" | "dq" | "tpl" | "line" | "block" | "regex" = "code";
  const exprDepths: number[] = []; // brace depth of each open template ${ }
  let regexClass = false;
  let lastSig = "";
  let lastWord = "";
  const regexAllowed = (): boolean => {
    if (!lastSig) return true;
    if (/[\w$]/.test(lastSig)) return KEYWORDS_BEFORE_REGEX.has(lastWord);
    if (lastSig === ")" || lastSig === "]" || lastSig === "}" || lastSig === "'" || lastSig === '"' || lastSig === "`") return false;
    return true;
  };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = i + 1 < code.length ? code[i + 1] : "";
    if (state === "code") {
      if (c === "/" && n === "/") { blank(i); blank(i + 1); i += 2; state = "line"; continue; }
      if (c === "/" && n === "*") { blank(i); blank(i + 1); i += 2; state = "block"; continue; }
      if (c === "'") { blank(i); i++; state = "sq"; continue; }
      if (c === '"') { blank(i); i++; state = "dq"; continue; }
      if (c === "`") { blank(i); i++; state = "tpl"; continue; }
      if (c === "/" && regexAllowed()) { blank(i); i++; state = "regex"; regexClass = false; continue; }
      if (c === "{") {
        if (exprDepths.length) exprDepths[exprDepths.length - 1]++;
        lastSig = c; lastWord = ""; i++; continue;
      }
      if (c === "}") {
        if (exprDepths.length) {
          exprDepths[exprDepths.length - 1]--;
          if (exprDepths[exprDepths.length - 1] === 0) { exprDepths.pop(); blank(i); i++; state = "tpl"; continue; }
        }
        lastSig = c; lastWord = ""; i++; continue;
      }
      if (!/\s/.test(c)) {
        lastSig = c;
        lastWord = /[\w$]/.test(c) ? (lastWord + c).slice(-16) : "";
      }
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code"; else blank(i);
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { blank(i); blank(i + 1); i += 2; state = "code"; lastSig = "/"; lastWord = ""; continue; }
      blank(i); i++;
      continue;
    }
    if (state === "sq" || state === "dq") {
      const quote = state === "sq" ? "'" : '"';
      if (c === "\\") { blank(i); if (i + 1 < code.length) blank(i + 1); i += 2; continue; }
      blank(i); i++;
      if (c === quote) { state = "code"; lastSig = quote; lastWord = ""; }
      continue;
    }
    if (state === "tpl") {
      if (c === "\\") { blank(i); if (i + 1 < code.length) blank(i + 1); i += 2; continue; }
      if (c === "`") { blank(i); i++; state = "code"; lastSig = "`"; lastWord = ""; continue; }
      if (c === "$" && n === "{") { blank(i); blank(i + 1); i += 2; exprDepths.push(1); state = "code"; lastSig = "{"; lastWord = ""; continue; }
      blank(i); i++;
      continue;
    }
    // state === "regex"
    if (c === "\\") { blank(i); if (i + 1 < code.length) blank(i + 1); i += 2; continue; }
    if (c === "[") regexClass = true;
    if (c === "]") regexClass = false;
    blank(i); i++;
    if (c === "/" && !regexClass) {
      state = "code";
      while (i < code.length && /[a-z]/i.test(code[i])) i++; // flags
      lastSig = "x"; lastWord = "";
    }
  }
  return out.join("");
}

const SEED_NAME_RE = "(SEED(?:_[A-Za-z0-9]+)?)";

// Seed identifiers the code USES but never declares with const/let/var.
// Exported for the sandbox gate (agentTest) so a shape the normalizer
// cannot map still fails with the identifier named, not a boot crash.
export function undeclaredSeedNames(code: string): string[] {
  const masked = maskNonCode(code);
  const declared = new Set<string>();
  for (const m of masked.matchAll(new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${SEED_NAME_RE}\\b`, "g"))) declared.add(m[1]);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const m of masked.matchAll(new RegExp(`(?<![\\w$.])${SEED_NAME_RE}\\b`, "g"))) {
    const name = m[1];
    if (!declared.has(name) && !seen.has(name)) { seen.add(name); missing.push(name); }
  }
  return missing;
}

// Seed items for one resource, from the plan: three items built on the
// create endpoint's sample body (ids stripped — the store assigns them),
// with the name/title field suffixed so items 2 and 3 read as distinct
// entries. Without a POST sample, a single item from any other sample
// body; without any sample, a single empty object. Never throws on odd
// plan shapes — a build must not die in the normalizer.
function seedItemsForResource(resource: AgentResourcePlan): any[] {
  try {
    const bodies = (resource.endpoints || []).filter(e => e.body && typeof e.body === "object" && Object.keys(e.body).length > 0);
    const post = bodies.find(e => e.method === "POST");
    if (post?.body) {
      const base: Record<string, any> = { ...post.body };
      delete base.id;
      const keys = Object.keys(base);
      const nameKey = keys.find(k => /name|title/i.test(k) && typeof base[k] === "string") ?? keys.find(k => typeof base[k] === "string");
      const clone = (suffix: string): Record<string, any> => {
        const o = { ...base };
        if (suffix && nameKey) o[nameKey] = String(o[nameKey]) + suffix;
        return o;
      };
      return [clone(""), clone(" 2"), clone(" 3")];
    }
    const sample = bodies[0]?.body;
    if (sample) {
      const o: Record<string, any> = { ...sample };
      delete o.id;
      return [o];
    }
  } catch { /* fall through to the generic item */ }
  return [{}];
}

function seedDeclarationItems(name: string, plan?: AgentProjectPlan): any[] {
  const resources = plan?.resources || [];
  if (resources.length) {
    let resource: AgentResourcePlan | undefined;
    if (name === "SEED") resource = resources[0];
    else {
      const suffix = name.slice("SEED_".length).toUpperCase();
      resource = resources.find(r => String(r.name || "").toUpperCase() === suffix);
    }
    if (resource) return seedItemsForResource(resource);
  }
  return [{}];
}

// Where injected declarations go: just after the leading 'use strict'
// line and the top-of-file require block (single-line requires), else
// the very top of the file. The injected consts are pure JSON literals,
// so any of these positions evaluates before every use that matters
// (init calls happen after the requires in generated code).
function seedInjectionOffset(code: string): number {
  const maskedLines = maskNonCode(code).split("\n");
  const rawLines = code.split("\n");
  let offset = 0;
  let insertAt = 0;
  for (let idx = 0; idx < maskedLines.length; idx++) {
    const line = maskedLines[idx];
    // 'use strict' is classified on the raw line: masking blanks its
    // quotes, which would hide it. Requires are classified on the masked
    // line so a "require(" inside a string cannot fake a require block.
    const isStrict = /^\s*['"]use strict['"];?\s*$/.test(rawLines[idx] || "");
    const requireMatch = line.match(/^\s*(?:(?:const|let|var)\s+[^=;]+=\s*)?require\s*\((.*)\)\s*;?\s*$/);
    const isRequireLine = requireMatch !== null && !requireMatch[1].includes("(");
    if (line.trim() === "" || isStrict || isRequireLine) { offset += line.length + 1; insertAt = offset; continue; }
    break;
  }
  return Math.min(insertAt, code.length);
}

export function ensureSeedDeclarations(code: string, plan?: AgentProjectPlan): string {
  const missing = undeclaredSeedNames(code);
  if (!missing.length) return code;
  const decls = missing.map(name => `const ${name} = ${JSON.stringify(seedDeclarationItems(name, plan))};`).join("\n");
  const block = `\n// Seed data guaranteed by Agent Bera: the generated code used these\n// arrays without declaring them, so they are built from the plan.\n${decls}\n`;
  const at = seedInjectionOffset(code);
  return code.slice(0, at) + block + code.slice(at);
}

// Deterministic cleanup for a known generator habit: the model loves
// require('body-parser') even though Express ships the same functions
// built in (this exact habit broke a Bera AI build in Nov 2026). The
// rewrite is mechanical and safe: drop the require, point its calls at
// express.* equivalents.
export function normalizeServerCode(code: string, plan?: AgentProjectPlan): string {
  let out = code;
  const varMatch = out.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]body-parser['"]\s*\)\s*;?/);
  if (varMatch) {
    const name = varMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*require\\(\\s*['"]body-parser['"]\\s*\\)\\s*;?`), "");
    out = out.replace(new RegExp(`\\b${name}\\.(json|urlencoded|text|raw)\\(`, "g"), "express.$1(");
  }
  out = out.replace(/require\(\s*['"]body-parser['"]\s*\)\.(json|urlencoded|text|raw)\(/g, "express.$1(");
  out = ensureSeedDeclarations(out, plan);
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
    "System: " + backendRules(envKeys) + "\n\nUser: App: " + plan.appName + " — " + plan.summary + "\nOriginal request: " + promptText + (plan.externalApi ? `\n\nEXTERNAL API: this app integrates with ${plan.externalApi.url}, available as process.env.EXTERNAL_API_URL. Call it SERVER-SIDE with fetch (e.g. to list or fetch the external data behind this app's own endpoints), shaping the response for the frontend. What that URL returned when the platform explored it:\n---\n${plan.externalApi.excerpt}\n---\nIf an external call fails at runtime, answer 502 with a JSON error — never crash. Data the user creates in THIS app still goes through the provided store.` : "") + "\n\nEndpoints to implement:\n" + endpointList,
    "server.js",
    (c) => c.includes("express") && c.includes("listen") && c.includes("lib/store") && c.length > 500);
  code = stripProseAroundCode(normalizeServerCode(code, plan));
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
        (c) => c.includes("express") && c.includes("listen") && c.includes("lib/store") && c.length > 500), plan));
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
  code = stripProseAroundCode(normalizeServerCode(code, plan));
  if (!code.includes("express") || !code.includes("/api/health")) {
    throw new Error("The repaired backend was still incomplete.");
  }
  return code;
}

// --- Targeted syntax repair -------------------------------------------------
// The full-file repair above regenerates server.js from scratch — and
// for a pure syntax error that re-rolls the same truncation/stitching
// dice that broke the file in the first place (live builds 10/11: the
// repair rounds oscillated 0/1 -> 7/8 -> 0/1 and never converged). But
// node --check names the EXACT failing line. When it does, patch just
// the window around that line and splice it back: the rest of the file
// — the parts that already worked — is never regenerated.

// The 1-based line a node --check failure blames, or null when the
// detail does not name one ("server.js:252", "...js:252", "line 252").
export function syntaxErrorLine(detail: string): number | null {
  const text = String(detail || "");
  const m = text.match(/\.js:(\d+)\b/) || text.match(/\bline (\d+)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Ask the AI to correct ONLY the ±40-line window around the syntax
// error and splice its answer over that window. Returns the full
// patched file, or null when anything about the attempt is unusable
// (no line number, empty/garbled reply, a reply wildly longer or
// shorter than the window) — the caller then falls back to the
// full-file repair, unchanged.
export async function repairSyntaxWindow(plan: AgentProjectPlan, code: string, syntaxDetail: string): Promise<string | null> {
  const line = syntaxErrorLine(syntaxDetail);
  if (line === null) return null;
  const lines = String(code || "").split("\n");
  if (line > lines.length) return null;
  const start = Math.max(1, line - 40);
  const end = Math.min(lines.length, line + 40);
  const windowLines = lines.slice(start - 1, end);
  const numbered = windowLines.map((l, i) => `${start + i}: ${l}`).join("\n");
  let raw: string;
  try {
    raw = await agentChat(
      "System: You are fixing ONE JavaScript syntax error in a Node.js/Express server file. The syntax checker reported this error:\n" + String(syntaxDetail).slice(0, 700) +
      `\n\nBelow are lines ${start}-${end} of the file (of ${lines.length} total), each prefixed with its line number. Return ONLY the corrected replacement lines for lines ${start}-${end}: no line numbers, no markdown fences, no explanations, no commentary. Preserve the window's behaviour and content — change only what the syntax error requires (remove a stray closing token, close an open block, fix a bracket). Do not add new endpoints or rename anything.\n\n` + numbered,
      90000);
  } catch { return null; }
  let replyLines = stripAnyFences(raw).split("\n");
  // Tolerate an AI that echoes the line numbers back: strip the
  // prefixes only when (nearly) every line carries one AND the first
  // number is the window's start — a mid-object numeric key in real
  // code must never be eaten by this.
  const nonEmpty = replyLines.filter(l => l.trim().length > 0);
  const numberedCount = nonEmpty.filter(l => /^\s*\d+\s*:\s/.test(l)).length;
  if (nonEmpty.length > 0 && numberedCount >= Math.ceil(nonEmpty.length * 0.8)) {
    const firstNum = Number((nonEmpty[0].match(/^\s*(\d+)\s*:/) || [])[1]);
    if (firstNum === start) replyLines = replyLines.map(l => l.replace(/^\s*\d+\s*:\s?/, ""));
  }
  while (replyLines.length && replyLines[0].trim() === "") replyLines.shift();
  while (replyLines.length && replyLines[replyLines.length - 1].trim() === "") replyLines.pop();
  if (!replyLines.length) return null;
  if (replyLines.some(l => /^\s*```/.test(l))) return null;
  if (replyLines.length < Math.ceil(windowLines.length * 0.5) || replyLines.length > windowLines.length * 2) return null;
  const spliced = [...lines.slice(0, start - 1), ...replyLines, ...lines.slice(end)].join("\n");
  if (spliced === code) return null;
  return normalizeServerCode(spliced, plan);
}

const FRONTEND_RULES = [
  "You are Agent Bera, an expert front-end developer. Build the app's frontend as ONE complete HTML file saved as public/index.html.",
  "Rules:",
  "- Output ONLY the HTML code. No markdown fences, no explanations.",
  "- All CSS in a <style> tag in <head>, all JS in a <script> tag before </body>.",
  "- Keep the file compact and efficient (concise CSS, no repeated blocks) so the COMPLETE file stays as short as a polished page allows — target at most ~12,000 characters. An unfinished file is a failed build.",
  "- The page MUST load its real data from the backend API with fetch() — call the GET list endpoint of EVERY resource in the plan and render the items dynamically (cards or a table). Never hard-code the data as the only source.",
  "- If the plan has a POST create endpoint, include a working form that POSTs JSON to it and refreshes the list, showing a success/error message.",
  "- API paths MUST be relative with NO leading slash: fetch('api/products'), never fetch('/api/products'). The app is served under a /web/<slug> base path, so an absolute '/api/…' path hits the platform's own API instead of this app's — every call fails.",
  "- AUTH: if the plan includes a login endpoint, or a users resource whose create endpoint is the registration, the page MUST include working register and login forms that POST JSON to those exact endpoints, display the server's real success/error response, and reflect the signed-in state (the user's name and a logout control after login). A Login link or button that does not open a working login form is FORBIDDEN.",
  "- EVERY form on the page MUST submit to its planned backend endpoint with fetch() and show the real result. Placeholder handlers are FORBIDDEN: no alert-only submit handlers, no fake success messages, no simulated data — if a form exists, it posts to the API.",
  "- On load, check GET /api/health and show a small 'API online/offline' status indicator.",
  "- The health indicator MUST settle: when the health fetch resolves it shows 'API online', when it fails it shows 'API offline' — never leave a permanent 'checking…' label on the page.",
  "- Modern, professional design that fits the business: strong typography (Google Fonts CDN allowed), real copy (never lorem ipsum), a committed colour theme.",
  "- Mobile-friendly: <meta name=\"viewport\"> and responsive CSS with media queries.",
  "- The file MUST be complete: end with </body></html>."
].join("\n");

export async function generateFrontend(promptText: string, plan: AgentProjectPlan, log?: (line: string) => void | Promise<void>): Promise<string> {
  const endpointList = plan.endpoints.map(e => `- ${e.method} ${e.path}`).join("\n");
  const attempt = () => stitchCode(
    "System: " + FRONTEND_RULES + "\n\nUser: App: " + plan.appName + " — " + plan.summary + "\nOriginal request: " + promptText + (plan.externalApi ? "\n\nNote: some data comes from an external API, but it ALWAYS reaches this page through the app's own backend endpoints listed below — never call the external API from the browser." : "") + "\n\nBackend API endpoints available:\n" + endpointList,
    "HTML",
    (c) => looksComplete(c),
    8);
  let html = await attempt();
  // Persistence, up to 3 total attempts: a page that comes back
  // truncated (the chat endpoints cap every reply, so a long page can
  // exhaust one run's continuation rounds) is CONTINUED from where it
  // stopped before anything is regenerated from scratch — and every
  // incomplete attempt is written to the build log, so a build that
  // dies here shows the struggle instead of a silent gap after the
  // plan line (seen live on a 2-resource coffee-house build).
  for (let attemptNo = 2; attemptNo <= 3 && !looksComplete(html); attemptNo++) {
    await log?.(`Frontend generation attempt ${attemptNo - 1} incomplete (no closing </html>), continuing…`);
    const continued = await continueStitching(html, "HTML", (c) => looksComplete(c), 8);
    if (looksComplete(continued)) { html = continued; break; }
    if (continued.length > html.length) html = continued;
    // Fresh regeneration as this attempt's other half — kept only when
    // it finishes the page or gets further than the partial we hold.
    const fresh = await attempt();
    if (looksComplete(fresh) || fresh.length > html.length) html = fresh;
  }
  if (!looksComplete(html)) throw new Error("The generated frontend came back incomplete, so nothing was published. Please try again.");
  return html;
}

// Repair a frontend that FAILED the wiring gate: the backend is real
// and green, but the page never calls it (build 13 shipped a brochure
// with zero fetch calls, a decorative Login link and an alert-only
// contact form behind a 26/26 backend pass). The repair is told the
// gate's exact faults and instructed to fix ONLY the wiring — the
// design, layout and copy are the page's own and stay. Completeness
// handling mirrors generateFrontend: stitch, continue, retry.
export async function repairFrontend(promptText: string, plan: AgentProjectPlan, currentHtml: string, failureDetail: string): Promise<string> {
  const endpointList = plan.endpoints.map(e => `- ${e.method} ${e.path}`).join("\n");
  // When the page is long, keep its head AND its tail: the wiring
  // scripts live at the end of the file, exactly what a head-only
  // slice would cut off before the repair ever saw them.
  const current = currentHtml.length > 11000
    ? currentHtml.slice(0, 4000) + "\n<!-- …middle of the file omitted… -->\n" + currentHtml.slice(-7000)
    : currentHtml;
  const attempt = () => stitchCode(
    "System: " + FRONTEND_RULES + "\n\nUser: App: " + plan.appName + " — " + plan.summary + "\nOriginal request: " + promptText +
    "\n\nBackend API endpoints available:\n" + endpointList +
    "\n\nThe pre-publish gate found these wiring faults in the current page:\n" + String(failureDetail || "").slice(0, 1500) +
    "\n\nFix ONLY the wiring: add or repair the exact calls and forms the gate lists, keep the design, layout, copy and every working part of the current page. Return the COMPLETE corrected HTML file.\n\nCurrent public/index.html:\n" + current,
    "HTML",
    (c) => looksComplete(c),
    8);
  let html = await attempt();
  for (let attemptNo = 2; attemptNo <= 3 && !looksComplete(html); attemptNo++) {
    const continued = await continueStitching(html, "HTML", (c) => looksComplete(c), 8);
    if (looksComplete(continued)) { html = continued; break; }
    if (continued.length > html.length) html = continued;
    const fresh = await attempt();
    if (looksComplete(fresh) || fresh.length > html.length) html = fresh;
  }
  if (!looksComplete(html)) throw new Error("The repaired frontend was still incomplete.");
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
    code = stripProseAroundCode(normalizeServerCode(code, plan));
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

export async function generateProjectFiles(promptText: string, plan: AgentProjectPlan, packageName: string, envKeys: string[] = [], log?: (line: string) => void | Promise<void>): Promise<Record<string, string>> {
  const genBackend = async (): Promise<string> => {
    try { return await generateBackendServer(promptText, plan, envKeys); }
    catch { return await generateBackendServer(promptText, plan, envKeys); }
  };
  // Backend and frontend are independent files — generate them in
  // parallel instead of one after the other.
  const [generatedServer, frontend] = await Promise.all([genBackend(), generateFrontend(promptText, plan, log)]);
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
