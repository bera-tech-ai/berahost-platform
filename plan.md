# BERAHOST Subscription and Web Hosting Plan

## Scope
Replace coin-based access with monthly Starter, Silver, and Gold subscriptions for bot and web hosting while preserving the existing bot deployment engine. Add GitHub-based static/Node web deployments, unique hosted URLs, optional paid custom-domain requests, automatic suspension at subscription expiry, and audited admin controls.

## Implementation approach
- Keep the existing bot process, WhatsApp session backup, Socket.IO logs, and bot template/env scanning paths intact; remove coins from deployment eligibility and user-facing navigation.
- Use `artifacts/api-server/src/lib/subscriptions.ts` as the canonical runtime catalog: Starter KES 70/month (1 bot + 1 web app; 2 total deployments), Silver KES 500/month (up to 13 bots + 13 web apps; 26 total deployments), and Gold KES 800/month (up to 30 bots + 30 web apps; 60 total deployments), each for 30 days. PayHero callbacks extend expiry from the later of now or current expiry.
- Centralize entitlement checks for create/start/restore/restart and run an expiry reconciler that stops processes but retains deployment records and web project metadata for later renewal.
- Add a separate `web_deployments` model and runtime service. Clone a validated public GitHub URL, scan package/env configuration, run a build when configured, serve static output or proxy a Node process, and expose a unique `/web/<slug>` URL. Do not route web projects through the bot deployment tables.
- Add custom-domain orders at KES 134 through PayHero, with verification-token and paid/active states. A domain becomes routable when paid and verified; DNS/TLS remains platform/provider controlled.
- Add audited admin delete-user, ban/unban, force-plan, and subscription expiry controls. User deletion is soft deletion so payment/audit history remains consistent.
- Use server-returned plan data in the UI. Replace wallet/coin purchase surfaces with subscription status, plan cards, payment history, and a web deployment console.

## Design
### Candidate styles
- **Bera Signal Console** — probability 0.06: dark operator-console surfaces with electric lime accents and dense status cues.
- **Warm SaaS Command Center** — probability 0.04: soft panels, amber highlights, and an approachable operational hierarchy.
- **Minimal Cloud Terminal** — probability 0.08: monochrome interface with restrained green state indicators.

### Chosen direction: Bera Signal Console
- **Design Movement:** cyber-operations dashboard fused with contemporary SaaS product polish.
- **Core Principles:** high signal-to-noise; visible system state; fast scan paths; confident but readable controls.
- **Color Philosophy:** near-black surfaces make logs and status colors legible; Bera green signals active infrastructure; warm amber marks billing attention.
- **Layout Paradigm:** persistent command rail with asymmetrical operational panels and full-width activity bands rather than a centered marketing grid.
- **Signature Elements:** lime status pips, terminal-inspired data rows, and rounded glass panels with thin luminous borders.
- **Interaction Philosophy:** every action exposes pending, active, suspended, and expired state immediately.
- **Animation:** short state transitions only; no decorative loops competing with logs or payment feedback.
- **Typography System:** Inter for UI; JetBrains Mono for IDs, domains, timestamps, and deployment logs.
- **Brand Essence:** a sharp hosting command center for bots and web apps — operational, transparent, empowering.
- **Brand Voice:** direct, technical, and encouraging. “Your deployment is live.” “Renew before the runtime sleeps.”
- **Wordmark & Logo:** retain the existing BERA mark with compact uppercase wordmark treatment.
- **Signature Brand Color:** electric Bera green as the action and health signal.

## Project structure
- `artifacts/api-server/src/lib/subscriptions.ts`: canonical plans and entitlement helpers.
- `artifacts/api-server/src/lib/webProcess.ts`: isolated web clone/build/run/stop and request proxy helpers.
- `artifacts/api-server/src/routes/payments.ts`: PayHero subscription and domain payment flows.
- `artifacts/api-server/src/routes/webDeployments.ts`: web project CRUD, env scan, lifecycle, and domain orders.
- `artifacts/api-server/src/routes/admin.ts`: audited user and subscription administration.
- `lib/db/src/schema`: web deployment and domain order tables; existing bot tables remain compatible.
- `artifacts/berahost/src/pages/subscriptions.tsx`: canonical plan purchase/status UI.
- `artifacts/berahost/src/pages/web-deployments.tsx`: GitHub web deployment workflow and hosted URLs.
- `artifacts/berahost/public/manus-routes.json`: synchronized route manifest.

## GitHub-connected deployment extension

Add GitHub OAuth for signed-in users and a GitHub sign-in path that uses the same callback. OAuth access tokens are encrypted at rest with a server-side key. The integration stores the GitHub account identity on the BERAHOST user and exposes repository metadata through GitHub's API, including private repositories permitted by the OAuth `repo` scope.

