import crypto from "crypto";
import { db, githubWebhooksTable, usersTable, webDeploymentsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "BERAHOST-GitHub-Integration/1.0";

export type GithubIdentity = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
};

export type GithubRepository = {
  id: number;
  fullName: string;
  name: string;
  ownerLogin: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  description: string | null;
  updatedAt: string | null;
};

const MANAGED_PUBLIC_URL = "https://berahost-gbyspbc3.manus.space";

function clientId() {
  return process.env.GITHUB_CLIENT_ID?.trim() || "";
}

function clientSecret() {
  return process.env.GITHUB_CLIENT_SECRET?.trim() || "";
}

export function githubConfigured() {
  return Boolean(clientId() && clientSecret());
}

function tokenEncryptionKey(): Buffer {
  // SESSION_SECRET is already a protected server-only value. Deriving a separate
  // AES key keeps GitHub tokens encrypted at rest without adding another user setup step.
  return crypto.createHash("sha256").update(process.env.SESSION_SECRET || "fallback-secret-change-me").digest();
}

export function encryptGithubToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptGithubToken(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const [version, ivText, tagText, ciphertextText] = value.split(".");
    if (version !== "v1" || !ivText || !tagText || !ciphertextText) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", tokenEncryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function publicBaseUrl(request?: { protocol: string; get(name: string): string | undefined }): string {
  const configured = process.env.PUBLIC_URL || process.env.FRONTEND_URL || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "") || MANAGED_PUBLIC_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (request) return `${request.protocol}://${request.get("host") || "localhost"}`.replace(/\/$/, "");
  return "";
}

type OriginRequest = { protocol: string; get(name: string): string | undefined };

// The platform's public origin changes when it is redeployed under a new
// host, but URLs minted earlier (deployment publicUrls, a build's stored
// live-check URL) keep the old origin baked in — and the old host may no
// longer serve at all. At read time, rebase any absolute URL onto the
// origin of the request being served, so links always point at the host
// the user is actually on. Null, relative or unparseable values, and
// requests without a usable host, pass through unchanged.
export function withRequestOrigin<T extends string | null | undefined>(storedUrl: T, request?: OriginRequest): T {
  if (!storedUrl || !request) return storedUrl;
  const host = request.get("host");
  if (!host) return storedUrl;
  try {
    const url = new URL(storedUrl);
    const origin = new URL(`${request.protocol}://${host}`);
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = origin.port;
    return url.toString() as T;
  } catch {
    return storedUrl;
  }
}

export function githubCallbackUrl(request?: { protocol: string; get(name: string): string | undefined }): string {
  return `${publicBaseUrl(request)}/api/auth/github/callback`;
}

export function managedGithubWebhookUrl(request?: { protocol: string; get(name: string): string | undefined }): string {
  return `${publicBaseUrl(request)}/api/github/webhook`;
}

function repoPath(fullName: string): string {
  const [owner, repo] = String(fullName).split("/");
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid GitHub repository identity");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function githubRequest(pathname: string, token: string | undefined, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", USER_AGENT);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${GITHUB_API}${pathname}`, { ...init, headers });
  return response;
}

async function readGithubJson(response: Response): Promise<any> {
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : `GitHub API request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export async function exchangeGithubCode(code: string, redirectUri: string): Promise<{ accessToken: string; scope: string }> {
  if (!githubConfigured()) throw new Error("GitHub OAuth is not configured on BERAHOST yet.");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ client_id: clientId(), client_secret: clientSecret(), code, redirect_uri: redirectUri }),
  });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(body.error_description || body.error || "GitHub authorization failed");
  return { accessToken: String(body.access_token), scope: String(body.scope || "") };
}

export async function getGithubIdentity(accessToken: string): Promise<GithubIdentity> {
  const user = await readGithubJson(await githubRequest("/user", accessToken));
  const emails = await readGithubJson(await githubRequest("/user/emails?per_page=100", accessToken)).catch(() => []);
  const verifiedEmail = Array.isArray(emails) ? emails.find((item: any) => item.primary && item.verified)?.email || emails.find((item: any) => item.verified)?.email : null;
  return { id: Number(user.id), login: String(user.login), name: user.name ? String(user.name) : null, avatarUrl: user.avatar_url ? String(user.avatar_url) : null, email: verifiedEmail || (user.email ? String(user.email) : null) };
}

export async function listGithubRepositories(accessToken: string): Promise<GithubRepository[]> {
  const result: GithubRepository[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const rows = await readGithubJson(await githubRequest(`/user/repos?per_page=100&page=${page}&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member`, accessToken));
    if (!Array.isArray(rows) || rows.length === 0) break;
    result.push(...rows.map((repo: any) => ({ id: Number(repo.id), fullName: String(repo.full_name), name: String(repo.name), ownerLogin: String(repo.owner?.login || ""), private: Boolean(repo.private), htmlUrl: String(repo.html_url), defaultBranch: String(repo.default_branch || "main"), description: repo.description ? String(repo.description) : null, updatedAt: repo.updated_at ? String(repo.updated_at) : null })));
    if (rows.length < 100) break;
  }
  return result;
}

