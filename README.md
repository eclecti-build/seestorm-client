# SeeStorm — client

Ad-free, real-time severe weather visualization for Great Lakes communities.
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
npm run dev         # http://localhost:3000
npm run verify      # full CI gate — lint + format + typecheck + test + build
```

Deploys run on Cloudflare on every push to `main`. See `CLAUDE.md` for the
full worker + R2 architecture notes.

## Contact

- Bug reports: [sean@eclecti-build.com](mailto:sean@eclecti-build.com)
- Issues: [GitHub tracker](https://github.com/eclecti-build/seestorm-client/issues)

## License

MIT, © 2026 SeeStorm contributors. Built by
[eclecti-build](https://eclecti-build.com) for the Great Lakes.
