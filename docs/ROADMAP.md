# SeeStorm Roadmap

## Phase 1 — MVP (Current)

The minimum viable product: a live weather map for the Great Lakes that anyone can open on their phone during severe weather.

- [x] Next.js frontend with MapLibre GL JS
- [x] NWS active alert polygon rendering (color-coded by event type)
- [x] NEXRAD radar overlay via Iowa Mesonet WMS
- [x] Browser geolocation for community snap
- [x] Alert detail panel (click polygon to see headline, description, expiry)
- [x] 30-second auto-refresh
- [x] Go ingestion service with NWS + SPC clients
- [x] PostGIS schema with spatial indexes
- [x] JSON snapshot publisher
- [x] Dark theme, mobile-friendly layout
- [ ] Deploy frontend to Cloudflare Pages
- [ ] Provision Neon database with PostGIS
- [ ] Deploy ingest service to Fly.io
- [ ] Wire frontend to CDN-cached snapshot (replace direct NWS polling)

## Phase 2 — Storm Reports and History

Add storm reports layer and begin building the permanent archive.

- [ ] Storm reports rendering (tornado touchdowns, hail, wind damage as markers)
- [ ] Report detail popups (magnitude, time, comments)
- [ ] SPC convective outlook overlay (Day 1-3 risk areas)
- [ ] Historical event browser (date picker → view past events on map)
- [ ] Load SPC SVRGIS historical tornado tracks (1950–present) for Wisconsin
- [ ] Tornado path linestrings with EF-scale color coding
- [ ] Archive page showing Wisconsin tornado statistics by year/county

## Phase 3 — Real-Time Experience

Make the live experience feel immediate and responsive.

- [ ] Temporal playback — scrub through a storm event timeline
- [ ] Storm animation (warning polygon appearance/expiry over time)
- [ ] Push notifications (browser Notification API for new tornado warnings in user's area)
- [ ] Audible alert tone option for tornado warnings
- [ ] Radar animation (loop last 30-60 minutes of radar frames)
- [ ] MRMS rotation track overlay (mesocyclone detection)
- [ ] Spotter Network reports integration (crowd-sourced live reports)

## Phase 4 — Community Features

Help communities understand and respond to severe weather.

- [ ] Community boundaries overlay (city/town/county lines)
- [ ] "My Area" saved locations with personalized alert filtering
- [ ] County-level event summary page ("What happened in Dane County today?")
- [ ] Event impact reports (power outages, road closures — manual community input)
- [ ] Embeddable widget (iframe map for local news sites, community boards)
- [ ] Shareable event snapshots (link to a specific storm event at a point in time)

## Phase 5 — Data and Analysis

Turn the archive into insight.

- [ ] Historical tornado density heatmap for Wisconsin
- [ ] County-level risk scoring based on historical data
- [ ] Tornado alley shift visualization (decade-over-decade path comparison)
- [ ] Severe weather season summary reports (auto-generated)
- [ ] Data export API (GeoJSON/CSV download of historical events)
- [ ] Integration with NCEI Storm Events Database for damage estimates and narratives

## Phase 6 — Scale and Sustainability

Grow beyond Wisconsin and ensure long-term viability.

- [ ] Multi-state support (configurable NWS_AREA, expand to neighboring states)
- [ ] Protomaps self-hosted tiles on R2 (eliminate Stadia Maps dependency)
- [ ] R2 snapshot publishing (replace local file publisher)
- [ ] CDN-first architecture validation (load test with simulated tornado outbreak traffic)
- [ ] Non-profit formation (501(c)(3) for seestorm.org)
- [ ] Community fundraising page
- [ ] Volunteer contributor onboarding docs
- [ ] Accessibility audit (WCAG 2.1 AA for emergency information)
- [ ] Localization (Hmong, Spanish — Wisconsin's major non-English communities)

## Infrastructure Milestones

| Milestone | Trigger | Action |
|-----------|---------|--------|
| Neon free tier full (0.5GB) | ~6-12 months of archival | Upgrade to Launch plan ($19/mo) |
| Stadia Maps rate limited | High traffic event | Switch to Protomaps on R2 |
| Snapshot too large for single JSON | 500+ active alerts | Split by event type or region |
| Need sub-5s push delivery | Community demand | Add Cloudflare Durable Objects or Ably pub/sub |
| Multi-state expansion | User demand outside WI | Parameterize ingestion by region, add regional snapshot files |

## Non-Goals

Things we intentionally do not plan to build:

- **Native mobile apps** — the web app is mobile-first and works from the home screen via PWA. Native apps add maintenance burden without clear benefit for a non-profit.
- **Forecast models** — we visualize NWS data, we don't compete with NWS forecasting. No custom weather models.
- **Social features** — no accounts, no comments, no social feed. This is an information tool, not a platform.
- **Monetization** — no ads, no premium tier, no data sales. Operating costs are owned by the non-profit.
