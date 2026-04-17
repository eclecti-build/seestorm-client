# SeeStorm Frontend

Non-profit severe weather visualization for Wisconsin communities.

## Stack
- Next.js (App Router) with static export
- MapLibre GL JS for map rendering
- Tailwind CSS for styling
- Deployed to Cloudflare Pages

## Dev
- `npm run dev` — local dev server
- `npm run build` — static export to `out/`
- `npm run lint` — ESLint

## Architecture
- See `docs/ARCHITECTURE.md` for full system diagram
- This repo is the frontend only
- Backend ingestion: `eclecti-build/seestorm-ingest`

## Data Flow
- Client polls CDN-cached JSON for active alerts (10s TTL)
- During MVP: direct NWS API polling from client
- Radar tiles from Iowa State Mesonet WMS (no key needed)
- Map tiles from Stadia Maps (dev) → Protomaps on R2 (prod)

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
- **Cloudflare Pages** via CF native Git integration. There is **no deploy workflow** in this repo.
- Pushes to `main` auto-deploy to production.
- PR branches automatically get preview URLs from Cloudflare.
- CI in `.github/workflows/ci.yml` only gates quality (lint/typecheck/test/build); it does not deploy.

## Auth
- **Clerk** via `@clerk/nextjs`.
- Middleware is scaffolded but **not active**: see `src/middleware.ts.example`.
- Activation (rename to `src/middleware.ts`, add route matchers, wire providers) is a separate architectural task — do not activate incidentally.

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
- [ ] `npm run lint`, `npm run typecheck`, and `npm test` pass locally
