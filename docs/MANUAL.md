# SeeStorm Development Manual

## Project Overview

SeeStorm is a two-repo non-profit application providing ad-free severe weather visualization for Wisconsin communities. It ingests public NWS data, archives it permanently, and presents it on an interactive map.

| Repo | Purpose | Stack |
|------|---------|-------|
| [`seestorm`](https://github.com/eclecti-build/seestorm) | Frontend — interactive weather map | Next.js, MapLibre GL JS, Tailwind CSS |
| [`seestorm-ingest`](https://github.com/eclecti-build/seestorm-ingest) | Backend — data ingestion and archival | Go, PostGIS, Fly.io |

## Repository Structure

### seestorm (frontend)

```
seestorm/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # Root layout, metadata, dark theme
│   │   ├── page.tsx            # Home page, loads map dynamically
│   │   └── globals.css         # Tailwind imports, full-height body
│   └── components/
│       └── WeatherMap.tsx      # Core map component (MapLibre + NWS)
├── docs/
│   ├── ARCHITECTURE.md         # System architecture diagram
│   ├── SETUP.md                # Environment setup guide
│   ├── MANUAL.md               # This file
│   └── ROADMAP.md              # Feature roadmap
├── .env.example                # Environment variable template
├── next.config.ts              # Static export config
├── CLAUDE.md                   # AI assistant instructions
└── package.json
```

### seestorm-ingest (backend)

```
seestorm-ingest/
├── cmd/
│   └── ingest/
│       └── main.go             # Entry point, signal handling
├── internal/
│   ├── nws/
│   │   ├── client.go           # NWS API HTTP client
│   │   └── types.go            # Alert GeoJSON types
│   ├── spc/
│   │   ├── client.go           # SPC storm reports CSV parser
│   │   └── types.go            # Storm report types
│   ├── store/
│   │   ├── postgres.go         # PostGIS connection and queries
│   │   └── queries.go          # SQL constants (DDL, upserts)
│   ├── publisher/
│   │   └── snapshot.go         # JSON snapshot writer (local/R2)
│   └── poller/
│       └── poller.go           # Polling orchestrator (tick loop)
├── migrations/
│   └── 001_initial.sql         # PostGIS schema
├── .env.example                # Environment variable template
├── Dockerfile                  # Multi-stage Alpine build
├── fly.toml                    # Fly.io deployment config
└── CLAUDE.md                   # AI assistant instructions
```

## Development Workflow

### Running the Frontend

```bash
cd seestorm
cp .env.example .env.local
npm install
npm run dev
```

The frontend works standalone in MVP mode — it polls NWS directly from the browser. No backend required for basic alert visualization and radar.

### Running the Ingest Service

```bash
cd seestorm-ingest
cp .env.example .env
# Edit .env — set DATABASE_URL to your Neon connection string
go run ./cmd/ingest
```

The service starts polling NWS every 30 seconds, writes to PostGIS, and publishes a JSON snapshot locally.

### Running Both Together (Local)

1. Start the ingest service (writes `snapshots/active-events.json`)
2. Serve the snapshots directory: `npx serve seestorm-ingest/snapshots --cors -l 8080`
3. Set `NEXT_PUBLIC_EVENTS_API_URL=http://localhost:8080/active-events.json` in frontend `.env.local`
4. Start the frontend: `npm run dev`

## Data Flow

```
1. NWS publishes alert        → api.weather.gov/alerts/active?area=WI
2. Ingest service polls (30s) → Parses GeoJSON, deduplicates by nws_id
3. Write to PostGIS            → weather_events table with GIST spatial index
4. Publish snapshot            → active-events.json (local file or R2 upload)
5. CDN caches snapshot         → Cloudflare edge, 10s TTL
6. Frontend polls (10-30s)     → Renders polygons on MapLibre map
```

## Key Technical Decisions

### Why static export instead of SSR?

During a tornado outbreak, traffic spikes 10-100x. Static files on Cloudflare's CDN can't go down — there's no server to overwhelm. The map is a client-side component anyway (WebGL), so SSR provides no benefit for the core experience.

### Why poll instead of WebSockets?

50,000 concurrent WebSocket connections require dedicated infrastructure. 50,000 users polling a CDN-cached JSON file every 10 seconds hit the origin maybe once per 10 seconds total. The 10-second staleness is acceptable — NWS data itself only updates every 30-60 seconds.

### Why Go for ingestion?

~20MB memory footprint, single binary deployment, excellent HTTP stdlib. A single $3/month Fly.io machine handles the entire ingestion pipeline. Go's simplicity also makes it easy for new contributors to understand the codebase.

### Why PostGIS over plain Postgres?

NWS data is inherently spatial — warning polygons, tornado paths, storm report coordinates. PostGIS gives us GIST spatial indexes, `ST_Within` for "is this user inside a warning?", `ST_AsGeoJSON` for direct GeoJSON export, and `ST_Intersects` for finding overlapping events. These would require complex custom code without PostGIS.

## Database Schema

### weather_events

Stores every NWS alert with full geometry. Upserts by `nws_id` so re-polled alerts update in place.

| Column | Type | Purpose |
|--------|------|---------|
| `nws_id` | `TEXT UNIQUE` | NWS deduplication key |
| `event_type` | `TEXT` | Tornado Warning, Severe Thunderstorm Warning, etc. |
| `geometry` | `GEOMETRY(Geometry, 4326)` | Warning polygon, point, or linestring |
| `properties` | `JSONB` | Raw NWS properties (never lose data) |
| `effective_at` | `TIMESTAMPTZ` | When the alert became active |
| `expires_at` | `TIMESTAMPTZ` | When the alert expires |

### storm_reports

Stores SPC storm reports (tornado touchdowns, hail, wind damage) as point geometries.

| Column | Type | Purpose |
|--------|------|---------|
| `report_type` | `TEXT` | tornado, hail, wind |
| `magnitude` | `TEXT` | EF scale, hail diameter, wind speed |
| `geometry` | `GEOMETRY(Point, 4326)` | Report location |
| `reported_at` | `TIMESTAMPTZ` | Time of report |

## Conventions

### Commits

Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`

### Branches

Use prefix naming: `feat/`, `fix/`, `chore/`, `docs/`

### Code

- TypeScript: strict mode, no `any`, use `unknown` + type guards
- Go: standard project layout, `internal/` for non-exported packages
- Both: keep functions under 50 lines, error messages should be actionable

### Environment

- Never commit `.env` or `.env.local` files
- Always update `.env.example` when adding new variables
- Use Fly.io secrets for production backend config
- Use Cloudflare Pages env vars for production frontend config
