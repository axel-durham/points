#!/usr/bin/env node
/**
 * refresh.mjs — pull United MileagePlus SAVER award availability between SFO
 * and each configured destination (BOTH directions, so the site can pair
 * outbound + return into roundtrips) from the seats.aero Partner API and
 * write data/deals.json + data/meta.json.
 *
 * Usage:
 *   node scripts/refresh.mjs              # daily mode: two /search per destination
 *   node scripts/refresh.mjs --dry-run    # hit the API but write nothing
 *   node scripts/refresh.mjs --discover   # regenerate config/destinations.json
 *                                         # from the bulk endpoint (~54+ calls,
 *                                         # never part of the default path)
 *
 * Strategy (verified against the live API):
 *  - Open-destination /search silently returns no data, so the daily mode
 *    loops over the known destination list in config/destinations.json and
 *    issues two /search calls per destination — SFO→X and X→SFO — (~110-120
 *    quota calls of the 1000/day). Rows keep their true from/to, so return
 *    legs appear as from: X, to: "SFO"; city/region enrichment is keyed off
 *    the non-SFO end either way.
 *  - The `cabins` request param takes the WORDS economy,premium,business,first;
 *    Y/W/J/F is only the response-field convention.
 *  - Saver-only: we read the non-Raw fields (JAvailable/JMileageCost, ...).
 *    The parallel *Raw fields include dynamically priced space (e.g. a 360k
 *    business seat) and are deliberately ignored.
 *  - The API sends no city names; city/region are enriched from the config.
 *
 * Requirements: Node 20+ (native fetch), zero npm dependencies.
 * Auth: SEATS_AERO_API_KEY env var, or a gitignored .env.local at repo root.
 * The key is sent only as a request header — never logged, never written out.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_BASE = "https://seats.aero/partnerapi";
const USER_AGENT = "points-axeldurham/1.0"; // default UAs can get a 403
const ORIGIN = "SFO";
const SOURCE = "united";
const WINDOW_DAYS = 180;
const PAGE_SIZE = 1000;
const RATE_LIMIT_FLOOR = 50; // abort cleanly if remaining quota drops below this
const CABIN_CODES = ["Y", "W", "J", "F"]; // response-field convention
const CABINS_PARAM = "economy,premium,business,first"; // request-param convention
const EXCLUDED_REGION = "North America"; // domestic/near-international is out of scope
// seats.aero labels Central American airports "South America" (observed live:
// BZE and LIR). Correct that everywhere — daily enrichment AND --discover —
// so the region can't silently revert when the config file is regenerated.
// "Central America" is not the EXCLUDED_REGION, so these stay in scope.
const REGION_OVERRIDES = {
  BZE: "Central America", // Belize City
  LIR: "Central America", // Liberia, Costa Rica
  SJO: "Central America", // San José, Costa Rica
  GUA: "Central America", // Guatemala City
  SAL: "Central America", // San Salvador
  PTY: "Central America", // Panama City
};
const DISCOVER_REGIONS = [
  "Europe",
  "Asia",
  "Oceania",
  "South America",
  "Africa",
  "Middle East",
];
const DISCOVER_PAGE_CAP = 25; // hard per-region page cap in --discover mode
const INTER_REQUEST_DELAY_MS = 300; // politeness delay between destinations

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(REPO_ROOT, "data");
const DEALS_PATH = join(DATA_DIR, "deals.json");
const META_PATH = join(DATA_DIR, "meta.json");
const DESTINATIONS_PATH = join(REPO_ROOT, "config", "destinations.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const DISCOVER = args.includes("--discover");

// ---------------------------------------------------------------------------
// API key resolution (env var, then gitignored .env.local at repo root)
// ---------------------------------------------------------------------------

function resolveApiKey() {
  if (process.env.SEATS_AERO_API_KEY) return process.env.SEATS_AERO_API_KEY.trim();

  const envLocal = join(REPO_ROOT, ".env.local");
  if (existsSync(envLocal)) {
    for (const line of readFileSync(envLocal, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?SEATS_AERO_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

const API_KEY = resolveApiKey();
if (!API_KEY) {
  console.error(
    "ERROR: No seats.aero API key found.\n" +
      "Set the SEATS_AERO_API_KEY environment variable, or create a .env.local\n" +
      "file at the repo root containing a line like:\n\n" +
      "  SEATS_AERO_API_KEY=your_partner_api_key_here\n\n" +
      "(.env.local is gitignored and must never be committed.)"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

const today = new Date();
const windowStart = isoDate(today);
const windowEnd = isoDate(new Date(today.getTime() + WINDOW_DAYS * 86400 * 1000));

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let lastRateLimitRemaining = null;

/**
 * GET a Partner API path with query params. Throws on any non-2xx so a lapsed
 * subscription fails CI red rather than leaving silently stale data. Tracks
 * the rate-limit header (the live API sends lowercase `x-ratelimit-remaining`;
 * the Headers API matches names case-insensitively).
 */