export async function listGithubBranches(accessToken: string, fullName: string): Promise<string[]> {
  const rows = await readGithubJson(await githubRequest(`${repoPath(fullName)}/branches?per_page=100`, accessToken));
  return Array.isArray(rows) ? rows.map((row: any) => String(row.name)).filter(Boolean) : [];
}

export async function createGithubRepository(accessToken: string, name: string, description?: string): Promise<GithubRepository> {
  const response = await githubRequest("/user/repos", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description: description || "Built with Agent Bera on BERAHOST", private: false, auto_init: false }),
  });
  const repo: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Surface the REAL failure. GitHub's top-level message alone is often
    // generic (a 422 arrives as just "Repository creation failed.") — the
    // actionable detail lives in the errors array, and the status decides
    // whether a retry can help. Both ride on the thrown error: the status
    // as a property, and "status + message + detail" as the message.
    const detail = Array.isArray(repo?.errors) && repo.errors.length
      ? ` (${repo.errors.map((e: any) => [e?.field, e?.message || e?.code].filter(Boolean).join(": ")).filter(Boolean).join("; ")})`
      : "";
    const message = typeof repo?.message === "string" && repo.message ? repo.message : `GitHub API request failed (${response.status})`;
    const err: any = new Error(`${response.status} ${message}${detail}`);
    err.status = response.status;
    throw err;
  }
  return { id: Number(repo.id), fullName: String(repo.full_name), name: String(repo.name), ownerLogin: String(repo.owner?.login || ""), private: Boolean(repo.private), htmlUrl: String(repo.html_url), defaultBranch: String(repo.default_branch || "main"), description: repo.description ? String(repo.description) : null, updatedAt: repo.updated_at ? String(repo.updated_at) : null };
}

// Create a repo for an Agent Bera publish, surviving the one failure a
// retry can fix: a 422 (name already taken / unavailable) gets up to two
// more attempts with -2 / -3 suffixes on the first name — three names
// total. EVERY failed attempt is reported through `log` with GitHub's real
// status + message, and the error that ultimately propagates carries them
// too, so a publish never dies with a bare unexplained failure again.
export async function createGithubRepositoryWithRetry(accessToken: string, firstName: string, description: string | undefined, log?: (line: string) => void | Promise<void>): Promise<GithubRepository> {
  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const name = attempt === 1 ? firstName : `${firstName}-${attempt}`;
    try {
      return await createGithubRepository(accessToken, name, description);
    } catch (e: any) {
      lastError = e;
      if (log) await log(`GitHub repo creation attempt ${attempt} failed: ${String(e?.message || e)}`);
      if (e?.status !== 422) break;
    }
  }
  throw lastError ?? new Error("GitHub repo creation failed");
}

export async function createRepositoryFile(accessToken: string, fullName: string, pathInRepo: string, content: string, message: string): Promise<void> {
  const safePath = pathInRepo.split("/").map(encodeURIComponent).join("/");
  await readGithubJson(await githubRequest(`${repoPath(fullName)}/contents/${safePath}`, accessToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64") }),
  }));
}

// Read a file back from a repo (used by Agent Bera's edit flow, which
// starts from the app's currently published code).
export async function getRepositoryFile(accessToken: string, fullName: string, pathInRepo: string): Promise<{ content: string; sha: string } | null> {
  const safePath = pathInRepo.split("/").map(encodeURIComponent).join("/");
  const response = await githubRequest(`${repoPath(fullName)}/contents/${safePath}`, accessToken);
  if (response.status === 404) return null;
  const body = await readGithubJson(response);
  if (!body || typeof body.content !== "string" || typeof body.sha !== "string") return null;
  return { content: Buffer.from(body.content, "base64").toString("utf8"), sha: String(body.sha) };
}

// Create or update a file in one call (the Contents API needs the current
// blob sha to update). Used to push repaired/edited files into an
// existing app's repo.
export async function upsertRepositoryFile(accessToken: string, fullName: string, pathInRepo: string, content: string, message: string): Promise<void> {
  const existing = await getRepositoryFile(accessToken, fullName, pathInRepo).catch(() => null);
  const safePath = pathInRepo.split("/").map(encodeURIComponent).join("/");
  await readGithubJson(await githubRequest(`${repoPath(fullName)}/contents/${safePath}`, accessToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), ...(existing ? { sha: existing.sha } : {}) }),
  }));
}

