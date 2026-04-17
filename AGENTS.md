<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Stack
- Next.js 16 (App Router, `output: "export"`), React 19, Tailwind 4, MapLibre GL, Turf.
- Tests: Vitest + @testing-library/react + jsdom. Colocate `*.test.ts(x)` with source.

## Deploy
- Cloudflare Workers + Static Assets via CF native Git integration. Config in `wrangler.jsonc`.
- `main` auto-deploys via `npx wrangler deploy`; PRs get preview URLs via `npx wrangler versions upload`.
- CI only gates quality.

## Worker proxy
- `worker/index.ts` handles `/v1/*` routes (reads from private R2 bucket `seestorm-data` via `env.SNAPSHOTS` binding), falls through to static assets for everything else.
- R2 bucket has NO public access — only this Worker reads, only ingest writes (API token).
- Add new public snapshot keys to `PUBLIC_SNAPSHOTS` allowlist in `worker/index.ts`.
- Worker has its own tsconfig at `worker/tsconfig.json`.

## Auth
- **None.** Public data is public. No sign-in gates the map, alerts, or storm paths.
- Future opt-in features (photo/damage uploads, spotter reports, admin dashboard) may add auth — scoped narrowly when the use case lands. Do not pre-scaffold vendors.

## Commits
- Conventional prefixes: `feat: fix: chore: docs: refactor: test:`.
- No git hooks — Claude enforces format during review.

## Pre-commit Checklist
- Conventional prefix + "why" in message
- No secrets in diff
- No `any` in TypeScript (use `unknown` + type guards)
- `npm run lint`, `npm run typecheck`, `npm test` all pass
