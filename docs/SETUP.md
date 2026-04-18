# SeeStorm Setup Guide

## Prerequisites

- Node.js 18+
- npm

## Quick Start (MVP mode — no backend needed)

The frontend can run standalone by polling NWS directly from the browser.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000 — you'll see a dark map of the Great Lakes with live NWS warnings and radar.

## Environment Variables

### Frontend (`seestorm`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_EVENTS_API_URL` | No | CDN URL for active-events.json from ingest service. Empty = poll NWS directly |
| `NEXT_PUBLIC_STADIA_API_KEY` | No | Stadia Maps API key for higher tile rate limits. Free at [client.stadiamaps.com](https://client.stadiamaps.com/signup/) |
| `NEXT_PUBLIC_MAP_STYLE_URL` | No | Map tile style URL. Defaults to Stadia dark theme |
| `NEXT_PUBLIC_RADAR_TILE_URL` | No | Radar tile URL template. Defaults to Iowa Mesonet NEXRAD |
| `NEXT_PUBLIC_NWS_AREA` | No | State code for NWS alerts. Defaults to `WI` |
| `NEXT_PUBLIC_NWS_USER_AGENT` | No | User-Agent for NWS API. Include app name + contact |
| `NEXT_PUBLIC_ENABLE_STORM_REPORTS` | No | Enable storm reports layer. Requires ingest service |

### Backend (`seestorm-ingest`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | **Yes** | Neon Postgres connection string |
| `POLL_INTERVAL` | No | Polling frequency (default: `30s`) |
| `SNAPSHOT_DIR` | No | Local snapshot output dir (default: `./snapshots`) |
| `R2_ACCOUNT_ID` | No | Cloudflare R2 account (production only) |
| `R2_ACCESS_KEY_ID` | No | R2 access key (production only) |
| `R2_SECRET_ACCESS_KEY` | No | R2 secret key (production only) |
| `R2_BUCKET_NAME` | No | R2 bucket name (production only) |
| `NWS_USER_AGENT` | No | User-Agent for NWS API |
| `NWS_AREA` | No | Target state (default: `WI`) |

## Setting Up Neon (Database)

1. Sign up at [console.neon.tech](https://console.neon.tech/) (free tier)
2. Create a project named `seestorm`
3. Copy the connection string — it looks like:
   ```
   postgresql://user:pass@ep-something-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. Paste it as `DATABASE_URL` in `seestorm-ingest/.env`
5. The ingest service runs `CREATE EXTENSION postgis` and migrations automatically on startup

## Setting Up Fly.io (Ingestion Service)

1. Install flyctl: `curl -L https://fly.io/install.sh | sh`
2. `cd seestorm-ingest && fly launch` (uses existing `fly.toml`)
3. Set secrets:
   ```bash
   fly secrets set DATABASE_URL="postgresql://..."
   fly secrets set NWS_USER_AGENT="(seestorm.org, contact@seestorm.org)"
   ```
4. Deploy: `fly deploy`

## Setting Up Cloudflare Pages (Frontend)

1. Connect the `seestorm` repo in [Cloudflare Pages dashboard](https://dash.cloudflare.com/)
2. Build settings:
   - Build command: `npm run build`
   - Output directory: `out`
3. Add environment variables in the Pages dashboard (same as `.env.local`)
4. Deploy triggers automatically on push to `main`

## Secrets Management

| Secret | Where it lives | Notes |
|--------|---------------|-------|
| `DATABASE_URL` | Fly.io secrets / `.env` local | Neon connection string with password |
| `R2_*` credentials | Fly.io secrets | Only needed for production snapshot publishing |
| `NEXT_PUBLIC_STADIA_API_KEY` | Cloudflare Pages env / `.env.local` | Optional, for higher tile rate limits |

**Never commit `.env` or `.env.local` files.** Only `.env.example` is committed.
