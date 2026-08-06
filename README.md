# points

A static award-travel site tracking United MileagePlus **saver** award
availability out of SFO. A daily script pulls availability from the
[seats.aero](https://seats.aero) Partner API, commits it as JSON, and GitHub
Pages serves the site — no backend. Live at
[points.axeldurham.com](https://points.axeldurham.com).

## How it works

The refresh script (`scripts/refresh.mjs`, Node 20+, zero dependencies) has two
modes:

- **Daily mode** (default): the seats.aero search endpoint requires a specific
  destination airport, so the script loops over the ~54 international
  destinations in `config/destinations.json`, issuing one search per
  destination for the next 180 days across all four cabins. That costs roughly
  **54-60 API calls of the 1000/day quota**. It writes:
  - `data/deals.json` — one row per available saver cabin, sorted by miles
    ascending. Each row carries a `firstSeen` date so the site can highlight
    newly opened space. City and region come from the config file (the API
    sends no city names).
  - `data/meta.json` — refresh timestamp, row/added/removed counts, and
    remaining API quota.
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

`config/baselines.json` holds the per-region, per-cabin mileage baselines the
UI uses to decide what counts as a "deal" (e.g. business to Asia below 88k is
worth flagging). Edit the numbers there to make the deal filter stricter or
looser — no code changes needed; the front end reads it at load time.
