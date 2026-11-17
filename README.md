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

Optional env vars: `PORT` (default 3000), `REFRESH_MINUTES` (default 15).

## Where the listings come from
"Searching the whole web" for car prices is done through a listings aggregator, not by crawling sites yourself (most big sites — Facebook Marketplace, Craigslist, CarGurus, Autotrader — block or forbid scraping). AutoHunt uses the **MarketCheck** inventory API, which aggregates dealer websites across the US and Canada plus private-seller and auction listings. Get a key at marketcheck.com.

## Hard rules (enforced twice: in the API query and again on the server)
- Clean title only — listings with salvage/rebuilt **or unknown** title status are excluded.
- Mileage must be known and below 90,000.

## Features
- Filters: make, model, year range, price range, body, drivetrain, fuel, seller type (dealer / private / auction), radius
- GPS location (browser geolocation) with ZIP fallback; distance + Google Maps directions per listing
- Auto-refresh every 15 min while the page is open
- **Watched searches**: saved on the server and re-run every 15 min even with the page closed; flags new top-3 entries and price drops
- Price history per listing (`data/price-history.json`), shown as "▼ $X since first seen"
- Sort the full list by price, distance or miles
- Installable on a phone home screen (PWA manifest)

## Notes
- Phone GPS only works over **https** or on `localhost`. To use it on your phone, deploy to a host with https (Render, Railway, Fly.io) or use a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`).
- MarketCheck's free tier limits radius and calls per month — keep the refresh interval reasonable.

## Deploy (so GPS works on your phone)
1. On render.com: **New → Web Service → connect this repo**.
2. Build command: *(leave blank)* · Start command: `npm start`
3. Add environment variable `MARKETCHECK_API_KEY`.
4. Open the https URL Render gives you on your phone, then "Add to Home Screen".

## Roadmap
- [ ] Push notifications on price drops for watched searches
- [ ] More listing sources alongside MarketCheck
- [ ] Price-history chart per vehicle
- [ ] Android APK build
