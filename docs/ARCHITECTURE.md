# SeeStorm Architecture

## Overview

SeeStorm is an ad-free severe weather visualization platform for Great Lakes communities. It renders active alerts, storm paths, radar, and recent history from public weather data processed by the companion ingest service.

## System Architecture

```text
DATA SOURCES
  NWS alerts API
  SPC storm reports
  Iowa Mesonet radar tiles

        |
        v

seestorm-ingest (Go on Fly.io)
  - polls NWS/SPC
  - deduplicates by upstream event IDs
  - writes archival records to PostGIS
  - publishes active and history JSON snapshots to private R2

        |
        v

Cloudflare R2 (private bucket)
  - no public bucket access
  - ingest writes with scoped credentials
  - client Worker reads through the SNAPSHOTS binding

        |
        v

seestorm-client (Cloudflare Worker + static assets)
  - serves the Next.js static export from out/
  - exposes reviewed same-origin /v1/* routes
  - applies security headers and cache contracts
  - falls through to static assets for non-API paths

        |
        v

Browser
  - MapLibre renders basemap, radar, alerts, history, and location UI
```

## Public API Surface

The Worker owns the public read API:

| Route | Source | Cache policy |
|---|---|---|
| `/v1/active-events.json` | `active-events.json` in R2 | short public cache with stale-while-revalidate |
| `/v1/active-events/{STATE}.json` | allowlisted per-state snapshot in R2 | short public cache with stale-while-revalidate |
| `/v1/history` | bounded R2 history listing | short public cache with stale-while-revalidate |
| `/v1/history/{timestamp}` | immutable history snapshot in R2 | one-year immutable public cache |
| `/v1/geo` | Cloudflare request metadata | `private, no-store` |

`/v1/geo` is IP-derived and can include ZIP/state/lat/lon, so it is intentionally never shared-cacheable.

## Client Configuration

The browser-facing app currently consumes one public environment variable:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_MAP_STYLE_URL` | Optional MapLibre style URL override |

Alert and history endpoints are same-origin Worker routes. Radar tile URLs are code-owned in `src/lib/radar.ts`.

## Cost Summary

| Component | Service | Cost profile |
|---|---|---|
| Static app and Worker | Cloudflare Workers + static assets | free/low usage tier |
| Object storage | Cloudflare R2 | free/low usage tier |
| Ingestion service | Fly.io | small shared CPU machine |
| Database | Neon Postgres + PostGIS | free to paid as archive grows |
| Map rendering | MapLibre GL JS | open source |
| Radar tiles | Iowa State Mesonet WMS | public service |

## Key Design Decisions

1. Static export plus Worker keeps page delivery simple while preserving a narrow server-side API surface for R2 reads, security headers, and privacy handling.
2. Private R2 avoids exposing raw buckets and makes public data access code-reviewable.
3. Snapshot polling is cheaper and more durable during traffic spikes than per-user server connections.
4. PostGIS stores archival geometry without custom spatial indexing code.
5. MapLibre keeps the map stack open and avoids vendor lock-in.
