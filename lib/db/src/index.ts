import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseSchema = process.env.BERAHOST_DATABASE_SCHEMA ?? "berahost";
if (!/^[a-z_][a-z0-9_]*$/.test(databaseSchema) || databaseSchema === "public") {
  throw new Error(
    "BERAHOST_DATABASE_SCHEMA must be a valid non-public PostgreSQL schema name (default: berahost).",
  );
}

const databaseUrl = process.env.BERAHOST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "BERAHOST_DATABASE_URL or DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Neon/PgBouncer rejects search_path as a PostgreSQL startup option. Set it
// with a session command whenever node-postgres establishes a pooled client.
export const pool = new Pool({
  connectionString: databaseUrl,
  onConnect: async (client) => {
    await client.query("SELECT pg_catalog.set_config('search_path', $1, false)", [databaseSchema]);
  },
  // keepAlive prevents idle TCP connections from being silently dropped.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  max: 10,
});

const schemaCheck = await pool.query(
  "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1",
  [databaseSchema],
);
if (schemaCheck.rowCount !== 1) {
  throw new Error(
    `Required database schema '${databaseSchema}' is missing; refusing to use PostgreSQL fallback schemas.`,
  );
}

export const db = drizzle(pool, { schema });

export * from "./schema";
