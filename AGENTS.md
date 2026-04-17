<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Stack
- Next.js 16 (App Router, `output: "export"`), React 19, Tailwind 4, MapLibre GL, Turf.
- Tests: Vitest + @testing-library/react + jsdom. Colocate `*.test.ts(x)` with source.

## Deploy
- Cloudflare Pages native Git integration. No deploy workflow in this repo.
- `main` auto-deploys; PRs get preview URLs. CI only gates quality.

## Auth
- Clerk (`@clerk/nextjs`) — scaffolded, not wired.
- Middleware stub lives at `src/middleware.ts.example`. Do not rename to `.ts` without an explicit auth-wiring task.

## Commits
- Conventional prefixes: `feat: fix: chore: docs: refactor: test:`.
- No git hooks — Claude enforces format during review.

## Pre-commit Checklist
- Conventional prefix + "why" in message
- No secrets in diff
- No `any` in TypeScript (use `unknown` + type guards)
- `npm run lint`, `npm run typecheck`, `npm test` all pass
