import dns from "node:dns/promises";

// External API exploration — the agent's version of "go and look at the
// API before building against it". The user supplies a URL (a docs page
// or an API base); the platform fetches it, learns what it returns, and
// hands that evidence to the planner and the code generator.
//
// Safety: this fetches a user-supplied URL from the server, so it is
// guarded like any SSRF surface — http/https only, no credentials in
// the URL, hostnames that resolve to private/loopback/link-local
// addresses are refused, and every redirect hop is re-validated.
// Responses are size-capped and time-capped.

export type ExploredApi = {
  url: string;
  status: number;
  contentType: string;
  excerpt: string;
  probed: string[];
};

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd") || v === "::";
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(String(raw || "").trim()); } catch { throw new Error("That API URL is not a valid URL."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The API URL must start with http:// or https://");
  if (u.username || u.password) throw new Error("Remove any username/password from the API URL — pass keys as environment variables instead.");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("That API URL points at a local address, which the builder cannot use.");
  let addresses: { address: string }[];
  try { addresses = await dns.lookup(host, { all: true }); } catch { throw new Error(`Could not resolve the API host "${host}". Check the URL.`); }
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error("That API URL resolves to a private or local address, which the builder cannot use.");
  return u;
}

async function fetchGuarded(start: URL): Promise<{ status: number; contentType: string; text: string; finalUrl: string }> {
  let current = start;
  for (let hop = 0; hop <= 3; hop++) {
    const r = await fetch(current.toString(), {
      redirect: "manual",
      headers: { "Accept": "application/json, text/html;q=0.8, */*;q=0.5", "User-Agent": "BERAHOST-AgentBera/1.0 (API exploration)" },
      signal: AbortSignal.timeout(20000)
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      if (hop === 3) throw new Error("The API URL redirects too many times.");
      current = await assertPublicUrl(new URL(r.headers.get("location")!, current).toString());
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.subarray(0, 64 * 1024).toString("utf8");
    return { status: r.status, contentType: r.headers.get("content-type") || "", text, finalUrl: current.toString() };
  }
  throw new Error("The API URL redirects too many times.");
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function exploreExternalApi(rawUrl: string): Promise<ExploredApi> {
  const start = await assertPublicUrl(rawUrl);
  const probed: string[] = [start.toString()];
  const main = await fetchGuarded(start);
  let excerpt = /html/i.test(main.contentType) ? htmlToText(main.text) : main.text;
  excerpt = excerpt.slice(0, 4000);
  // An API served from an origin root often publishes its contract at
  // /openapi.json — probe it once, guarded the same way.
  if ((start.pathname === "/" || start.pathname === "") && !/openapi/i.test(start.toString())) {
    try {
      const specUrl = new URL("/openapi.json", start);
      probed.push(specUrl.toString());
      const spec = await fetchGuarded(specUrl);
      if (spec.status >= 200 && spec.status < 300 && /json/i.test(spec.contentType)) {
        excerpt += `\n\n[OpenAPI spec excerpt from ${specUrl.toString()}]\n` + spec.text.slice(0, 3000);
      }
    } catch { /* no spec — the main response is the evidence */ }
  }
  if (main.status >= 400) throw new Error(`The API URL answered ${main.status}. Check the URL points at a reachable API or docs page.`);
  return { url: start.toString(), status: main.status, contentType: main.contentType, excerpt, probed };
}