async function apiGet(path, params) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      "Partner-Authorization": API_KEY,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  const remainingHeader = res.headers.get("x-ratelimit-remaining");
  if (remainingHeader !== null) {
    const remaining = Number(remainingHeader);
    if (Number.isFinite(remaining)) {
      lastRateLimitRemaining = remaining;
      if (remaining < RATE_LIMIT_FLOOR) {
        throw new Error(
          `Rate limit nearly exhausted (${remaining} calls remaining, floor is ${RATE_LIMIT_FLOOR}). Aborting cleanly.`
        );
      }
    }
  }

  if (!res.ok) {
    // Never echo request headers here — they contain the API key.
    const body = await res.text().catch(() => "");
    throw new Error(
      `API request failed: ${res.status} ${res.statusText} for ${url.pathname}${url.search}\n${body.slice(0, 500)}`
    );
  }

  return res.json();
}

/**
 * Fetch every page of a paginated endpoint. The live API returns
 * { data: [...], hasMore: <bool>, cursor: <integer> }; the cursor is passed
 * back as a query param. Each HTTP request costs one quota call.
 */
async function apiGetAllPages(path, params, { pageCap = Infinity } = {}) {
  const all = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const body = await apiGet(path, cursor === undefined ? params : { ...params, cursor });
    pages += 1;
    const data = Array.isArray(body?.data) ? body.data : [];
    all.push(...data);
    // cursor can legitimately be 0 (it is an integer), so drive the loop off
    // hasMore, and only stop early on a missing cursor or an empty page.
    if (!body?.hasMore || body.cursor === undefined || body.cursor === null) break;
    if (data.length === 0) break; // safety: never loop on empty pages
    if (pages >= pageCap) {
      console.log(`  page cap (${pageCap}) reached for ${path}; stopping early.`);
      break;
    }
    cursor = body.cursor;
  }
  return { records: all, pages };
}

// ---------------------------------------------------------------------------
// Destination config (owned elsewhere — read by daily mode, rewritten only by
// --discover)
// ---------------------------------------------------------------------------

