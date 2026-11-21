import { pgTable, serial, integer, varchar, boolean, timestamp, text, uniqueIndex } from "drizzle-orm/pg-core";

export const referralProgramTable = pgTable("referral_program", {
  id: serial("id").primaryKey(), enabled: boolean("enabled").notNull().default(true),
  referralsRequired: integer("referrals_required").notNull().default(3), rewardPlan: varchar("reward_plan", { length: 20 }).notNull().default("starter"),
  rewardDurationDays: integer("reward_duration_days").notNull().default(30), updatedBy: integer("updated_by"), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const referralRewardsTable = pgTable("referral_rewards", {
  id: serial("id").primaryKey(), referrerId: integer("referrer_id").notNull(), plan: varchar("plan", { length: 20 }).notNull(), durationDays: integer("duration_days").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("available"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), claimedAt: timestamp("claimed_at", { withTimezone: true }), expiresAt: timestamp("expires_at", { withTimezone: true }),
});
export const redeemCodesTable = pgTable("redeem_codes", {
  id: serial("id").primaryKey(), codeHash: varchar("code_hash", { length: 64 }).notNull().unique(), plan: varchar("plan", { length: 20 }).notNull(), durationDays: integer("duration_days").notNull(), maxRedemptions: integer("max_redemptions"), expiresAt: timestamp("expires_at", { withTimezone: true }), label: varchar("label", { length: 200 }), status: varchar("status", { length: 20 }).notNull().default("active"), createdBy: integer("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const redeemCodeRedemptionsTable = pgTable("redeem_code_redemptions", {
  id: serial("id").primaryKey(), codeId: integer("code_id").notNull(), userId: integer("user_id").notNull(), plan: varchar("plan", { length: 20 }).notNull(), durationDays: integer("duration_days").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("redeem_code_redemptions_code_user_uq").on(t.codeId, t.userId)]);
export const referralQualificationTable = pgTable("referral_qualifications", { referredId: integer("referred_id").primaryKey(), referrerId: integer("referrer_id").notNull(), qualifiedAt: timestamp("qualified_at", { withTimezone: true }).notNull().defaultNow() });
export const referralProgramAuditTable = pgTable("referral_program_audit", { id: serial("id").primaryKey(), adminId: integer("admin_id").notNull(), action: varchar("action", { length: 40 }).notNull(), details: text("details").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow() });
