# BERAHOST Live Migration Plan

## Scope
Migrate the existing BERAHOST repository into a managed live web project, preserve its full-stack behavior, make the frontend and API runnable in Preview, and prepare the current source for subsequent user-requested updates.

## Implementation approach
- Preserve the existing pnpm workspace structure: React/Vite frontend in `artifacts/berahost`, Express/Socket.IO API in `artifacts/api-server`, and Drizzle/PostgreSQL code in `lib/db`.
- Run the API and frontend as separate development listeners during Preview, with the frontend proxying `/api` and Socket.IO traffic to the API.
- Use the managed project server and database capabilities for live deployment; protected runtime values remain environment secrets.
- Keep the source checkout at `/home/ubuntu/berahost-source` as a recovery copy while the managed project uses `/home/ubuntu/berahost`.

## Design

### Candidate styles
- **Bera Signal Console** — probability 0.06: dark operator-console surfaces with electric lime accents and dense status cues.
- **Warm SaaS Command Center** — probability 0.04: soft panels, amber highlights, and an approachable operational hierarchy.
- **Minimal Cloud Terminal** — probability 0.08: monochrome interface with restrained green state indicators.

### Chosen direction: Bera Signal Console
- **Design Movement:** cyber-operations dashboard fused with contemporary SaaS product polish.
- **Core Principles:** high signal-to-noise; visible system state; fast scan paths; confident but readable controls.
- **Color Philosophy:** near-black surfaces make logs and status colors legible; Bera green signals active infrastructure; warm amber marks attention without turning every state into an alarm.
- **Layout Paradigm:** persistent left command rail with asymmetrical operational panels and full-width activity bands rather than a centered marketing grid.
- **Signature Elements:** lime status pips, terminal-inspired data rows, and rounded glass panels with thin luminous borders.
- **Interaction Philosophy:** every action should expose state immediately through inline feedback, optimistic transitions, or a clear pending state.
- **Animation:** short, purposeful transitions for panel entry and live-state changes; avoid decorative loops that compete with logs.
- **Typography System:** Inter for UI and navigation; JetBrains Mono for logs, IDs, timestamps, and technical values.
- **Brand Essence:** a sharp, self-hosted command center for running WhatsApp bots with confidence — operational, transparent, empowering.
- **Brand Voice:** direct, technical, and encouraging. Example lines: “Your bot is live. Watch the signal.” and “Pair once, operate from anywhere.”
- **Wordmark & Logo:** retain the existing BERA mark and pair it with compact uppercase wordmark treatment.
- **Signature Brand Color:** electric Bera green, used as the recognizable action and health signal.

## Project structure
- `artifacts/berahost`: public React dashboard and landing pages.
- `artifacts/api-server`: Express routes, Socket.IO events, sessions, bot process control, and startup seeding.
- `lib/db`: Drizzle schema and database client.
- `lib/api-spec`, `lib/api-zod`, `lib/api-client-react`: API contract and generated client layers.
- `public/manus-routes.json`: managed route manifest for the Preview and publishing system.
