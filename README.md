# AutoHunt — best-price vehicle finder

Finds the cheapest vehicles near you that match your filters, keeps re-checking prices, and always highlights the **top 3 cheapest** that have a **confirmed clean title** and **under 90,000 miles**.

## Run it
Requires Node 18+ (no packages to install).

```bash
# Demo mode (made-up sample listings, to try the app)
npm start

# Live mode (real listings)
MARKETCHECK_API_KEY=your_key npm start
```
Open http://localhost:3000, tap **Use my location** (or type a ZIP), set filters, hit **Find best prices**.

Optional env vars:

| Variable | Default | What it does |
|---|---|---|
| `MARKETCHECK_API_KEY` | – | Turns on live listings |
| `PORT` | 3000 | Server port |
| `REFRESH_MINUTES` | 360 live / 15 demo | How often watched searches re-check |
| `MONTHLY_CALL_LIMIT` | 500 | Stops API calls at your plan's monthly quota |
| `MAX_RADIUS` | 100 | Max search radius (free plan limit is 100 mi) |
| `CACHE_MINUTES` | 10 | Re-uses identical searches instead of spending a call |
| `NTFY_TOPIC` | – | Default alert topic (can also be set in the app) |
| `NTFY_SERVER` | https://ntfy.sh | Use your own ntfy server if you want |

## Where the listings come from
"Searching the whole web" for car prices is done through a listings aggregator, not by crawling sites yourself (most big sites — Facebook Marketplace, Craigslist, CarGurus, Autotrader — block or forbid scraping). AutoHunt uses the **MarketCheck** inventory API, which aggregates dealer websites across the US and Canada plus private-seller and auction listings. Get a key at marketcheck.com.

## Hard rules (enforced twice: in the API query and again on the server)
- Clean title only — listings with salvage/rebuilt **or unknown** title status are excluded.
- Mileage must be known and below 90,000.

## Get your free MarketCheck key
1. Sign up at https://universe.marketcheck.com/sign-up (no card needed).
2. Copy your API key from the dashboard.
3. Set it as `MARKETCHECK_API_KEY` on your server (never commit it to this repo).

Free plan = 500 calls/month, 100-mile radius. AutoHunt budgets for this: watched searches re-check every 6 hours, identical searches are cached for 10 minutes, and calls stop at the monthly limit. The app footer shows calls used this month.

## Price-drop alerts
Alerts are pushed to your phone with **ntfy** (free, no account):
1. Install the **ntfy** app (Play Store / App Store).
2. In AutoHunt → *Price-drop alerts*, tap **New topic**, then **Save**.
3. In ntfy tap **+** and subscribe to that same topic. Tap **Send test alert** to confirm.

You get a notification when, on any watched search:
- a vehicle's price drops (▼ shows how much),
- a vehicle lands under your "Alert me under $" target,
- a new vehicle becomes the cheapest.

Anyone who knows your topic name can read its alerts, so keep the random name.

## Android app (APK)
Every push to `main` that touches the app builds a fresh APK with GitHub Actions and publishes it to the **Latest APK** release:
https://github.com/mrsirwithpizza101/AutoHunt/releases/tag/latest-apk

Install: open that link on your phone → download **AutoHunt.apk** → open it (allow installs from your browser when asked). On first launch, enter your server's https address. The app uses your phone's GPS directly.

You can also rebuild by hand: **Actions → Build Android APK → Run workflow**.

## Features
- Filters: make, model, year range, price range, body, drivetrain, fuel, seller type (dealer / private / auction), radius
- GPS location (browser geolocation) with ZIP fallback; distance + Google Maps directions per listing
- Auto-refresh every 15 min while the page is open
- **Watched searches**: saved on the server and re-checked on a schedule even with the app closed, with optional target price
- **Price-drop alerts** pushed to your phone (ntfy), plus an in-app alert feed
- Price history per listing (`data/price-history.json`), shown as "▼ $X since first seen"
- Sort the full list by price, distance or miles
- Installable on a phone home screen (PWA manifest)

## Notes
- Phone GPS only works over **https** or on `localhost`. To use it on your phone, deploy to a host with https (Render, Railway, Fly.io) or use a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`).
- The server must stay running for alerts to fire. Render's free plan sleeps when idle and wipes saved data on restart, so for reliable alerts use a paid instance with a disk (~$7/mo), or run it on a home computer that stays on.

## Deploy (so GPS works on your phone)
1. On render.com: **New → Web Service → connect this repo**.
2. Build command: *(leave blank)* · Start command: `npm start`
3. Add environment variable `MARKETCHECK_API_KEY`.
4. Open the https URL Render gives you on your phone, then "Add to Home Screen".

## Roadmap
- [x] Push notifications on price drops for watched searches
- [x] Android APK build
- [ ] More listing sources alongside MarketCheck
- [ ] Price-history chart per vehicle
