import { pgTable, serial, integer, varchar, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const webDeploymentsTable = pgTable("web_deployments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  repoUrl: text("repo_url").notNull(),
  branch: varchar("branch", { length: 120 }).default("main").notNull(),
  customName: varchar("custom_name", { length: 100 }),
  slug: varchar("slug", { length: 80 }).unique().notNull(),
  buildCommand: text("build_command"),
  startCommand: text("start_command"),
  envVars: jsonb("env_vars"),
  scannedVars: jsonb("scanned_vars"),
  outputDirectory: text("output_directory"),
  runtimePort: integer("runtime_port"),
  pid: integer("pid"),
  status: varchar("status", { length: 20 }).default("queued").notNull(),
  buildLog: text("build_log"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const insertWebDeploymentSchema = createInsertSchema(webDeploymentsTable).omit({ id: true, createdAt: true });
export type InsertWebDeployment = z.infer<typeof insertWebDeploymentSchema>;
export type WebDeployment = typeof webDeploymentsTable.$inferSelect;
