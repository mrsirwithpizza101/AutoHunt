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

// ---------- search (shared with the Android app via public/core.js) ----------
const Core = require("./public/core.js");

function recordPrice(l) {
  const h = (history[l.id] ||= []);
  const last = h[h.length - 1];
  if (!last || last.price !== l.price) h.push({ t: Date.now(), price: l.price });
  l.priceChange = l.price - h[0].price;      // negative = dropped since first seen
  l.lastChange = h.length > 1 ? l.price - h[h.length - 2].price : 0;
}

async function cachedMarketCheck(f, start) {
  const key = JSON.stringify([f.lat, f.lon, f.zip, f.radius, f.make, f.model, f.body, f.fuel, f.priceMin, f.priceMax, start]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MIN * 60000) return hit.data;
  useCall();
  const data = await Core.searchMarketCheck(f, { apiKey: API_KEY, start, maxRadius: MAX_RADIUS });
  cache.set(key, { t: Date.now(), data });
  return data;
}

async function runSearch(filters, start = 0) {
  start = Math.max(0, Number(start) || 0);
  const r = API_KEY ? await cachedMarketCheck(filters, start) : Core.searchDemo(filters, { start });
  const results = r.results.map(l => { l = { ...l }; recordPrice(l); return l; });
  writeJSON(HISTORY_FILE, history);
  return { ...r, results, top3: start === 0 ? results.slice(0, 3) : [], radius: Core.clampRadius(filters.radius, API_KEY ? MAX_RADIUS : 500) };
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
    if (u.pathname === "/api/search") { const q = Object.fromEntries(u.searchParams); return send(res, 200, await runSearch(q, q.start)); }
    if (u.pathname === "/api/config") return send(res, 200, {
      mode: API_KEY ? "live" : "demo", refreshMinutes: REFRESH_MIN, maxMiles: MAX_MILES, minRadius: Core.MIN_RADIUS, maxRadius: API_KEY ? MAX_RADIUS : 500,
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
