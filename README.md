# External Procurement Intelligence Dashboard

## Local port

- Development: `http://localhost:3003`
- Production: `npm start` also uses port 3003.

## Install and run

```powershell
npm install
npm run dev
```

## Environment variables

Create `.env.local`:

```env
BARCHART_API_KEY=
VESSELFINDER_API_KEY=
WEATHER_LAT=-23.96
WEATHER_LON=-46.33
```

### Sugar No.11

The first card uses Barchart OnDemand `getQuote` for:
- `SBY00` — Sugar #11 Cash
- `SBH27` — March 2027
- `SBK27` — May 2027

It displays Last, Open, High, Low for each and calculates consecutive spreads from Last prices.

Barchart documents futures quote fields and supports futures symbols; the cash instrument is `SBY00`. See Barchart's API documentation and the public Barchart Sugar #11 page.

If `BARCHART_API_KEY` is empty, the app falls back to Yahoo Finance for a single delayed Sugar #11 quote, but it does not fabricate the three-contract OHLC values.

## Sources

- Barchart Sugar #11: https://www.barchart.com/futures/quotes/SB*0/futures-prices
- Barchart OnDemand Quote API: https://www.barchart.com/ondemand/api/getQuote
- ICE Sugar: https://www.ice.com/agriculture/sugar
- Open-Meteo: https://open-meteo.com/
- VesselFinder AIS: https://www.vesselfinder.com/realtime-ais-data

## Purchase recommendation

`/api/recommend` publishes a procurement proposal next to the headline price. It is
rule-based decision support, not a price forecast: every factor, its reading and its
weight are in `lib/recommend.ts`, so the call can be audited or re-tuned.

Factors: near-contract regression trend, cash-vs-near curve, near-vs-next roll spread,
BRL, Brent, dollar index, Centre-South Brazil rainfall, and breaking-headline count.

Output: action, share to fix now, suggested limit price, regression fair value, three
tranches with triggers, confidence, and a list of factors that failed to resolve.
Missing factors divide by the full weight budget (so a dropped bearish reading pulls
the score toward neutral) and cost 6 confidence points each.

Dependencies worth knowing:

- The cash leg is Yahoo `SB=F`. Stooq's `sb.f` row is a duplicate of the near
  contract, which flattens the curve to 0% and must not be used for it.
- Yahoo calls have a 6s timeout and the response is cached for 3 minutes
  (`X-Rec-Cache: hit|miss`); without both, a stalled upstream held the top card for
  38s.
- Near-contract prices come from `data/contracts.json`, a Stooq daily snapshot, so
  they are delayed. The UI shows the snapshot age and never presents `updatedAt`
  (response time) as evidence of price freshness.

## News ticker cold start

`/api/drivers` fetches 10 RSS queries, and Google throttles bursts, so a cold cache
took 10-40s and the ticker sat empty. The route now mirrors its last good build to
`data/drivers-cache.json` and serves it immediately, then refreshes in the background
(`refreshing: true`). Delete that file to force a cold rebuild.

## Deployment (Render)

`render.yaml` defines a Node web service. Point Render at the GitHub repository and it
will pick up the blueprint, or create the web service manually with:

- Build: `npm ci && npm run build`
- Start: `npm run start`
- `NEXT_PUBLIC_UPLOAD_ENABLED=0`

### Constraints

Document uploads are disabled by default. `/api/upload` persists to `./data`, which is
read-only and ephemeral on serverless and on Render's free plan, so the endpoint
returns `503` and the Files tab shows why. Everything else works: prices come from the
committed snapshot, and the drivers cache regenerates on boot.

To re-enable uploads, attach a persistent disk, mount it at the project directory, and
set `NEXT_PUBLIC_UPLOAD_ENABLED=1`.

`npm run fetch:contracts` needs a real Chrome and Playwright, so it cannot run on
Render. Refresh `data/contracts.json` locally and push it; the app serves the committed
snapshot until you do.