function loadDestinationsFile() {
  try {
    return JSON.parse(readFileSync(DESTINATIONS_PATH, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

/**
 * normalizeRecord — the ONLY place raw seats.aero field names appear.
 *
 * Verified live: records are PascalCase — ID, Route{OriginAirport,
 * DestinationAirport, DestinationRegion, Distance}, Date, YAvailable,
 * YMileageCost (a STRING, e.g. "55000"), YRemainingSeats, YAirlines, YDirect,
 * UpdatedAt, plus W/J/F variants.
 *
 * SAVER-ONLY: records also carry parallel *Raw fields (YAvailableRaw,
 * JMileageCostRaw, ...) that include dynamically priced space — e.g.
 * JAvailable=false / JMileageCost="0" alongside JAvailableRaw=true /
 * JMileageCostRaw=360000. A 360k-mile business seat is not a deal. This
 * function reads only the non-Raw (saver) fields and must never fall back to
 * the Raw ones; `pick()` uses exact key names, so *Raw never matches.
 *
 * Defensive by design:
 *  - `pick()` tolerates alternate casings should the API ever change;
 *  - mileage costs arrive as strings — coerced via Number();
 *  - airlines may be a comma-separated string or an array;
 *  - any missing field degrades to null/false/0 rather than throwing.
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;

  const pick = (obj, ...names) => {
    if (!obj || typeof obj !== "object") return undefined;
    for (const n of names) {
      if (obj[n] !== undefined && obj[n] !== null) return obj[n];
    }
    return undefined;
  };

  const route = pick(raw, "Route", "route") ?? {};

  const toNumber = (v) => {
    if (v === undefined || v === null || v === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // 0 from the API means "count not reported", not "no seats" — see the
  // comment at the seats field below. null makes that explicit downstream.
  const seatsOrNull = (n) => (n > 0 ? n : null);

  const toAirlines = (v) => {
    if (Array.isArray(v)) return v.map((a) => String(a).trim()).filter(Boolean);
    if (typeof v === "string") return v.split(",").map((a) => a.trim()).filter(Boolean);
    return [];
  };

  const cabins = {};
  for (const c of CABIN_CODES) {
    cabins[c] = {
      available: Boolean(pick(raw, `${c}Available`, `${c.toLowerCase()}Available`)),
      miles: toNumber(pick(raw, `${c}MileageCost`, `${c.toLowerCase()}MileageCost`)),
      // A remaining-seat count of 0 does NOT mean "no seats". The API returns
      // RemainingSeats: 0 on records it simultaneously reports as Available,
      // and the same flight/date/price flips between 0 and 7 across refreshes
      // (verified against SFO-MUC business, 2026-08-16/18/19). Zero therefore
      // means "the source did not report a count" — roughly 18% of rows. Emit
      // null so the distinction is explicit in the data and consumers cannot
      // mistake it for zero availability.
      seats: seatsOrNull(
        toNumber(pick(raw, `${c}RemainingSeats`, `${c.toLowerCase()}RemainingSeats`))
      ),
      airlines: toAirlines(pick(raw, `${c}Airlines`, `${c.toLowerCase()}Airlines`)),
      direct: Boolean(pick(raw, `${c}Direct`, `${c.toLowerCase()}Direct`)),
    };
  }

  return {
    recordId: String(pick(raw, "ID", "Id", "id") ?? ""),
    origin: pick(route, "OriginAirport", "originAirport", "origin_airport") ?? null,
    destination:
      pick(route, "DestinationAirport", "destinationAirport", "destination_airport") ?? null,
    // The API sends no city name; city is enriched from config/destinations.json.
    region:
      pick(route, "DestinationRegion", "destinationRegion", "destination_region") ?? null,
    distance: toNumber(pick(route, "Distance", "distance")),
    date: pick(raw, "Date", "date") ?? null,
    source: pick(raw, "Source", "source") ?? null,
    updatedAt: pick(raw, "UpdatedAt", "updatedAt", "updated_at") ?? null,
    cabins,
  };
}

// ---------------------------------------------------------------------------
// Row expansion: one row per available (saver) cabin
// ---------------------------------------------------------------------------

/**
 * destMap: Map<airportCode, {city, region}> from config/destinations.json.
 * City always comes from the config (the API has none); region prefers the
 * config and falls back to the API's Route.DestinationRegion.
 *
 * Rows flow in from BOTH directions (SFO→X outbound, X→SFO return). Exactly
 * one endpoint must be SFO; enrichment (city, region, the region exclusion)
 * is keyed off the OTHER endpoint — the place — since "the region of SFO"
 * would wrongly exclude every return leg as North America.
 */
function expandCabins(normalized, destMap) {
  const rows = [];
  const nowIso = new Date().toISOString();
  for (const rec of normalized) {
    if (!rec) continue;
    const isOutbound = rec.origin === ORIGIN;
    const isReturn = rec.destination === ORIGIN;
    if (isOutbound === isReturn) continue; // exactly one end must be SFO
    if (!rec.date || !rec.destination || !rec.origin || !rec.recordId) continue;

    const place = isOutbound ? rec.destination : rec.origin;
    const dest = destMap.get(place);
    // The API's DestinationRegion describes rec.destination, which for a
    // return leg is SFO — only trust it on outbound rows.
    const region = dest?.region ?? (isOutbound ? rec.region : null);
    if (!region || region === EXCLUDED_REGION) continue;

    for (const cabin of CABIN_CODES) {
      const c = rec.cabins[cabin];
      if (!c.available) continue; // saver flag falsy → skip (Raw-only space ignored)
      if (!c.miles) continue; // mileage cost 0/missing → skip

      rows.push({
        id: `${rec.recordId}-${cabin}`,
        date: String(rec.date).slice(0, 10),
        from: rec.origin,
        to: rec.destination,
        // city/region describe the PLACE (the non-SFO end), for outbound and
        // return rows alike — the front end groups both under one destination.
        city: dest?.city ?? null,
        region,
        cabin,
        miles: c.miles,
        direct: c.direct,
        seats: c.seats,
        airlines: c.airlines,
        firstSeen: null, // filled in by applyFirstSeen()
        updated: rec.updatedAt ?? nowIso,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// firstSeen: carry forward from the existing data/deals.json
// ---------------------------------------------------------------------------

const seenKey = (row) => `${row.from}|${row.to}|${row.date}|${row.cabin}`;

/**
 * Powers the "newly opened space" view. A row that existed in the previous
 * data file keeps its ORIGINAL firstSeen date; only genuinely new
 * from|to|date|cabin combinations are stamped with today's date. Re-stamping
 * everything each run would silently break that feature.
 */
function applyFirstSeen(rows, previousRows) {
  const previousFirstSeen = new Map();
  for (const prev of previousRows) {
    const key = seenKey(prev);
    // Keep the earliest firstSeen if duplicates somehow exist.
    if (prev.firstSeen && (!previousFirstSeen.has(key) || prev.firstSeen < previousFirstSeen.get(key))) {
      previousFirstSeen.set(key, prev.firstSeen);
    }
  }
  const todayStr = isoDate(new Date());
  for (const row of rows) {
    row.firstSeen = previousFirstSeen.get(seenKey(row)) ?? todayStr;
  }
}

function loadPreviousRows() {
  try {
    const parsed = JSON.parse(readFileSync(DEALS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // first run, or unreadable file — start fresh
  }
}

// ---------------------------------------------------------------------------
// Daily mode: one /search per configured destination
// ---------------------------------------------------------------------------

async function runDaily() {
  const config = loadDestinationsFile();
  const destinations = Array.isArray(config?.destinations) ? config.destinations : [];
  if (destinations.length === 0) {
    throw new Error(
      `No destinations found in ${DESTINATIONS_PATH}. Run \`node scripts/refresh.mjs --discover\` first.`
    );
  }

  const destMap = new Map(
    destinations
      .filter((d) => d && d.code)
      .map((d) => [
        d.code,
        { city: d.city ?? null, region: REGION_OVERRIDES[d.code] ?? d.region ?? null },
      ])
  );

  console.log(
    `Querying ${destMap.size} destinations, both directions (~2 quota calls each)...`
  );

  const rawRecords = [];
  let done = 0;
  for (const code of destMap.keys()) {
    // Outbound (SFO→X) and return (X→SFO): the site pairs them into roundtrips.
    let outCount = 0;
    let retCount = 0;
    for (const [origin, destination] of [[ORIGIN, code], [code, ORIGIN]]) {
      const { records } = await apiGetAllPages("/search", {
        origin_airport: origin,
        destination_airport: destination, // required in practice: open search returns empty
        start_date: windowStart,
        end_date: windowEnd,
        cabins: CABINS_PARAM, // words, not Y/W/J/F — the API rejects codes here
        sources: SOURCE,
        take: PAGE_SIZE,
        order_by: "lowest_mileage",
      });
      rawRecords.push(...records);
      if (origin === ORIGIN) outCount = records.length;
      else retCount = records.length;
      await sleep(INTER_REQUEST_DELAY_MS);
    }
    done += 1;
    // Compact progress: one short line per destination.
    console.log(
      `  [${String(done).padStart(2)}/${destMap.size}] ${code}: ${outCount} out / ${retCount} ret` +
        ` | quota left: ${lastRateLimitRemaining ?? "?"}`
    );
  }

  console.log(`Fetched ${rawRecords.length} raw records total.`);

  const rows = expandCabins(rawRecords.map(normalizeRecord), destMap);
  const previousRows = loadPreviousRows();
  applyFirstSeen(rows, previousRows);
  rows.sort((a, b) => a.miles - b.miles);

  const prevKeys = new Set(previousRows.map(seenKey));
  const newKeys = new Set(rows.map(seenKey));
  const added = [...newKeys].filter((k) => !prevKeys.has(k)).length;
  const removed = [...prevKeys].filter((k) => !newKeys.has(k)).length;

  const outboundRows = rows.filter((r) => r.from === ORIGIN).length;
  const meta = {
    refreshedAt: new Date().toISOString(),
    rowCount: rows.length,
    outboundRows,
    returnRows: rows.length - outboundRows,
    addedSinceLastRun: added,
    removedSinceLastRun: removed,
    rateLimitRemaining: lastRateLimitRemaining,
    origin: ORIGIN,
    source: SOURCE,
    windowStart,
    windowEnd,
  };

  console.log(`Rows: ${rows.length} (added ${added}, removed ${removed} vs previous run).`);

  if (DRY_RUN) {
    console.log("Dry run — nothing written. Summary:");
    console.log(JSON.stringify(meta, null, 2));
    const byCabin = {};
    for (const r of rows) byCabin[r.cabin] = (byCabin[r.cabin] || 0) + 1;
    console.log(`Rows by cabin: ${JSON.stringify(byCabin)}`);
    if (rows.length) {
      const cheapest = rows[0];
      console.log(
        `Cheapest: ${cheapest.from}→${cheapest.to} ${cheapest.cabin} on ${cheapest.date} for ${cheapest.miles} miles`
      );
    }
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DEALS_PATH, JSON.stringify(rows, null, 2) + "\n");
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + "\n");
  console.log(`Wrote ${DEALS_PATH} and ${META_PATH}.`);
}

// ---------------------------------------------------------------------------
// Discover mode: regenerate config/destinations.json from the bulk endpoint
// ---------------------------------------------------------------------------

/**
 * Loops the bulk availability endpoint per destination region (using the
 * undocumented-but-verified origin_airport filter), collecting distinct
 * destination airports. Costs ~54+ quota calls, so it must NEVER run as part
 * of the default daily path — only via the explicit --discover flag.
 *
 * When rewriting the file, hand-written `city` values from the existing file
 * are preserved; newly discovered codes get city: null (to be filled in by
 * hand). The existing _comment field is preserved too.
 */
async function runDiscover() {
  const existing = loadDestinationsFile();
  const existingCities = new Map(
    (Array.isArray(existing?.destinations) ? existing.destinations : [])
      .filter((d) => d && d.code)
      .map((d) => [d.code, d.city ?? null])
  );

  const found = new Map(); // code -> { region, distance }

  for (const region of DISCOVER_REGIONS) {
    console.log(`Discovering region "${region}"...`);
    const { records, pages } = await apiGetAllPages(
      "/availability",
      {
        source: SOURCE,
        origin_airport: ORIGIN, // undocumented but verified to work
        destination_region: region,
        start_date: windowStart,
        end_date: windowEnd,
        take: PAGE_SIZE,
      },
      { pageCap: DISCOVER_PAGE_CAP }
    );
    let newCodes = 0;
    for (const raw of records) {
      const rec = normalizeRecord(raw);
      if (!rec || rec.origin !== ORIGIN || !rec.destination) continue;
      if (!rec.region || rec.region === EXCLUDED_REGION) continue;
      if (!found.has(rec.destination)) {
        found.set(rec.destination, { region: rec.region, distance: rec.distance || null });
        newCodes += 1;
      }
    }
    console.log(
      `  ${records.length} recs over ${pages} page(s), ${newCodes} new airports | quota left: ${lastRateLimitRemaining ?? "?"}`
    );
    await sleep(INTER_REQUEST_DELAY_MS);
  }

  const destinations = [...found.entries()]
    .map(([code, info]) => ({
      code,
      city: existingCities.get(code) ?? null, // preserve hand-written names
      region: REGION_OVERRIDES[code] ?? info.region,
      distance: info.distance,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const output = {
    _comment:
      existing?._comment ??
      "International destinations served from SFO with United award inventory. Regenerate with: node scripts/refresh.mjs --discover",
    _discoveredAt: isoDate(new Date()),
    origin: ORIGIN,
    destinations,
  };

  const withCity = destinations.filter((d) => d.city).length;
  console.log(
    `Discovered ${destinations.length} destinations (${withCity} with city names carried over, ` +
      `${destinations.length - withCity} needing a city).`
  );

  if (DRY_RUN) {
    console.log("Dry run — config/destinations.json not written.");
    return;
  }

  writeFileSync(DESTINATIONS_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${DESTINATIONS_PATH}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `seats.aero refresh — origin ${ORIGIN}, source ${SOURCE}, window ${windowStart} → ${windowEnd}` +
      `${DISCOVER ? " [discover mode]" : ""}${DRY_RUN ? " [dry run]" : ""}`
  );
  if (DISCOVER) {
    await runDiscover();
  } else {
    await runDaily();
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
