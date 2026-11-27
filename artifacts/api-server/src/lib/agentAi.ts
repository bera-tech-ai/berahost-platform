// Agent Bera's generation engine: the same Casper chat providers Bera AI
// uses, plus the continuation-stitching the WhatsApp builder relies on.
// The chat endpoints cap each reply at a few thousand characters — far
// less than a complete website — so generation asks for continuations and
// stitches them until the file genuinely ends with </html>.

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
