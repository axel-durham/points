# points

A static award-travel site tracking United MileagePlus **saver** award
availability between SFO and ~54 international destinations, **both
directions**, so the UI can pair outbound + return dates into bookable
roundtrips. A daily script pulls availability from the
[seats.aero](https://seats.aero) Partner API, commits it as JSON, and GitHub
Pages serves the site — no backend. Live at
[points.axeldurham.com](https://points.axeldurham.com).

## How it works

The refresh script (`scripts/refresh.mjs`, Node 20+, zero dependencies) has two
modes:

- **Daily mode** (default): the seats.aero search endpoint requires specific
  endpoint airports, so the script loops over the ~54 international
  destinations in `config/destinations.json`, issuing two searches per
  destination — SFO→X and X→SFO — for the next 180 days across all four
  cabins. That costs roughly **110-120 API calls of the 1000/day quota**. It
  writes:
  - `data/deals.json` — one row per available saver cabin per direction,
    sorted by miles ascending (return legs have `from: X, to: "SFO"`; city
    and region always describe the non-SFO end). Each row carries a
    `firstSeen` date so the site can highlight newly opened space. City and
    region come from the config file (the API sends no city names), with
    hard-coded overrides for Central American airports that seats.aero
    mislabels as South America.
  - `data/meta.json` — refresh timestamp, row/added/removed counts (split by
    direction), and remaining API quota.
  The front end pairs same-cabin outbound and return dates within the chosen
  trip-length window into roundtrips, priced per person as the sum of the two
  one-way legs (that is how United prices awards; there is no roundtrip
  discount).
- **Discover mode** (`--discover`): regenerates `config/destinations.json` by
  sweeping the bulk availability endpoint per world region and collecting the
  distinct airports United serves from SFO. Hand-written city names in the
  existing file are preserved; new airports get `city: null` until filled in.
  This costs ~54+ additional calls, so it runs weekly, never on the daily path.

**Saver only:** the API exposes both saver-space fields and parallel `*Raw`
fields that include dynamically priced space (a business seat at 360k miles,
for example). The script deliberately reads only the saver fields — dynamic
pricing is never a deal worth surfacing.

`.github/workflows/refresh.yml` runs daily at 00:20 UTC (just after the quota
reset), runs discovery on Monday's schedule, and commits `data/` (plus
`config/destinations.json` after discovery) when anything changed. The front
end (`index.html`, `app.js`, `style.css`) renders the JSON client-side.

## seats.aero dependency

This requires a **seats.aero Pro subscription**, which includes Partner API
access limited to **1000 API calls per day** and licensed for **personal,
non-commercial use only**. If the subscription lapses, the API returns non-2xx
and the workflow fails red rather than serving stale data.

## Running the refresh locally

Requires Node 20+ and no npm installs.

1. Create a `.env.local` file at the repo root (gitignored — never commit it):

   ```
   SEATS_AERO_API_KEY=your_partner_api_key
   ```

   Or export `SEATS_AERO_API_KEY` in your shell.

2. Run:

   ```sh
   node scripts/refresh.mjs --dry-run    # hit the API, print a summary, write nothing
   node scripts/refresh.mjs              # write data/deals.json and data/meta.json
   node scripts/refresh.mjs --discover   # regenerate config/destinations.json (~54+ calls)
   ```

## Setting the GitHub Actions secret

The workflow reads the key from a repo secret:

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository
   secret**.
2. Name: `SEATS_AERO_API_KEY`, value: your seats.aero Partner API key.

The repo is public — the key lives only in the secret and the local
`.env.local`; it is never logged or written to any committed file.

## Tuning baselines

`config/baselines.json` holds the per-region, per-cabin **one-way** mileage
baselines the UI uses to decide what counts as a "deal" (roundtrip deltas
compare against 2× the baseline). They are derived from the observed data as
the median across destinations of each destination's modal price — the median
step keeps one route with many dates (e.g. Air India's 220k business to India)
from dragging a whole region's baseline. Edit the numbers there to make the
deal filter stricter or looser — no code changes needed; the front end reads
it at load time.