export async function getGithubRepository(accessToken: string, fullName: string): Promise<GithubRepository> {
  const repo = await readGithubJson(await githubRequest(repoPath(fullName), accessToken));
  return { id: Number(repo.id), fullName: String(repo.full_name), name: String(repo.name), ownerLogin: String(repo.owner?.login || ""), private: Boolean(repo.private), htmlUrl: String(repo.html_url), defaultBranch: String(repo.default_branch || "main"), description: repo.description ? String(repo.description) : null, updatedAt: repo.updated_at ? String(repo.updated_at) : null };
}

export async function createGithubPushWebhook(accessToken: string, fullName: string, secret: string, callbackUrl: string): Promise<number> {
  const response = await githubRequest(`${repoPath(fullName)}/hooks`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web", active: true, events: ["push"], config: { url: callbackUrl, content_type: "json", insecure_ssl: "0", secret } }),
  });
  const body = await readGithubJson(response);
  return Number(body.id);
}

export async function deleteGithubWebhook(accessToken: string, fullName: string, hookId: number): Promise<void> {
  const response = await githubRequest(`${repoPath(fullName)}/hooks/${hookId}`, accessToken, { method: "DELETE" });
  if (!response.ok && response.status !== 404) await readGithubJson(response);
}

export async function revokeGithubToken(accessToken: string): Promise<void> {
  if (!githubConfigured()) return;
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
  const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(clientId())}/token`, { method: "DELETE", headers: { Accept: "application/vnd.github+json", Authorization: `Basic ${basic}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT, "Content-Type": "application/json" }, body: JSON.stringify({ access_token: accessToken }) });
  if (!response.ok && response.status !== 404) logger.warn({ status: response.status }, "GitHub token revocation failed");
}

function randomWebhookSecret() { return crypto.randomBytes(32).toString("hex"); }

export async function ensureWebDeploymentWebhook(webDeploymentId: number, callbackUrl: string): Promise<{ id: number; webhookId: number } | null> {
  const [deployment] = await db.select().from(webDeploymentsTable).where(eq(webDeploymentsTable.id, webDeploymentId));
  if (!deployment?.githubFullName || !deployment.autoDeploy) return null;
  const [existing] = await db.select().from(githubWebhooksTable).where(eq(githubWebhooksTable.webDeploymentId, webDeploymentId)).limit(1);
  if (existing) return { id: existing.id, webhookId: existing.id };
  const [user] = await db.select({ id: usersTable.id, githubAccessTokenEncrypted: usersTable.githubAccessTokenEncrypted }).from(usersTable).where(eq(usersTable.id, deployment.userId));
  const accessToken = decryptGithubToken(user?.githubAccessTokenEncrypted);
  if (!accessToken) throw new Error("Reconnect GitHub before enabling automatic deployment.");
  const secret = randomWebhookSecret();
  const [hook] = await db.insert(githubWebhooksTable).values({ deploymentId: null, webDeploymentId, userId: deployment.userId, repoUrl: `https://github.com/${deployment.githubFullName}.git`, branch: deployment.branch, webhookSecret: secret, isEnabled: true }).returning({ id: githubWebhooksTable.id });
  try {
    const remoteHookId = await createGithubPushWebhook(accessToken, deployment.githubFullName, secret, `${callbackUrl.replace(/\/$/, "")}/${hook.id}`);
    await db.update(githubWebhooksTable).set({ remoteHookId }).where(eq(githubWebhooksTable.id, hook.id));
    return { id: hook.id, webhookId: remoteHookId };
  } catch (error) {
    await db.delete(githubWebhooksTable).where(eq(githubWebhooksTable.id, hook.id));
    throw error;
  }
}

export async function removeWebDeploymentWebhook(webDeploymentId: number): Promise<void> {
  const [hook] = await db.select().from(githubWebhooksTable).where(eq(githubWebhooksTable.webDeploymentId, webDeploymentId)).limit(1);
  if (!hook) return;
  const [deployment] = await db.select({ githubFullName: webDeploymentsTable.githubFullName, userId: webDeploymentsTable.userId }).from(webDeploymentsTable).where(eq(webDeploymentsTable.id, webDeploymentId));
  if (deployment?.githubFullName) {
    const [user] = await db.select({ githubAccessTokenEncrypted: usersTable.githubAccessTokenEncrypted }).from(usersTable).where(eq(usersTable.id, deployment.userId));
    const accessToken = decryptGithubToken(user?.githubAccessTokenEncrypted);
    const remoteHookId = Number((hook as any).remoteHookId || 0);
    if (accessToken && remoteHookId) await deleteGithubWebhook(accessToken, deployment.githubFullName, remoteHookId).catch(() => {});
  }
  await db.delete(githubWebhooksTable).where(eq(githubWebhooksTable.id, hook.id));
}

export function githubRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}.git`;
}

export function githubRepoNameFromUrl(repoUrl: string): string | null {
  const match = String(repoUrl).trim().replace(/\.git$/, "").match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  return match ? match[1] : null;
}
