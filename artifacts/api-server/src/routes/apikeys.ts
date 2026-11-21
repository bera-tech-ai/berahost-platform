import { Router } from "express";
import { db, apiKeysTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAny } from "../middlewares/requireAuth";
import { generateApiKey } from "../lib/auth";
import crypto from "crypto";

const router = Router();
const ALLOWED_SCOPES = ["read", "write", "payments"] as const;
type ApiScope = (typeof ALLOWED_SCOPES)[number];

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function normalizedScopes(value: unknown): ApiScope[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((scope) => typeof scope === "string" && ALLOWED_SCOPES.includes(scope as ApiScope))) return null;
  return [...new Set(value as ApiScope[])];
}

function scopeAllows(parentScopes: string[], requested: ApiScope): boolean {
  return parentScopes.includes(requested) || (requested === "read" && (parentScopes.includes("write") || parentScopes.includes("payments")));
}

router.get("/api-keys", requireAny("read"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const keys = await db
    .select()
    .from(apiKeysTable)
    .where(eq(apiKeysTable.userId, user.id))
    .orderBy(desc(apiKeysTable.createdAt));

  res.json(keys.map((key) => ({
    id: key.id,
    userId: key.userId,
    name: key.name,
    scopes: normalizedScopes(key.scopes ?? []) ?? [],
    lastUsed: key.lastUsed?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  })));
});

router.post("/api-keys", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 3 || name.length > 100) {
    res.status(400).json({ error: "Key name must be between 3 and 100 characters." });
    return;
  }

  const requestedScopes = normalizedScopes(req.body?.scopes ?? ["read"]);
  if (!requestedScopes) {
    res.status(400).json({ error: "Choose one or more valid scopes: read, write, payments." });
    return;
  }
  const parentScopes = (req as any).apiKey?.scopes;
  if (Array.isArray(parentScopes) && !requestedScopes.every((scope) => scopeAllows(parentScopes, scope))) {
    res.status(403).json({ error: "A key cannot create another key with broader permissions than its own." });
    return;
  }

  let expiresAt: Date | null = null;
  if (req.body?.expiresAt !== undefined && req.body.expiresAt !== null && req.body.expiresAt !== "") {
    if (typeof req.body.expiresAt !== "string") {
      res.status(400).json({ error: "expiresAt must be a future ISO-8601 date-time or null." });
      return;
    }
    const parsed = new Date(req.body.expiresAt);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      res.status(400).json({ error: "expiresAt must be a future ISO-8601 date-time or null." });
      return;
    }
    expiresAt = parsed;
  }

  const rawKey = generateApiKey();
  const [key] = await db.insert(apiKeysTable).values({
    userId: user.id,
    keyHash: hashKey(rawKey),
    name,
    scopes: requestedScopes,
    expiresAt,
  }).returning();

  // The raw key is returned once. Only its SHA-256 hash is stored.
  res.status(201).json({
    id: key.id,
    key: rawKey,
    name: key.name,
    scopes: requestedScopes,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  });
});

router.delete("/api-keys/:id", requireAny("write"), async (req, res): Promise<void> => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid API key ID." });
    return;
  }
  const [revoked] = await db.delete(apiKeysTable)
    .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.userId, user.id)))
    .returning({ id: apiKeysTable.id });
  if (!revoked) {
    res.status(404).json({ error: "API key not found." });
    return;
  }
  res.json({ message: "API key revoked" });
});

export default router;
