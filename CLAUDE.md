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
