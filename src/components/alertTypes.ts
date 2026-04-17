// Shared alert shape used by WeatherMap (map rendering) and ActiveAlertsPanel
// (list rendering). Mirrors the ingest snapshot contract — see
// `seestorm-ingest/internal/publisher.Snapshot`. Kept here so the panel can
// accept the raw ingest alert (including zone-aggregate products with
// `geometry: null`) without forcing a translation through the map-internal
// polygon-only shape.
import type { StormMotion } from '@/lib/stormMotion';

export interface ActiveAlert {
  nws_id: string;
  event_type: string;
  severity: string;
  headline: string;
  description: string;
  area_desc: string;
  geometry: GeoJSON.Geometry | null;
  effective_at: string;
  expires_at: string;
  storm_motion?: StormMotion | null;
}
