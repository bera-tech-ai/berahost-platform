import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const SUBSCRIPTION_PLANS = {
  starter: { id: "starter", name: "Starter", priceKes: 70, maxDeployments: 2, maxBots: 1, maxWebApps: 1, features: ["1 bot + 1 web app", "Env scanning", "Hosted deployment URL"] },
  silver: { id: "silver", name: "Silver", priceKes: 500, maxDeployments: 26, maxBots: 13, maxWebApps: 13, features: ["Up to 13 bots + 13 web apps", "Priority runtime", "GitHub web deploys"] },
  gold: { id: "gold", name: "Gold", priceKes: 800, maxDeployments: 60, maxBots: 30, maxWebApps: 30, features: ["Up to 30 bots + 30 web apps", "Custom domain requests", "Priority support"] },
} as const;

export type SubscriptionPlanId = keyof typeof SUBSCRIPTION_PLANS;
export const FREE_PLAN = { id: "free", name: "No active subscription", priceKes: 0, maxDeployments: 0, maxBots: 0, maxWebApps: 0, features: ["Renew to deploy"] } as const;
export const SUBSCRIPTION_TERM_DAYS = 30;

export function getPlan(plan: string | null | undefined) {
  return (plan && plan in SUBSCRIPTION_PLANS ? SUBSCRIPTION_PLANS[plan as SubscriptionPlanId] : FREE_PLAN);
}

export function isSubscriptionActive(user: { subscriptionPlan?: string | null; subscriptionExpiresAt?: Date | null; isBanned?: boolean }) {
  return !user.isBanned && !!user.subscriptionExpiresAt && user.subscriptionExpiresAt.getTime() > Date.now() && !!user.subscriptionPlan && user.subscriptionPlan in SUBSCRIPTION_PLANS;
}

export function subscriptionExpiryFrom(current: Date | null | undefined, now = new Date()) {
  const base = current && current.getTime() > now.getTime() ? current : now;
  const expiry = new Date(base);
  expiry.setUTCDate(expiry.getUTCDate() + SUBSCRIPTION_TERM_DAYS);
  return expiry;
}

export async function getUserEntitlement(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) return null;
  return { user, plan: getPlan(user.subscriptionPlan), active: isSubscriptionActive(user) };
}
