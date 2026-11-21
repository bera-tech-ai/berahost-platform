# BERAHOST Subscription and Web Hosting TODO

## ✅ Canonical monthly subscriptions replace coin access
- Starter is KES 70/month with at most 1 bot and 1 web app (2 total deployments).
- Silver is KES 500/month with at most 13 bots and 13 web apps (26 total deployments).
- Gold is KES 800/month with at most 30 bots and 30 web apps (60 total deployments).
- PayHero is the payment provider for plan purchases and paid custom-domain requests; coin purchases, coin deployment charges, daily coin claims, and voucher-based access are no longer part of the user deployment flow.
- Successful payments extend the subscription for 30 days from the later of the current expiry or the callback time, and expose the resulting expiry to the user.

## ✅ Bot lifecycle and environment configuration
- Existing bot deployment, session backup, auto-restart, and Socket.IO console behavior remains available.
- Creating and starting a bot requires an active subscription and stays within the subscribed plan limit.
- When a subscription expires or a user is banned, all running bots are stopped and their deployment records/session data remain stored for renewal or admin review.
- Bot templates continue to scan `.env`, JSON, and JavaScript configuration values; deployment forms show required and optional variables without exposing server secrets.
- Startup restore, crash restart, scheduled restart, and GitHub redeploy paths refuse expired or banned users.

## ✅ GitHub web deployment hosting
- An authenticated user can submit a public GitHub repository URL, branch, optional build/start commands, and environment values.
- The server validates the repository URL, scans env configuration, builds when a build script/command is present, serves static output when present, and runs Node web apps when a start command is present.
- Every web deployment receives a unique hosted identity and URL, with status, logs, env scan, start/stop, and expiry state.
- Web deployments use the same subscription limit as bot deployments, are stopped and taken offline when entitlement expires, and remain stored until renewal.
- Users can request a custom domain for KES 134 through PayHero. Paid requests require the requested TXT verification token and become routable only after DNS verification.

## ✅ Admin controls
- Admin can ban/unban users, delete users through an audited soft-delete flow, force a subscription plan and expiry, revoke/expire a subscription, stop deployments, and see web deployment/payment state.
- Every administrative mutation is recorded in audit logs.

## ✅ Verification and delivery
- Updated UI navigation, dashboard, subscription page, payment history, and route manifest so coin purchasing is not presented as the deployment access model.
- Kept the existing bot deployment code paths functional while adding separate web runtime code.
- Completed schema push, TypeScript diagnostics, typecheck, production build, API health checks, canonical plan checks, and web deployment route checks.
- Saved and pushed checkpoint `26815492d86b81b648efb096ccb4a76de930fb76`; managed auto-publication was submitted from the checkpoint.

## ⏳ GitHub OAuth and connected repository deployment
- A user can connect GitHub from BERAHOST using OAuth and see the connected GitHub account; the OAuth grant permits access to private repositories.
- A user can sign in with GitHub; an existing BERAHOST account is matched by GitHub identity or verified email, and a new account can be created safely.
- The connected account can list accessible repositories and branches, select a private or public repository, and deploy it without pasting a repository URL.
- Connected web deployments store repository identity, branch, private/public state, and encrypted access credentials without returning tokens to the browser or logs.
- Auto deploy is enabled by default for connected web deployments, creates a signed GitHub push webhook, filters to the selected branch, records commit metadata, and redeploys the latest revision after each matching commit.
- Users can disable auto deploy, reconnect/disconnect GitHub, and delete a deployment; deletion removes its managed webhook, runtime, temporary build files, and dependent domain orders.
- Existing pasted public URL deployments and existing manually configured bot webhooks remain functional.

## ⏳ Google OAuth sign-in
- The login screen offers “Continue with Google” alongside password and GitHub sign-in.
- Google OAuth uses the public callback `https://berahost-bfer3udn.manus.space/api/auth/google/callback`, validates state, exchanges the authorization code server-side, and requests only OpenID profile/email identity scopes.
- Existing BERAHOST accounts are matched by Google subject or verified email; new accounts receive a generated password hash and verified status.
- Google client credentials are stored as protected server secrets and are never shipped to the browser, logged, or persisted as access tokens.

