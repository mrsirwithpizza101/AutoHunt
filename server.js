// AutoHunt — best-price vehicle finder
// Zero dependencies. Requires Node 18+ (built-in fetch).
//   MARKETCHECK_API_KEY=xxxx node server.js      → live listings
//   node server.js                                → demo mode (clearly labeled sample data)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.MARKETCHECK_API_KEY || "";
// Free MarketCheck plan = 500 calls/month and 100-mile max radius, so live mode checks less often.
const REFRESH_MIN = Number(process.env.REFRESH_MINUTES || (API_KEY ? 360 : 15));
const MONTHLY_CALL_LIMIT = Number(process.env.MONTHLY_CALL_LIMIT || 500);
const MAX_RADIUS = Number(process.env.MAX_RADIUS || 100);
const CACHE_MIN = Number(process.env.CACHE_MINUTES || 10);
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
const MAX_MILES = 90000; // hard rule: strictly under 90k
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "price-history.json");
const WATCH_FILE = path.join(DATA_DIR, "watches.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

let history = readJSON(HISTORY_FILE, {}); // id -> [{t, price}]
let watches = readJSON(WATCH_FILE, []);   // [{id, filters, targetPrice, seen:{id:price}, top3, ...}]
let settings = readJSON(SETTINGS_FILE, { ntfyTopic: process.env.NTFY_TOPIC || "" });
let alerts = readJSON(ALERTS_FILE, []);   // newest first, capped
let usage = readJSON(USAGE_FILE, { month: "", calls: 0 });
const cache = new Map();                  // query string -> {t, data}

function monthKey() { return new Date().toISOString().slice(0, 7); }
function useCall() {
  if (usage.month !== monthKey()) usage = { month: monthKey(), calls: 0 };
  if (usage.calls >= MONTHLY_CALL_LIMIT) throw new Error(`Monthly API limit reached (${MONTHLY_CALL_LIMIT} calls). Resets next month.`);
  usage.calls++; writeJSON(USAGE_FILE, usage);
}

// ---------- alerts (push via ntfy: free, no account; install the ntfy app and subscribe to your topic) ----------
async function pushAlert({ title, message, url, tags = "car" }) {
  const entry = { t: Date.now(), title, message, url: url || null };
  alerts.unshift(entry); alerts = alerts.slice(0, 100); writeJSON(ALERTS_FILE, alerts);
  if (!settings.ntfyTopic) return { delivered: false, reason: "no topic set" };
  const headers = { Title: title, Tags: tags, Priority: "high" };
  if (url) headers.Click = url;
  const r = await fetch(`${NTFY_SERVER}/${encodeURIComponent(settings.ntfyTopic)}`, { method: "POST", body: message, headers });
  return { delivered: r.ok, status: r.status };
}

// ---------- helpers ----------
function haversineMiles(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => v == null || isNaN(v))) return null;
  const R = 3958.8, toR = d => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function recordPrice(l) {
  const h = (history[l.id] ||= []);
  const last = h[h.length - 1];
  if (!last || last.price !== l.price) h.push({ t: Date.now(), price: l.price });
  const first = h[0].price;
  l.priceHistory = h;
  l.priceChange = l.price - first;           // negative = dropped
  l.lastChange = h.length > 1 ? l.price - h[h.length - 2].price : 0;
}

// Strict rules: a listing only qualifies if the title is CONFIRMED clean and miles are known and < 90k.
function qualifies(l) {
  return l.cleanTitle === true && typeof l.miles === "number" && l.miles > 0 && l.miles < MAX_MILES && l.price > 0;
}

