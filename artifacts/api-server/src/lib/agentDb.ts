// Built-in databases for Agent Bera apps.
//
// When a user ticks "give my app a built-in database", the platform
// provisions an isolated Postgres role + schema inside the platform's own
// database cluster and hands the app a DATABASE_URL for that role. The
// app role owns ONLY its schema: it has no rights on the platform's
// schema or any other app's schema. Provisioning happens once per build —
// the returned connection string is persisted on the build's env vars by
// the caller, and a repeat call returns null (the role already exists and
// its password is known only to that persisted string).
import crypto from "crypto";
import { pool } from "@workspace/db";

export type BuiltinDb = { connectionString: string; schema: string; role: string };

function platformDatabaseUrl(): URL {
  const raw = process.env.BERAHOST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error("The platform database is not configured, so a built-in database cannot be provisioned.");
  return new URL(raw);
}

export async function provisionBuiltinDb(buildId: number): Promise<BuiltinDb | null> {
  const suffix = String(buildId).replace(/[^0-9]/g, "");
  if (!suffix) throw new Error("Invalid build id for database provisioning.");
  const role = `agent_app_${suffix}`;
  const schema = `agent_app_${suffix}`;
  const platformSchema = /^[a-z_][a-z0-9_]*$/.test(process.env.BERAHOST_DATABASE_SCHEMA || "") ? (process.env.BERAHOST_DATABASE_SCHEMA as string) : "berahost";
  const password = crypto.randomBytes(24).toString("hex");
  const client = await pool.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (existing.rowCount && existing.rowCount > 0) return null;
    await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION "${role}"`);
    await client.query(`ALTER ROLE "${role}" SET search_path = "${schema}"`);
    // Belt and braces: the role never gets anything on the platform schema.
    await client.query(`REVOKE ALL ON SCHEMA "${platformSchema}" FROM "${role}"`).catch(() => {});
  } finally {
    client.release();
  }
  const url = platformDatabaseUrl();
  url.username = role;
  url.password = password;
  return { connectionString: url.toString(), schema, role };
}
