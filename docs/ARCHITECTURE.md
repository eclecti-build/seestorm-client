# SeeStorm Architecture

## Overview

SeeStorm is an ad-free, non-profit severe weather visualization platform for Great Lakes communities. It provides real-time tornado warnings, storm paths, and radar overlays using public NWS data.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        DATA SOURCES                             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │  NWS API     │  │  SPC Storm   │  │  Iowa Mesonet      │    │
│  │  Alerts      │  │  Reports/    │  │  NEXRAD WMS        │    │
│  │  (GeoJSON)   │  │  Outlooks    │  │  Radar Tiles       │    │
│  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘    │
│         │                 │                    │                │
└─────────┼─────────────────┼────────────────────┼────────────────┘
          │                 │                    │
          ▼                 ▼                    │
┌─────────────────────────────────────┐          │
│     INGESTION (seestorm-ingest)     │          │
│                                     │          │
│  Go binary on Fly.io (~$3/mo)       │          │
│  Polls NWS every 30-60s             │          │
│  Deduplicates by NWS event ID       │          │
│                                     │          │
│  ┌───────────┐   ┌──────────────┐   │          │
│  │  Write to  │   │  Publish     │   │          │
│  │  PostGIS   │   │  JSON to R2  │   │          │
│  └─────┬─────┘   └──────┬───────┘   │          │
└────────┼────────────────┼────────────┘          │
         │                │                       │
         ▼                ▼                       │
┌────────────────┐  ┌────────────────┐            │
│  Neon Postgres │  │  Cloudflare R2 │            │
│  + PostGIS     │  │  (CDN-cached   │            │
│  (archival)    │  │   JSON + tiles)│            │
│                │  │                │            │
│  Free → $19/mo │  │  Free tier     │            │
└────────────────┘  └───────┬────────┘            │
                            │                     │
                    ┌───────▼─────────────────────▼──┐
                    │       CLOUDFLARE CDN            │
                    │  (edge-cached, 10s TTL)         │
                    │  Unlimited bandwidth, $0        │
                    └───────────────┬─────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │    FRONTEND (seestorm)           │
                    │                                  │
                    │  Next.js static export           │
                    │  Cloudflare Pages ($0)           │
                    │                                  │
                    │  ┌────────────────────────────┐  │
                    │  │  MapLibre GL JS            │  │
                    │  │  ├─ Warning polygons       │  │
                    │  │  ├─ Radar overlay (WMS)    │  │
                    │  │  ├─ Storm report markers   │  │
                    │  │  └─ Tornado path lines     │  │
                    │  └────────────────────────────┘  │
                    │                                  │
                    │  ┌────────────────────────────┐  │
                    │  │  Protomaps tiles from R2   │  │
                    │  │  (base map, $0)            │  │
                    │  └────────────────────────────┘  │
                    └──────────────────────────────────┘
```

## Cost Summary

| Component | Service | Cost |
|-----------|---------|------|
| Frontend hosting | Cloudflare Pages | $0 |
| Map library | MapLibre GL JS | $0 |
| Base map tiles | Protomaps on R2 | $0 |
| Radar tiles | Iowa State Mesonet WMS | $0 |
| Ingestion service | Fly.io (shared-cpu, 256MB) | ~$3/mo |
| Database | Neon Postgres + PostGIS | $0 → $19/mo |
| Object storage | Cloudflare R2 | $0 (free tier) |
| CDN | Cloudflare | $0 |
| **Total** | | **$3–10/mo** |

## Data Sources

| Source | Endpoint | Format | Update Freq |
|--------|----------|--------|-------------|
| NWS Active Alerts | `api.weather.gov/alerts/active?area=WI` | GeoJSON | 30-60s |
| SPC Storm Reports | `spc.noaa.gov/climo/reports/today_torn.csv` | CSV | Continuous |
| SPC Outlooks | `spc.noaa.gov/products/outlook/` | GeoJSON/KMZ | 4-8x daily |
| NEXRAD Radar | Iowa Mesonet WMS (`mesonet.agron.iastate.edu`) | WMS tiles | ~5 min |
| Historical Tornados | SPC SVRGIS shapefiles (1950–present) | Shapefile | Annual |
| Spotter Network | `spotternetwork.org/feeds/reports.txt` | CSV | Real-time |

## Repos

- **seestorm** (this repo) — Next.js frontend, MapLibre visualization
- **seestorm-ingest** — Go ingestion service, NWS polling, PostGIS archival

## Key Design Decisions

1. **Static export + CDN polling** over SSR/WebSockets — tornado outbreaks drive 100x traffic spikes. Static files + CDN-cached JSON means user traffic never hits our infrastructure.

2. **MapLibre over Mapbox** — identical API, zero licensing cost, BSD licensed.

3. **Protomaps on R2 over hosted tile services** — no egress fees means tile serving is free regardless of traffic.

4. **PostGIS for archival** — native GeoJSON support, spatial indexing, polygon intersection queries for "is this user inside a warning area?"

5. **Go for ingestion** — low memory footprint (~20MB), single binary deployment, excellent HTTP client stdlib.
