# SeeStorm Development Manual

## Project Overview

SeeStorm is a two-repo public-safety application for ad-free severe weather visualization in Great Lakes communities. The ingest service polls public weather sources, archives events, publishes JSON snapshots to private R2, and the client Worker exposes the reviewed `/v1/*` public API surface.

| Repo | Purpose | Stack |
|---|---|---|
| [`seestorm-client`](https://github.com/eclecti-build/seestorm-client) | Public web app and Worker read API | Next.js static export, Cloudflare Workers, MapLibre GL JS, Tailwind CSS |
| [`seestorm-ingest`](https://github.com/eclecti-build/seestorm-ingest) | Data ingestion and archival | Go, PostGIS, Fly.io, Cloudflare R2 |

## Repository Structure

### seestorm-client

```text
seestorm-client/
├── src/
│   ├── app/                   # Next.js App Router static export
│   ├── components/            # Map and chrome components
│   └── lib/                   # Client-side parsing, filtering, and helpers
├── worker/
│   ├── index.ts               # Cloudflare Worker for /v1/* and assets
│   └── constants.ts           # Cache-Control contract for Worker responses
├── public/                    # Static data and public assets
├── docs/
├── wrangler.jsonc             # Worker + static assets + R2 binding
└── package.json
```

### seestorm-ingest

```text
seestorm-ingest/
├── cmd/ingest/                # Entry point
├── internal/nws/              # NWS API client and parsers
├── internal/spc/              # SPC storm report client
├── internal/store/            # PostGIS persistence
├── internal/publisher/        # Local and R2 snapshot publishing
├── internal/poller/           # Polling loop
├── migrations/                # SQL baseline
├── Dockerfile
└── fly.toml
```

## Development Workflow

### Running the Client

```bash
cd seestorm-client
npm install
npm run dev
```

The local Next dev server serves the app shell. Production API traffic goes through the Cloudflare Worker routes under `/v1/*`; use `npm run cf:dev` when validating Worker behavior locally.

### Running the Ingest Service

```bash
cd seestorm-ingest
cp .env.example .env
# Edit .env and set DATABASE_URL
go run ./cmd/ingest
```

The service polls NWS and SPC sources, writes to PostGIS, and publishes snapshots locally and/or to Cloudflare R2 depending on configuration.

## Data Flow

```text
1. NWS/SPC publish weather data
2. seestorm-ingest polls, parses, deduplicates, and stores events
3. seestorm-ingest writes active and history snapshots to private R2
4. seestorm-client Worker reads allowed R2 keys through the SNAPSHOTS binding
5. Browser fetches same-origin /v1/* routes and renders the MapLibre view
```

## Key Technical Decisions

### Why static export plus Worker?

The map is a client-side WebGL experience, so SSR does not materially improve the core path. Static assets keep the page durable during traffic spikes, while the Worker gives the project a narrow, reviewable API surface for snapshots, history, security headers, and privacy-sensitive geo suggestions.

### Why poll cached JSON instead of WebSockets?

High-concurrency weather events are a better fit for cacheable snapshot reads than dedicated connections. The ingest cadence and Worker cache headers keep the public view current enough for the data sources while avoiding an origin service on the user traffic path.

### Why private R2?

The bucket has no public access. Only the client Worker reads through an internal binding, and only ingest writes through scoped credentials. Public routes are code-reviewed in `worker/index.ts`.

### Why Go and PostGIS for ingest?

Go produces a small single binary for Fly.io, and PostGIS gives native spatial indexing and geometry operations for NWS polygons, storm paths, and event archive queries.

## Conventions

- TypeScript: strict mode, no `any`; use `unknown` plus type guards.
- Go: wrap errors with `%w`; no panics outside startup.
- Tests: colocate focused tests with source.
- Commits: use `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, or `test:`.
- Environment: never commit secrets or local `.env*` files.