Web deployments will accept a selected GitHub repository and branch instead of requiring a pasted public URL. The deployment record stores the repository identity, whether it is private, and whether automatic deployment is enabled. Repository downloads use the user's encrypted GitHub token when needed; public URL deployments remain backward compatible.

When a connected deployment is created with automatic deployment enabled, BERAHOST creates a GitHub push webhook for the selected repository using a per-deployment signing secret. The webhook validates GitHub's HMAC signature, filters to the selected branch, records commit metadata, and queues a safe redeploy. Deleting a deployment removes its GitHub webhook and temporary build files. Existing manually configured bot webhooks remain supported.

### GitHub-connected product behavior

- Users can connect GitHub from BERAHOST and see the connected GitHub account.
- Users can sign in with GitHub; existing accounts are matched by verified GitHub identity or email, and new accounts are created with a generated password hash.
- Repository selection shows repositories the connected GitHub account can access, including private repositories allowed by the OAuth grant.
- A selected repository can be deployed without pasting its URL.
- Auto deploy is enabled by default for connected web deployments and redeploys on pushes to the selected branch.
- Users can disable auto deploy, change the branch, disconnect GitHub, and delete deployments.
- Existing public URL deployments and existing manual webhook records continue to work.

### GitHub-connected design direction

Use a **Git-native control room**: repository identity is primary, branch and commit state are visible, automation is explicit, and the existing dark BERAHOST command-center styling is preserved. Cyan marks connected actions, green marks healthy automation, amber marks permissions or pending hooks, and red is reserved for destructive or failed states. Use concise headings such as “Connect your source once.” and “Every push, shipped safely.”

### GitHub-connected project structure

- `lib/db/src/schema/users.ts`: GitHub identity and encrypted token fields.
- `lib/db/src/schema/web_deployments.ts`: repository identity, auto-deploy state, and commit metadata.
- `artifacts/api-server/src/lib/github.ts`: OAuth, GitHub API, token encryption, repository listing, and webhook helpers.
- `artifacts/api-server/src/routes/auth.ts`: GitHub sign-in and callback.
- `artifacts/api-server/src/routes/github.ts`: connect/disconnect, repository listing, and managed webhook operations.
- `artifacts/api-server/src/routes/webDeployments.ts`: selected-repository deployment creation and deletion cleanup.
- `artifacts/api-server/src/lib/webProcess.ts`: authenticated repository download and redeploy startup.
- `artifacts/berahost/src/pages/github-integration.tsx`: connection state, repository picker, and automation settings.
- `artifacts/berahost/src/pages/web-deployments.tsx`: connected-repository deployment flow and auto-deploy controls.

GitHub OAuth requires an OAuth App callback URL of `https://berahost-bfer3udn.manus.space/api/auth/github/callback` and secrets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_TOKEN_ENCRYPTION_KEY`. Use the GitHub `repo` scope for private repository contents and webhook management. Webhook endpoints remain unauthenticated but HMAC-protected; tokens are never returned to browsers or logs.

## Google sign-in extension

Add Google OAuth as a second external sign-in provider while preserving password and GitHub login. Use server-side authorization-code exchange with `openid email profile`, validate the returned verified email, match an existing BERAHOST account by Google subject or email, and create a new account with a generated password hash when no match exists. Store only the Google subject and avatar metadata; never store or expose Google access tokens. Bind OAuth state to the existing session, use the fixed public callback URL `https://berahost-bfer3udn.manus.space/api/auth/google/callback`, and keep return paths limited to internal application routes.


## API-key developer platform extension

Expand API keys to cover the customer-owned BERAHOST core: bot catalog and deployments, web deployments, customer marketplace submissions, plan catalog/status, customer subscription payments and payment history/status, owned logs/metrics, support tickets, notifications, teams, referrals, scheduled restarts, GitHub repository discovery where the account is already connected, and self-service API-key management. Use the existing `read`, `write`, and `payments` scopes with one documented hierarchy; enforce the required scope in every protected route, and retain owner checks for all customer resources.

Use the existing canonical plans and entitlement checks. API-key calls execute as the key owner and must not bypass subscription status or deployment capacity limits. Do not invent API-request quotas or new plan features; expose plan details from the server catalog rather than duplicating plan facts in the guide.

Exclude admin operations, login/password/session-security operations, session backup/restore and pairing codes, OAuth credential management, provider callbacks, raw stored secrets, legacy coin routes/rewards, the public cross-customer leaderboard, and obsolete payment endpoints. Do not return raw environment values, webhook secrets, invitation credentials, or credential-bearing log content in API-key responses. Preserve customer ownership boundaries.

