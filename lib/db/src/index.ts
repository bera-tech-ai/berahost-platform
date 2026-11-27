import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseSchema = process.env.BERAHOST_DATABASE_SCHEMA ?? "berahost";
if (!/^[a-z_][a-z0-9_]*$/.test(databaseSchema) || databaseSchema === "public") {
throw new Error("BERAHOST_DATABASE_SCHEMA must be a valid non-public PostgreSQL schema name (default: berahost).");
}

const databaseUrl = process.env.BERAHOST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
throw new Error(
"BERAHOST_DATABASE_URL or DATABASE_URL must be set. Did you forget to provision a database?",
);
}

// keepAlive: prevents the OS/cloud proxy from silently killing idle TCP connections.
// Without it, a Replit production DB drops connections idle for ~5 min, and the
// pool hands out a dead connection → "Authentication timed out" crash.
// idleTimeoutMillis(30s) < cloud idle-kill(~300s) so the pool retires connections
// before they're killed externally.
export const pool = new Pool({
connectionString: databaseUrl,
options: `-c search_path=${databaseSchema}`,
keepAlive: true,
keepAliveInitialDelayMillis: 10_000,
idleTimeoutMillis: 30_000,
connectionTimeoutMillis: 10_000,
max: 10,
});
await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [databaseSchema]).then((result) => {
if (result.rowCount !== 1) throw new Error(`Required database schema '${databaseSchema}' is missing; refusing to use PostgreSQL fallback schemas.`);
});
export const db = drizzle(pool, { schema });

export * from "./schema";