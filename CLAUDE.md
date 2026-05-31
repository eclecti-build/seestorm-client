# SeeStorm Frontend

Non-profit severe weather visualization for communities across the United States.

## Stack
- Next.js (App Router) with static export
- MapLibre GL JS for map rendering
- Tailwind CSS for styling
- Deployed as Cloudflare Workers + Static Assets

## Dev
- `npm run dev` — local dev server
- `npm run build` — static export to `out/`
- `npm run lint` — ESLint

## Architecture
- See `docs/ARCHITECTURE.md` for full system diagram
- This repo is the frontend only
- Backend ingestion: `eclecti-build/seestorm-ingest`

## Data Flow
- Client polls same-origin Worker `/v1/*` routes for active alerts and history.
- Worker reads private R2 snapshots through the `SNAPSHOTS` binding; the browser does not poll NWS directly.
- Radar tiles from Iowa State Mesonet WMS (no key needed)
- Basemap style defaults in code and can be overridden with `NEXT_PUBLIC_MAP_STYLE_URL`.

## Code Conventions
- TypeScript strict mode, no `any`
- Components in `src/components/`
- MapLibre components must use `dynamic()` with `ssr: false`

---

## Stack (Detailed)
- **Next.js 16 App Router** with static export (`output: "export"`)
- **React 19**
- **Tailwind 4** (via `@tailwindcss/postcss`)
- **MapLibre GL** + `@vis.gl/react-maplibre` for map rendering
- **Turf** (`@turf/turf`) for geospatial math
- **Vitest** + `@testing-library/react` + jsdom for tests

## Deploy
- **Cloudflare Workers + Static Assets** via CF native Git integration (the unified successor to classic Pages). Config: `wrangler.jsonc` at repo root.
- CF runs `npm run build` → `npx wrangler deploy` on every push to `main`. Preview branches get a versioned URL via `npx wrangler versions upload`.
- CI in `.github/workflows/ci.yml` only gates quality (lint/typecheck/test/build); CF does the actual deploy.

### Worker architecture
- **Same deploy, two concerns.** This repo ships both the static Next.js export AND a Worker proxy in one bundle.
- `worker/index.ts` is the Worker entry point. It handles `/v1/*` API routes and falls through to `env.ASSETS` for everything else (the Next static export in `out/`).
- **R2 binding** — the Worker reads from the `seestorm-data` R2 bucket via an internal CF binding (`env.SNAPSHOTS`). The bucket has **no public access** — only this Worker (read) and the ingest service (write, via API token) can reach it.
- Public API surface is versioned: `/v1/active-events.json` → `seestorm-data/active-events.json`. Add new snapshot keys to the `PUBLIC_SNAPSHOTS` allowlist in `worker/index.ts`.
- Worker has its own tsconfig (`worker/tsconfig.json`) because it runs in the Workers runtime, not DOM/Node. `npm run typecheck` validates both.

## Auth
**None.** SeeStorm's public viewing path is fully open — no sign-in required to view alerts, the map, radar, or storm paths. This is a product principle: public safety data must stay frictionless.

Future features that might warrant **opt-in** user accounts (not blocking, never gating public data):
- User-submitted damage photos / spotter reports
- Post-event insurance assistance flows
- Admin dashboard for volunteers/data corrections

When that day comes, revisit auth with a specific use case — don't pre-commit to a vendor or an architectural pattern. See `../seestorm/docs/FUTURE.md` in the umbrella repo for the full list.

## Testing
- **Vitest** with jsdom environment.
- Colocate `*.test.ts(x)` alongside source files (not a separate `__tests__/` dir).
- Use `@testing-library/react` for component tests; `@testing-library/jest-dom` matchers are registered in `vitest.setup.ts`.
- **No snapshot tests** unless strongly justified — they rot and are rarely reviewed.
- Commands:
  - `npm test` — single run
  - `npm run test:watch` — watch mode

## Commits
- **Conventional-commit prefixes**: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- No Husky / commitlint installed. Commit-message format is enforced by Claude review before committing.

## Claude Review Checklist (before every commit)
- [ ] Conventional prefix present (`feat: fix: chore: docs: refactor: test:`)
- [ ] Message describes **why**, not just what
- [ ] No secrets, keys, tokens, or `.env*` contents in the diff
- [ ] No `any` in TypeScript — use `unknown` + type guards
- [ ] Tests updated or added for behavior changes
- [ ] `npm run verify` passes locally (chains the full CI gate: lint → format:check → typecheck → test → build, in the same order `.github/workflows/ci.yml` runs them). Use this instead of running the individual commands so we don't drift from CI.