## ⏳ Manus-hosted deployment
- Run the existing BERAHOST Docker application as a Manus-hosted server container without replacing its PostgreSQL integration with Manus's MySQL database.
- Connect the user's PostgreSQL database through a protected runtime `DATABASE_URL` and do not expose database credentials in client assets or logs.
- Set a unique production `SESSION_SECRET` and production admin password; do not use documented default admin credentials.
- Serve the application health check at `/api/healthz` and provide the public URL only after the hosted deployment succeeds.
- Document any runtime-written files that are not durable across container restarts and keep persistent application records in PostgreSQL or durable storage.

## ⏳ Plan-aligned API-key access across the customer-owned core
- The API-key page no longer documents legacy coin access, coin balances/rewards, or stale M-Pesa/payment routes; subscription plans and entitlement behavior follow `lib/subscriptions.ts` and the server plan endpoint.
- Existing `read`, `write`, and `payments` scopes consistently protect the approved customer-owned APIs: bot and web deployments, marketplace submissions, plans/status, customer payments, owned logs/metrics, support, notifications, teams, referrals, scheduled operations, connected GitHub repository discovery, and API-key management.
- Every customer resource remains owner-scoped; API-key authorization does not bypass the existing plan checks or invent a new rate limit or plan quota.
- Admin operations, login/password/session-security operations, session backup/restore, pairing codes, OAuth credential management, provider callbacks, raw stored secrets, obsolete payment endpoints, legacy coin APIs/rewards, and cross-customer leaderboard data are unavailable through API keys.
- API-key responses do not expose raw deployment environment values, webhook secrets, invitation credentials in general resource responses, or credential-bearing log content.
- API-key create/list/revoke and approved customer endpoints validate key scopes; user-created API keys cannot grant admin scope or broaden the caller's own API-key permissions.
- Embedded developer documentation and OpenAPI describe the actual supported paths, methods, required scopes, request/response shapes, owner behavior, plan failures, examples, and secret-handling boundary without advertising excluded routes.
- API-key access is enabled for approved customer functionality currently protected only by browser-session middleware, without exposing excluded session or OAuth operations.

## ⏳ Referral-first trust and reliability improvements
- A referral share link opens `/register?ref=CODE` on the current BERAHOST origin; registration pre-fills the code, submits it with signup, and clearly reports invalid codes. Successful signup records the referrer relationship once in both the user attribution field and referral history. Referral behavior is attribution-only: signup and referral application award no legacy coin balance or reward.
- The customer dashboard shows each owned bot/web deployment's current state, uptime where available, last restart/error context where available, and bot connection state only when the runtime can report it. Web redeploy and rollback controls reuse retained successful deployment artifacts and clearly explain when no rollback target exists.
- Customers can see active plan, canonical per-plan deployment limits, used/remaining bot and web capacity, and expiry/renewal date from server-returned plan data. No replacement limits or API-request quotas are invented.
- Payment history exposes provider status, amount, date, receipt/reference when actually supplied, and actionable pending/failed guidance. The interface does not promise automatic renewals or settlement guarantees unsupported by PayHero integration.
- New customers receive a persistent, dismissible onboarding checklist for plan selection, first deployment, required configuration, and verifying healthy status; completion is based on actual account state.
- Customers can inspect a privacy-safe activity history for important account/deployment/API-key/payment actions, with credentials, secret values, session material, and other customers' data excluded.
- A public service-status page reports only live checks/known incident information that BERAHOST can substantiate, distinguishing dashboard/API, database, hosting, and payment-provider checks; it does not imply an uptime SLA or monitoring history that is not implemented.
- Any persistence changes are scoped to the isolated `berahost` PostgreSQL schema; existing `public` data remains untouched. Complex implementation is checked by one read-only validation agent, and build/check results and publication status are reported accurately.
