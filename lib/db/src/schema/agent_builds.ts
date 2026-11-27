import { pgTable, serial, integer, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One Agent Bera build: a user's plain-language prompt, the site the agent
// generated from it, and the web deployment it was published as. The build
// row tracks the agent's own stages (generating -> publishing -> deploying);
// once a web deployment exists, its row owns the runtime status and the
// build simply links to it.
export const agentBuildsTable = pgTable("agent_builds", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  prompt: text("prompt").notNull(),
  name: varchar("name", { length: 120 }),
  status: varchar("status", { length: 20 }).default("generating").notNull(),
  error: text("error"),
  repoUrl: text("repo_url"),
  repoFullName: varchar("repo_full_name", { length: 255 }),
  webDeploymentId: integer("web_deployment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const insertAgentBuildSchema = createInsertSchema(agentBuildsTable).omit({ id: true, createdAt: true });
export type InsertAgentBuild = z.infer<typeof insertAgentBuildSchema>;
export type AgentBuild = typeof agentBuildsTable.$inferSelect;