// ---------- data source: MarketCheck ----------
async function searchMarketCheck(f) {
  const p = new URLSearchParams({
    api_key: API_KEY,
    car_type: f.condition === "new" ? "new" : "used",
    carfax_clean_title: "true",
    miles_range: `0-${MAX_MILES - 1}`,
    sort_by: "price",
    sort_order: "asc",
    rows: "50",
    start: "0",
  });
  if (f.lat && f.lon) { p.set("latitude", f.lat); p.set("longitude", f.lon); }
  else if (f.zip) p.set("zip", f.zip);
  p.set("radius", String(Math.min(Number(f.radius) || 100, MAX_RADIUS)));
  if (f.make) p.set("make", f.make);
  if (f.model) p.set("model", f.model);
  if (f.yearMin || f.yearMax) p.set("year_range", `${f.yearMin || 1990}-${f.yearMax || new Date().getFullYear() + 1}`);
  if (f.priceMin || f.priceMax) p.set("price_range", `${f.priceMin || 0}-${f.priceMax || 999999}`);
  if (f.body) p.set("body_type", f.body);
  if (f.drivetrain) p.set("drivetrain", f.drivetrain);
  const POWERTRAIN = { gas: "Combustion", hybrid: "HEV,PHEV,MHEV", electric: "BEV" };
  if (f.fuel && POWERTRAIN[f.fuel.toLowerCase()]) p.set("powertrain_type", POWERTRAIN[f.fuel.toLowerCase()]);
  if (f.transmission) p.set("transmission", f.transmission);
  if (f.seller) p.set("seller_type", f.seller);

  const cacheKey = p.toString();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_MIN * 60000) return hit.data;
  useCall();
  const res = await fetch(`https://api.marketcheck.com/v2/search/car/active?${p}`);
  if (!res.ok) throw new Error(`MarketCheck ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const data = (json.listings || []).map(x => {
    const d = x.dealer || {};
    const lat = Number(d.latitude), lon = Number(d.longitude);
    return {
      id: x.id || x.vin,
      vin: x.vin,
      title: x.heading || [x.build?.year, x.build?.make, x.build?.model, x.build?.trim].filter(Boolean).join(" "),
      year: x.build?.year, make: x.build?.make, model: x.build?.model, trim: x.build?.trim,
      body: x.build?.body_type, drivetrain: x.build?.drivetrain, fuel: x.build?.fuel_type,
      price: Number(x.price), miles: Number(x.miles),
      cleanTitle: x.carfax_clean_title === true ? true : x.carfax_clean_title === false ? false : null,
      oneOwner: !!x.carfax_1_owner,
      seller: d.name || x.seller_type || "Seller",
      city: d.city, state: d.state, lat, lon,
      distance: x.dist != null ? Number(x.dist) : haversineMiles(Number(f.lat), Number(f.lon), lat, lon),
      url: x.vdp_url,
      photo: x.media?.photo_links?.[0] || null,
      daysOnMarket: x.dom,
      source: x.source || "marketcheck",
    };
  });
  cache.set(cacheKey, { t: Date.now(), data });
  return data;
}

// ---------- data source: demo (clearly labeled sample data, NOT real listings) ----------
function searchDemo(f) {
  const lat = Number(f.lat) || 45.5946, lon = Number(f.lon) || -121.1787; // default: The Dalles, OR
  const cars = [
    ["Toyota", "Tacoma", "Pickup", "4WD"], ["Ford", "F-150", "Pickup", "4WD"], ["Honda", "CR-V", "SUV", "AWD"],
    ["Subaru", "Outback", "Wagon", "AWD"], ["Toyota", "RAV4", "SUV", "AWD"], ["Ford", "Transit", "Van", "RWD"],
    ["Chevrolet", "Silverado 1500", "Pickup", "4WD"], ["Honda", "Civic", "Sedan", "FWD"], ["Jeep", "Wrangler", "SUV", "4WD"],
    ["Toyota", "4Runner", "SUV", "4WD"], ["Mazda", "CX-5", "SUV", "AWD"], ["Ram", "1500", "Pickup", "4WD"],
    ["Toyota", "Prius", "Hatchback", "FWD", "Hybrid"], ["Toyota", "RAV4 Hybrid", "SUV", "AWD", "Hybrid"], ["Ford", "Maverick", "Pickup", "FWD", "Hybrid"],
    ["Tesla", "Model 3", "Sedan", "RWD", "Electric"], ["Chevrolet", "Bolt EV", "Hatchback", "FWD", "Electric"], ["Toyota", "Sienna", "Minivan", "AWD", "Hybrid"],
  ];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let i = 0; i < 90; i++) {
    const [make, model, body, drivetrain, fuel = "Gas"] = cars[Math.floor(rnd() * cars.length)];
    const year = 2012 + Math.floor(rnd() * 13);
    const miles = Math.floor(8000 + rnd() * 140000);
    const ang = rnd() * 2 * Math.PI, dist = rnd() * 150;
    const clat = lat + (dist / 69) * Math.cos(ang), clon = lon + (dist / 52) * Math.sin(ang);
    const base = 9000 + (year - 2012) * 2200 - miles * 0.06 + rnd() * 6000;
    const drift = Math.floor((Date.now() / (REFRESH_MIN * 60000)) % 5) * (i % 4 === 0 ? -250 : 0); // simulate price drops
    out.push({
      id: `demo-${i}`, vin: `SAMPLE${String(i).padStart(11, "0")}`,
      title: `${year} ${make} ${model}`, year, make, model, body, drivetrain, fuel,
      price: Math.max(3500, Math.round(base / 50) * 50 + drift), miles,
      cleanTitle: rnd() > 0.15 ? true : false, oneOwner: rnd() > 0.6,
      seller: `Sample Seller ${i + 1}`, city: "Sample", state: "", lat: clat, lon: clon,
      distance: haversineMiles(lat, lon, clat, clon), url: null, photo: null,
      daysOnMarket: Math.floor(rnd() * 90), source: "SAMPLE DATA",
    });
  }
  return out.filter(l =>
    (!f.make || l.make.toLowerCase() === f.make.toLowerCase()) &&
    (!f.model || l.model.toLowerCase().includes(f.model.toLowerCase())) &&
    (!f.body || f.body.toLowerCase().split(",").includes(l.body.toLowerCase())) &&
    (!f.fuel || l.fuel.toLowerCase() === f.fuel.toLowerCase()) &&
    (!f.drivetrain || l.drivetrain.toLowerCase() === f.drivetrain.toLowerCase()) &&
    (!f.yearMin || l.year >= +f.yearMin) && (!f.yearMax || l.year <= +f.yearMax) &&
    (!f.priceMin || l.price >= +f.priceMin) && (!f.priceMax || l.price <= +f.priceMax) &&
    (!f.radius || l.distance <= +f.radius));
}

async function runSearch(filters) {
  const raw = API_KEY ? await searchMarketCheck(filters) : searchDemo(filters);
  const all = raw.map(l => { l = { ...l }; recordPrice(l); return l; });
  const qualified = all.filter(qualifies).sort((a, b) => a.price - b.price || (a.distance ?? 1e9) - (b.distance ?? 1e9));
  writeJSON(HISTORY_FILE, history);
  return {
    mode: API_KEY ? "live" : "demo",
    fetchedAt: Date.now(),
    rules: { cleanTitleOnly: true, maxMilesExclusive: MAX_MILES },
    top3: qualified.slice(0, 3),
    results: qualified,
    excluded: all.length - qualified.length,
  };
}

// ---------- background watcher: re-runs saved searches and sends price-drop alerts ----------
const money = n => "$" + Math.round(n).toLocaleString("en-US");
const watchLabel = f => [f.make, f.model, f.body, f.priceMax && `≤${money(f.priceMax)}`].filter(Boolean).join(" ") || "Any vehicle";

async function checkWatch(w) {
  const r = await runSearch(w.filters);
  const firstRun = !w.seen;
  const seen = w.seen || {};
  const prevBestId = w.top3?.[0]?.id;
  const notes = [];

  for (const l of r.results) {
    const before = seen[l.id];
    if (!firstRun && before != null && l.price < before) {
      notes.push({ title: `▼ ${money(before - l.price)} price drop`, message: `${l.title} — now ${money(l.price)} (was ${money(before)}), ${l.miles.toLocaleString("en-US")} mi${l.distance != null ? `, ${l.distance} mi away` : ""}`, url: l.url, tags: "chart_with_downwards_trend,car" });
    }
    if (w.targetPrice && l.price <= w.targetPrice && (firstRun || before == null || before > w.targetPrice)) {
      notes.push({ title: `🎯 Under your ${money(w.targetPrice)} target`, message: `${l.title} — ${money(l.price)}, ${l.miles.toLocaleString("en-US")} mi${l.distance != null ? `, ${l.distance} mi away` : ""}`, url: l.url, tags: "dart,car" });
    }
  }
  const best = r.top3[0];
  if (!firstRun && best && best.id !== prevBestId && !notes.some(n => n.message.startsWith(best.title))) {
    notes.push({ title: `🏆 New cheapest: ${watchLabel(w.filters)}`, message: `${best.title} — ${money(best.price)}, ${best.miles.toLocaleString("en-US")} mi`, url: best.url, tags: "trophy,car" });
  }

  w.seen = Object.fromEntries(r.results.map(l => [l.id, l.price]));
  w.lastRun = r.fetchedAt; w.top3 = r.top3; w.count = r.results.length; w.error = null;
  w.changed = notes.length > 0;
  for (const n of notes.slice(0, 5)) await pushAlert({ ...n, title: `${n.title}` }).catch(() => {});
  if (notes.length > 5) await pushAlert({ title: `+${notes.length - 5} more updates`, message: `Open AutoHunt to see all changes for ${watchLabel(w.filters)}.` }).catch(() => {});
  return notes.length;
}

async function refreshWatches() {
  for (const w of watches) {
    try { await checkWatch(w); } catch (e) { w.error = String(e.message || e); }
  }
  writeJSON(WATCH_FILE, watches);
}
setInterval(refreshWatches, REFRESH_MIN * 60000);

// ---------- http ----------
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, {
    "Content-Type": type, "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise(r => { let s = ""; req.on("data", c => (s += c)); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (u.pathname === "/api/search") return send(res, 200, await runSearch(Object.fromEntries(u.searchParams)));
    if (u.pathname === "/api/config") return send(res, 200, {
      mode: API_KEY ? "live" : "demo", refreshMinutes: REFRESH_MIN, maxMiles: MAX_MILES, maxRadius: API_KEY ? MAX_RADIUS : 500,
      usage: { month: usage.month, calls: usage.calls, limit: MONTHLY_CALL_LIMIT },
    });
    if (u.pathname === "/api/settings" && req.method === "GET") return send(res, 200, settings);
    if (u.pathname === "/api/settings" && req.method === "PUT") {
      const b = await readBody(req);
      if (typeof b.ntfyTopic === "string") settings.ntfyTopic = b.ntfyTopic.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
      writeJSON(SETTINGS_FILE, settings);
      return send(res, 200, settings);
    }
    if (u.pathname === "/api/alerts" && req.method === "GET") return send(res, 200, alerts);
    if (u.pathname === "/api/alerts/test" && req.method === "POST") {
      return send(res, 200, await pushAlert({ title: "AutoHunt test alert", message: "Alerts are working. You'll get price drops for your watched searches here.", tags: "white_check_mark" }));
    }
    if (u.pathname === "/api/watches" && req.method === "GET") return send(res, 200, watches.map(({ seen, ...w }) => w));
    if (u.pathname === "/api/watches" && req.method === "POST") {
      const { targetPrice, ...filters } = await readBody(req);
      const w = { id: Date.now().toString(36), filters, targetPrice: Number(targetPrice) || null, created: Date.now() };
      watches.push(w); writeJSON(WATCH_FILE, watches);
      checkWatch(w).then(() => writeJSON(WATCH_FILE, watches)).catch(e => { w.error = String(e.message || e); });
      return send(res, 200, w);
    }
    if (u.pathname.startsWith("/api/watches/") && req.method === "POST" && u.pathname.endsWith("/check")) {
      const w = watches.find(x => x.id === u.pathname.split("/")[3]);
      if (!w) return send(res, 404, { error: "not found" });
      const n = await checkWatch(w); writeJSON(WATCH_FILE, watches);
      return send(res, 200, { alerts: n });
    }
    if (u.pathname.startsWith("/api/watches/") && req.method === "DELETE") {
      watches = watches.filter(w => w.id !== u.pathname.split("/").pop()); writeJSON(WATCH_FILE, watches);
      return send(res, 200, { ok: true });
    }
    const file = path.join(__dirname, "public", u.pathname === "/" ? "index.html" : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ""));
    if (file.startsWith(path.join(__dirname, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
      return send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, () => {
  console.log(`AutoHunt running → http://localhost:${PORT}  (${API_KEY ? "LIVE MarketCheck data" : "DEMO mode – sample data only"})`);
  console.log(`Watched searches refresh every ${REFRESH_MIN} min. Alerts: ${settings.ntfyTopic ? "ntfy topic " + settings.ntfyTopic : "no ntfy topic set"}.`);
});
