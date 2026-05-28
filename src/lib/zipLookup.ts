// ZIP-to-coordinates lookup against a bundled JSON table covering all US
// states, DC, and territories.
//
// The JSON is fetched lazily so it isn't pulled into the initial JS bundle
// — it only ships down the wire when a user actually types a ZIP into the
// LocationChip. Subsequent lookups hit the in-memory promise cache.

export interface ZipRecord {
  lat: number;
  lon: number;
  state: string;
  county: string;
}

type ZipTable = Record<string, ZipRecord>;

let tablePromise: Promise<ZipTable> | null = null;

function isZipRecord(v: unknown): v is ZipRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.lat === 'number' &&
    typeof r.lon === 'number' &&
    typeof r.state === 'string' &&
    typeof r.county === 'string'
  );
}

async function loadTable(): Promise<ZipTable> {
  if (!tablePromise) {
    const inflight = (async () => {
      // fetch() the static asset rather than a Webpack/Turbopack `import` of
      // the JSON — keeps the file out of the JS bundle entirely (it lives in
      // `public/data/`) and lets the browser/CDN cache it independently.
      const res = await fetch('/data/zip-us.json');
      if (!res.ok) {
        throw new Error(`ZIP table fetch failed: ${res.status}`);
      }
      const raw: unknown = await res.json();
      if (!raw || typeof raw !== 'object') return {};
      // Validate shape lazily — bad entries are filtered out, good ones
      // are kept, so a partial deploy doesn't break the whole lookup.
      const out: ZipTable = {};
      for (const [zip, record] of Object.entries(raw as Record<string, unknown>)) {
        if (isZipRecord(record)) out[zip] = record;
      }
      return out;
    })();
    // If the fetch fails, drop the cached promise so the next call retries
    // instead of returning the same rejection forever. The UI tells the user
    // "Try again in a moment." — that needs to actually be true.
    inflight.catch(() => {
      if (tablePromise === inflight) tablePromise = null;
    });
    tablePromise = inflight;
  }
  return tablePromise;
}

/** Normalize user input to a 5-digit ZIP. Returns null if not parseable. */
export function normalizeZip(input: string): string | null {
  const cleaned = input.trim();
  // Accept "53703", "53703-1234" (take ZIP5), or strings with surrounding whitespace.
  const match = cleaned.match(/^(\d{5})(?:-\d{4})?$/);
  return match ? match[1] : null;
}

/**
 * Look up a ZIP code in the national table.
 * Returns null when the ZIP isn't in the bundled set or is malformed.
 */
export async function lookupZip(zip: string): Promise<ZipRecord | null> {
  const normalized = normalizeZip(zip);
  if (!normalized) return null;
  const table = await loadTable();
  return table[normalized] ?? null;
}
