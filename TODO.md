# BERAHOST Delivery TODO

## Migrate the existing BERAHOST repository into the managed project
- Preserve the existing full-stack repository structure and functionality.
- Keep the source recovery checkout separate from the managed project.
- Retain the React/Vite frontend, Express/Socket.IO API, Drizzle/PostgreSQL data layer, and current public routes.

## Make the application runnable in Preview
- Install the checked-in pnpm workspace dependencies without bypassing lifecycle policies.
- Start the API and frontend on the configured managed runtime listeners.
- Verify the frontend, API health endpoint, and `/manus-routes.json` respond successfully.

## Prepare live publication
- Configure the managed project build/runtime/deploy contract for the existing application.
- Keep required protected values such as `DATABASE_URL`, `SESSION_SECRET`, and admin credentials out of source control.
- Create a checkpoint from the verified source before publishing.

## Future updates
- Apply the user’s specific requested product or design changes after they are provided.
