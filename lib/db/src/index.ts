
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseSchema =
  process.env.BERAHOST_DATABASE_SCHEMA ?? "berahost";

if (
  !/^[a-z_][a-z0-9_]*$/.test(databaseSchema) ||
  databaseSchema === "public"
) {
  throw new Error(
    "BERAHOST_DATABASE_SCHEMA must be a valid non-public PostgreSQL schema name (default: berahost)."
  );
}

const databaseUrl =
  process.env.BERAHOST_DATABASE_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "BERAHOST_DATABASE_URL or DATABASE_URL must be set."
  );
}

export const pool = new Pool({
  connectionString: databaseUrl,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  max: 10,
});

// Verify the required schema exists without sending search_path
// as a PostgreSQL startup parameter.
const schemaCheck = await pool.query(
  `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
  [databaseSchema]
);

if (schemaCheck.rowCount !== 1) {
  throw new Error(
    `Required database schema '${databaseSchema}' is missing.`
  );
}

export const db = drizzle(pool, { schema });

export * from "./schema";
