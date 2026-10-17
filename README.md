# SeeStorm — client

Ad-free, real-time severe weather visualization for the United States.
Built on National Weather Service data.

Ads and paywalls on data that can protect the public. That's what SeeStorm
replaces — and that's the whole reason it exists.

## What this repo is

The public-facing web app. Serves the radar/alerts view on Cloudflare
Workers + static assets. Backend ingestion lives in
[eclecti-build/seestorm-ingest](https://github.com/eclecti-build/seestorm-ingest);
cross-cutting docs live in the
[umbrella repo](https://github.com/eclecti-build/seestorm).

## Dev

```bash
npm install
npm run dev         # http://localhost:6006
npm run verify      # full CI gate — lint + format + typecheck + test + build
```

Deploys run on Cloudflare on every push to `main`. See `CLAUDE.md` for the
full worker + R2 architecture notes.

## Hosting: Cloudflare Workers + R2

The site is a Next.js static export served by a single Cloudflare Worker
(`worker/index.ts`, configured in `wrangler.jsonc`). The Worker also answers
`/v1/*` by reading JSON snapshots from a private R2 bucket that the
[ingest service](https://github.com/eclecti-build/seestorm-ingest) writes to.
There is no server and no database connection anywhere in this repo.

We chose Cloudflare because R2 has no egress fees (a storm-day traffic spike
costs nothing extra), the bucket attaches to the Worker as a binding instead
of a credential, edge caching collapses thousands of simultaneous viewers into
one R2 read, and Git integration gives us deploys on merge plus preview URLs
on every PR. The longer rationale for every service in the stack is in the
umbrella repo's
[ARCHITECTURE.md](https://github.com/eclecti-build/seestorm/blob/main/docs/ARCHITECTURE.md#hosting).

## Self-hosting

You need a Cloudflare account (free tier is enough), an R2 bucket, and an
ingest instance that publishes snapshots into that bucket (see the ingest
README's
[Self-hosting](https://github.com/eclecti-build/seestorm-ingest/blob/main/README.md#self-hosting)
section). The client reads `/v1/*` from its own origin, so it must be deployed
alongside a bucket that your ingest fills.

```bash
npx wrangler login
npx wrangler r2 bucket create seestorm-data   # or edit bucket_name in wrangler.jsonc
npm ci
npm run build:data && npm run build            # generates public/data + public/geo, then out/
npm run deploy                                 # wrangler deploy
```

Then give your ingest an R2 API token with write access to the bucket and set
its `R2_*` variables. Cloudflare docs:
[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/),
[R2](https://developers.cloudflare.com/r2/),
[R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/).

## Contact

- Bug reports: [sean@eclecti-build.com](mailto:sean@eclecti-build.com)
- Issues: [GitHub tracker](https://github.com/eclecti-build/seestorm-client/issues)

## License

MIT, © 2026 SeeStorm contributors. Built by
[eclecti-build](https://eclecti-build.com) for the United States.
