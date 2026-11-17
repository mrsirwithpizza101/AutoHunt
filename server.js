// AutoHunt — best-price vehicle finder
// Zero dependencies. Requires Node 18+ (built-in fetch).
//   MARKETCHECK_API_KEY=xxxx node server.js      → live listings
//   node server.js                                → demo mode (clearly labeled sample data)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.MARKETCHECK_API_KEY || "";
const REFRESH_MIN = Number(process.env.REFRESH_MINUTES || 15);
const MAX_MILES = 90000; // hard rule: strictly under 90k
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "price-history.json");
const WATCH_FILE = path.join(DATA_DIR, "watches.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

let history = readJSON(HISTORY_FILE, {}); // id -> [{t, price}]
let watches = readJSON(WATCH_FILE, []);   // [{id, filters, lastRun, results}]

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
  p.set("radius", String(Math.min(Number(f.radius) || 100, 500)));
  if (f.make) p.set("make", f.make);
  if (f.model) p.set("model", f.model);
  if (f.yearMin || f.yearMax) p.set("year_range", `${f.yearMin || 1990}-${f.yearMax || new Date().getFullYear() + 1}`);
  if (f.priceMin || f.priceMax) p.set("price_range", `${f.priceMin || 0}-${f.priceMax || 999999}`);
  if (f.body) p.set("body_type", f.body);
  if (f.drivetrain) p.set("drivetrain", f.drivetrain);
  if (f.fuel) p.set("fuel_type", f.fuel);
  if (f.transmission) p.set("transmission", f.transmission);
  if (f.seller) p.set("seller_type", f.seller);

  const res = await fetch(`https://api.marketcheck.com/v2/search/car/active?${p}`);
  if (!res.ok) throw new Error(`MarketCheck ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.listings || []).map(x => {
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
}

// ---------- data source: demo (clearly labeled sample data, NOT real listings) ----------
function searchDemo(f) {
  const lat = Number(f.lat) || 45.5946, lon = Number(f.lon) || -121.1787; // default: The Dalles, OR
  const cars = [
    ["Toyota", "Tacoma", "Pickup", "4WD"], ["Ford", "F-150", "Pickup", "4WD"], ["Honda", "CR-V", "SUV", "AWD"],
    ["Subaru", "Outback", "Wagon", "AWD"], ["Toyota", "RAV4", "SUV", "AWD"], ["Ford", "Transit", "Van", "RWD"],
    ["Chevrolet", "Silverado 1500", "Pickup", "4WD"], ["Honda", "Civic", "Sedan", "FWD"], ["Jeep", "Wrangler", "SUV", "4WD"],
    ["Toyota", "4Runner", "SUV", "4WD"], ["Mazda", "CX-5", "SUV", "AWD"], ["Ram", "1500", "Pickup", "4WD"],
  ];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let i = 0; i < 60; i++) {
    const [make, model, body, drivetrain] = cars[Math.floor(rnd() * cars.length)];
    const year = 2012 + Math.floor(rnd() * 13);
    const miles = Math.floor(8000 + rnd() * 140000);
    const ang = rnd() * 2 * Math.PI, dist = rnd() * 150;
    const clat = lat + (dist / 69) * Math.cos(ang), clon = lon + (dist / 52) * Math.sin(ang);
    const base = 9000 + (year - 2012) * 2200 - miles * 0.06 + rnd() * 6000;
    const drift = Math.floor((Date.now() / (REFRESH_MIN * 60000)) % 5) * (i % 4 === 0 ? -250 : 0); // simulate price drops
    out.push({
      id: `demo-${i}`, vin: `SAMPLE${String(i).padStart(11, "0")}`,
      title: `${year} ${make} ${model}`, year, make, model, body, drivetrain,
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
    (!f.body || l.body.toLowerCase() === f.body.toLowerCase()) &&
    (!f.drivetrain || l.drivetrain.toLowerCase() === f.drivetrain.toLowerCase()) &&
    (!f.yearMin || l.year >= +f.yearMin) && (!f.yearMax || l.year <= +f.yearMax) &&
    (!f.priceMin || l.price >= +f.priceMin) && (!f.priceMax || l.price <= +f.priceMax) &&
    (!f.radius || l.distance <= +f.radius));
}

async function runSearch(filters) {
  const raw = API_KEY ? await searchMarketCheck(filters) : searchDemo(filters);
  const all = raw.map(l => { recordPrice(l); return l; });
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

// ---------- background watcher: re-runs saved searches on a schedule ----------
async function refreshWatches() {
  for (const w of watches) {
    try {
      const r = await runSearch(w.filters);
      const prevTop = (w.top3 || []).map(x => x.id).join();
      w.lastRun = r.fetchedAt; w.top3 = r.top3; w.count = r.results.length;
      w.changed = prevTop !== r.top3.map(x => x.id).join() || r.top3.some(x => x.lastChange < 0);
    } catch (e) { w.error = String(e.message || e); }
  }
  writeJSON(WATCH_FILE, watches);
}
setInterval(refreshWatches, REFRESH_MIN * 60000);

// ---------- http ----------
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise(r => { let s = ""; req.on("data", c => (s += c)); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (u.pathname === "/api/search") return send(res, 200, await runSearch(Object.fromEntries(u.searchParams)));
    if (u.pathname === "/api/config") return send(res, 200, { mode: API_KEY ? "live" : "demo", refreshMinutes: REFRESH_MIN, maxMiles: MAX_MILES });
    if (u.pathname === "/api/watches" && req.method === "GET") return send(res, 200, watches);
    if (u.pathname === "/api/watches" && req.method === "POST") {
      const filters = await readBody(req);
      const w = { id: Date.now().toString(36), filters, created: Date.now() };
      watches.push(w); writeJSON(WATCH_FILE, watches); refreshWatches();
      return send(res, 200, w);
    }
    if (u.pathname.startsWith("/api/watches/") && req.method === "DELETE") {
      watches = watches.filter(w => w.id !== u.pathname.split("/").pop()); writeJSON(WATCH_FILE, watches);
      return send(res, 200, { ok: true });
    }
    const file = path.join(__dirname, "public", u.pathname === "/" ? "index.html" : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ""));
    if (file.startsWith(path.join(__dirname, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };
      return send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, () => {
  console.log(`AutoHunt running → http://localhost:${PORT}  (${API_KEY ? "LIVE MarketCheck data" : "DEMO mode – sample data only"})`);
  console.log(`Saved searches refresh every ${REFRESH_MIN} min.`);
});
