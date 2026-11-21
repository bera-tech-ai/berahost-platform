import type { Request, Response, NextFunction } from "express";
import { getUserById } from "../lib/auth";
import { resolveApiKey } from "./requireApiKey";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

export type ApiKeyScope = "read" | "write" | "payments";
const AVAILABLE_SCOPES: ApiKeyScope[] = ["read", "write", "payments"];

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = await getUserById(req.session.userId);
  if (!user || user.isBanned) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as any).user = user;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  await requireAuth(req, res, async () => {
    const user = (req as any).user;
    if (!user?.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  });
}

/** Accept a browser session or an API key with the requested customer scope. */
export function requireAny(scope: ApiKeyScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.session.userId) {
      const user = await getUserById(req.session.userId);
      if (user && !user.isBanned) {
        (req as any).user = user;
        return next();
      }
      req.session.destroy(() => {});
    }

    const hasKey = Boolean(req.headers["x-api-key"] || req.headers["authorization"]?.startsWith("Bearer bh_"));
    if (!hasKey) {
      res.status(401).json({ error: "Unauthorized", hint: "Send a session cookie or an API key via x-api-key or Authorization: Bearer." });
      return;
    }

    const resolved = await resolveApiKey(req);
    if (!resolved) {
      res.status(401).json({ error: "Invalid or expired API key" });
      return;
    }

    const row = (req as any).apiKey;
    const scopes: string[] = Array.isArray(row?.scopes) ? row.scopes.filter((value: unknown): value is ApiKeyScope => typeof value === "string" && AVAILABLE_SCOPES.includes(value as ApiKeyScope)) : [];
    const allowed = scopes.includes(scope) || (scope === "read" && (scopes.includes("write") || scopes.includes("payments")));
    if (!allowed) {
      res.status(403).json({ error: `API key does not have the required scope: "${scope}"`, yourScopes: scopes, availableScopes: AVAILABLE_SCOPES });
      return;
    }
    next();
  };
}
