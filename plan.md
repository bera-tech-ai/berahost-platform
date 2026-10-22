# BERAHOST Subscription and Web Hosting Plan

## Scope
Replace coin-based access with monthly Starter, Silver, and Gold subscriptions for bot and web hosting while preserving the existing bot deployment engine. Add GitHub-based static/Node web deployments, unique hosted URLs, optional paid custom-domain requests, automatic suspension at subscription expiry, and audited admin controls.

## Implementation approach
- Keep the existing bot process, WhatsApp session backup, Socket.IO logs, and bot template/env scanning paths intact; remove coins from deployment eligibility and user-facing navigation.
- Create one canonical subscription catalog: Starter KES 200 / 5 bots, Silver KES 500 / 13 bots, Gold KES 800 / 30 bots, each for 30 days. PayHero callbacks extend expiry from the later of now or current expiry.
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