### Implementation approach and project structure

- `artifacts/api-server/src/middlewares/requireAuth.ts` and `middlewares/requireApiKey.ts`: central scope hierarchy and explicit session-versus-key authorization.
- `artifacts/api-server/src/routes`: apply the intended read/write/payments guard to every approved customer route; enable key access for safe customer endpoints currently restricted to sessions; keep sensitive and administrative routes unavailable to keys.
- `artifacts/api-server/src/lib/subscriptions.ts`: remain the canonical source for plan data and entitlements; existing plan gates remain authoritative.
- `artifacts/berahost/src/pages/api-keys.tsx`: show the approved scope, complete endpoint guide, setup/examples, plan behavior, error guidance, and secret-handling rules without coin claims.
- `lib/api-spec/openapi.yaml`: match the supported customer API surface, authentication, scopes, and safe response shapes; remove obsolete coin/payment descriptions from the developer contract.

### User-approved security boundary

Customer API keys may access only the key owner's customer resources. They must not grant access to admin operations, login/password/session security, OAuth credential management, or raw stored secrets. Any endpoint that returns such values must be excluded or redacted before it is documented for keys. Use only the existing scopes and subscription plan rules.

## User-approved referral benefits and redeem codes

- A referral counts only after the newly referred account is verified and successfully completes its first paid subscription. Persist qualification once per referred user so callback retries cannot count it twice.
- Defaults: three qualified referrals earn one 30-day Starter reward; qualified progress carries forward. Admins can enable/pause the program and configure the threshold, reward plan (Starter/Silver/Gold), and reward duration. Do not issue legacy coins, cash, or discounts.
- Keep earned referral rewards claimable and auditable. Claiming extends an existing Starter subscription or activates Starter; never silently downgrade an active higher plan.
- Replace referral queries against the undeclared `referrals` relation with the existing `users.referred_by` relationship, and expose the current-origin share link and qualification/reward progress to the signed-in user.
- Admin-created redeem codes select a canonical plan, duration, optional max uses, and optional expiry; admins can pause/revoke codes without deleting redemption history. Users redeem while signed in, at most once per account per code. Redemption must be atomic against use limits and must not silently downgrade a higher active plan.
- Store only a normalized code hash, show the generated plaintext once to the creating admin, and audit creation, status changes, redemptions, reward grants, and reward claims.
- Implement persistence in dedicated Drizzle models and an additive SQL migration; scope any eventual application strictly to the isolated `berahost` schema. Do not execute production DDL or update the live Manus deployment as part of the GitHub push.

### Project structure for the approved benefit features

- `lib/db/src/schema/referrals.ts` and `redeem_codes.ts`: qualified-referral/reward ledgers and code/redemption ledgers.
- `artifacts/api-server/src/lib/referralRewards.ts`: idempotent qualification, reward progress, and claim handling.
- `artifacts/api-server/src/routes/referrals.ts`: customer attribution/progress/claim and code redemption.
- `artifacts/api-server/src/routes/admin.ts`: admin program settings and code create/list/pause/revoke APIs with audit logging.
- `artifacts/berahost/src/pages/referrals.tsx` and `/redeem`: customer share/progress/claim and code-entry flows.
- `artifacts/berahost/src/pages/admin/referrals.tsx`: program configuration and code management.
- `lib/db/migrations`: additive isolated-schema migration; no production migration is run during this task.

## Trust and reliability improvement extension

Implement in this order, beginning with referral attribution and then strengthening day-to-day operations. Referral links must prefill the code on registration, signup must persist owner attribution exactly once, and the program remains attribution-only unless the product owner defines a concrete plan benefit; do not issue legacy coin rewards. Add an operational health view with deployment state, uptime, restart/error context, and bot connectivity where the runtime exposes it; add safe web redeploy and last-successful-version rollback where existing build artifacts support it. Surface canonical plan limits, current usage and expiry from server data. Improve payment history/status, receipts and pending/failed-payment guidance using PayHero's real transaction state; do not claim renewal automation absent from backend behavior. Add a persistent onboarding checklist, a customer-visible audit/activity feed that excludes secrets, and a public service-status page based on checks the application can actually perform. Preserve the current BERAHOST design system and PostgreSQL schema/data boundaries; any schema changes must target the isolated `berahost` schema and must not modify `public`.

Prefer existing runtime metrics, payment, notification, audit and plan endpoints. Add only the minimum persistence needed for customer activity or incident history, and do not invent SLAs, automated monitoring, payment guarantees, referral rewards, or request quotas.
