# SeeStorm Setup Guide

## Prerequisites

- Node.js 22+
- npm

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:6006 to run the static Next.js app locally. In production, the same repository deploys a Cloudflare Worker that serves the Next static export and handles the `/v1/*` API routes.

## Client Environment Variables

The client has one documented public environment variable:

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_MAP_STYLE_URL` | No | Basemap style URL. Leave empty to use the built-in CartoDB Dark Matter style. Set it when testing a self-hosted Protomaps style or another MapLibre-compatible style. |

Alert, history, and geo data are fetched from same-origin Worker routes:

- `/v1/active-events.json`
- `/v1/active-events/{STATE}.json`
- `/v1/history`
- `/v1/history/{timestamp}`
- `/v1/geo`

Do not add browser-exposed API endpoint env vars unless the client code actually consumes them.

## Backend Configuration

The ingest service is configured in the `seestorm-ingest` repo. Common variables there include:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `POLL_INTERVAL` | No | Polling frequency, default `30s` |
| `SNAPSHOT_DIR` | No | Local snapshot output directory |
| `R2_ACCOUNT_ID` | Production | Cloudflare R2 account |
| `R2_ACCESS_KEY_ID` | Production | R2 access key |
| `R2_SECRET_ACCESS_KEY` | Production | R2 secret key |
| `R2_BUCKET_NAME` | Production | R2 bucket name |
| `NWS_USER_AGENT` | No | User-Agent for NWS API requests |
| `NWS_AREA` | No | State code or comma-separated state codes |

## Cloudflare Deployment

Cloudflare builds the static export and deploys the Worker from `wrangler.jsonc`.

- Build command: `npm run build`
- Static asset directory: `out`
- Worker entry point: `worker/index.ts`
- Static asset binding: `ASSETS`
- Private R2 binding: `SNAPSHOTS`

The R2 bucket is private. The Worker is the public read path for `/v1/*`; ingest is the write path through its own credentials.

## Secrets Management

Never commit `.env` or `.env.local` files. Keep R2, database, and Fly credentials in the owning platform's secrets store. Only non-secret client configuration may use `NEXT_PUBLIC_*`.
