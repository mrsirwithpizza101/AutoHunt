// AutoHunt shared search core — used by the server (require) and the app (script tag).
// Talks to the MarketCheck inventory API, or generates clearly labeled sample listings in demo mode.
(function (root) {
  const MAX_MILES = 90000;      // hard rule: strictly under 90k miles
  const MIN_RADIUS = 45;        // never search a smaller area than this
  const PAGE_SIZE = 50;         // MarketCheck max rows per call
  const POWERTRAIN = { gas: "Combustion", hybrid: "HEV,PHEV,MHEV", electric: "BEV" };
  const MC_URL = "https://api.marketcheck.com/v2/search/car/active";

  function haversineMiles(lat1, lon1, lat2, lon2) {
    if ([lat1, lon1, lat2, lon2].some(v => v == null || v === "" || isNaN(v))) return null;
    const R = 3958.8, toR = d => (d * Math.PI) / 180;
    const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
  }

  function clampRadius(r, maxRadius) {
    return Math.max(MIN_RADIUS, Math.min(Number(r) || MIN_RADIUS, maxRadius || 100));
  }

  // Only CONFIRMED clean titles with known miles under 90k qualify.
  function qualifies(l) {
    return l.cleanTitle === true && typeof l.miles === "number" && l.miles > 0 && l.miles < MAX_MILES && l.price > 0;
  }

  function marketCheckParams(f, apiKey, start, maxRadius) {
    const p = new URLSearchParams({
      api_key: apiKey, car_type: "used", carfax_clean_title: "true",
      miles_range: `1-${MAX_MILES - 1}`, sort_by: "price", sort_order: "asc",
      rows: String(PAGE_SIZE), start: String(start || 0),
    });
    if (f.lat && f.lon) { p.set("latitude", f.lat); p.set("longitude", f.lon); }
    else if (f.zip) p.set("zip", f.zip);
    p.set("radius", String(clampRadius(f.radius, maxRadius)));
    if (f.make) p.set("make", f.make);
    if (f.model) p.set("model", f.model);
    if (f.priceMin || f.priceMax) p.set("price_range", `${f.priceMin || 1}-${f.priceMax || 999999}`);
    else p.set("price_range", "1-999999"); // skip $0 "call for price" listings
    if (f.body) p.set("body_type", f.body);
    if (f.fuel && POWERTRAIN[String(f.fuel).toLowerCase()]) p.set("powertrain_type", POWERTRAIN[String(f.fuel).toLowerCase()]);
    return p;
  }

  function normalize(x, f) {
    const d = x.dealer || {}, b = x.build || {};
    const lat = Number(d.latitude), lon = Number(d.longitude);
    return {
      id: x.id || x.vin, vin: x.vin,
      title: x.heading || [b.year, b.make, b.model, b.trim].filter(Boolean).join(" "),
      year: b.year, make: b.make, model: b.model, trim: b.trim,
      body: b.body_type, drivetrain: b.drivetrain, fuel: b.fuel_type || b.powertrain_type,
      price: Number(x.price), miles: Number(x.miles),
      cleanTitle: x.carfax_clean_title === true ? true : x.carfax_clean_title === false ? false : null,
      oneOwner: !!x.carfax_1_owner,
      seller: d.name || x.seller_type || "Seller", city: d.city, state: d.state, lat, lon,
      distance: x.dist != null ? Number(x.dist) : haversineMiles(Number(f.lat), Number(f.lon), lat, lon),
      url: x.vdp_url || null, photo: (x.media && x.media.photo_links && x.media.photo_links[0]) || null,
      daysOnMarket: x.dom, source: x.source || "marketcheck",
    };
  }

  // One page of live results. fetchFn lets the app use native HTTP and the server use its own fetch.
  async function searchMarketCheck(f, { apiKey, start = 0, maxRadius = 100, fetchFn = fetch } = {}) {
    if (!apiKey) throw new Error("No MarketCheck API key set");
    const res = await fetchFn(`${MC_URL}?${marketCheckParams(f, apiKey, start, maxRadius)}`);
    if (res.status === 401 || res.status === 403) throw new Error("MarketCheck rejected the API key. Check it in ☰ Menu.");
    if (res.status === 429) throw new Error("MarketCheck limit reached (too many searches). Try again later.");
    if (!res.ok) throw new Error(`MarketCheck error ${res.status}`);
    const json = await res.json();
    const listings = (json.listings || []).map(x => normalize(x, f));
    return page(listings.filter(qualifies), Number(json.num_found) || 0, start, listings.length, "live");
  }

  // ---------- demo: made-up sample listings, deterministic per area ----------
  const DEMO_CARS = [
    ["Toyota", "Tacoma", "Pickup", "4WD", "Gas"], ["Ford", "F-150", "Pickup", "4WD", "Gas"], ["Honda", "CR-V", "SUV", "AWD", "Gas"],
    ["Subaru", "Outback", "Wagon", "AWD", "Gas"], ["Toyota", "RAV4", "SUV", "AWD", "Gas"], ["Ford", "Transit", "Van", "RWD", "Gas"],
    ["Chevrolet", "Silverado 1500", "Pickup", "4WD", "Gas"], ["Honda", "Civic", "Sedan", "FWD", "Gas"], ["Jeep", "Wrangler", "SUV", "4WD", "Gas"],
    ["Toyota", "4Runner", "SUV", "4WD", "Gas"], ["Mazda", "CX-5", "SUV", "AWD", "Gas"], ["Ram", "1500", "Pickup", "4WD", "Gas"],
    ["Toyota", "Camry", "Sedan", "FWD", "Gas"], ["Subaru", "Forester", "SUV", "AWD", "Gas"], ["Honda", "Odyssey", "Minivan", "FWD", "Gas"],
    ["Toyota", "Prius", "Hatchback", "FWD", "Hybrid"], ["Toyota", "RAV4 Hybrid", "SUV", "AWD", "Hybrid"], ["Ford", "Maverick", "Pickup", "FWD", "Hybrid"],
    ["Tesla", "Model 3", "Sedan", "RWD", "Electric"], ["Tesla", "Model Y", "SUV", "AWD", "Electric"], ["Chevrolet", "Bolt EV", "Hatchback", "FWD", "Electric"],
    ["Toyota", "Sienna", "Minivan", "AWD", "Hybrid"], ["Hyundai", "Ioniq 5", "SUV", "AWD", "Electric"], ["Nissan", "Leaf", "Hatchback", "FWD", "Electric"],
  ];
  function demoAll(f) {
    const lat = Number(f.lat) || 45.5946, lon = Number(f.lon) || -121.1787; // ZIP-only searches center on The Dalles, OR
    let seed = (Math.abs(Math.round(lat * 100) * 31 + Math.round(lon * 100)) % 2147483646) + 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const out = [];
    for (let i = 0; i < 700; i++) {
      const [make, model, body, drivetrain, fuel] = DEMO_CARS[Math.floor(rnd() * DEMO_CARS.length)];
      const year = 2012 + Math.floor(rnd() * 13), miles = Math.floor(5000 + rnd() * 130000);
      const ang = rnd() * 2 * Math.PI, dist = Math.sqrt(rnd()) * 150;
      const clat = lat + (dist / 69) * Math.cos(ang), clon = lon + (dist / 49) * Math.sin(ang);
      const base = 8000 + (year - 2012) * 2100 - miles * 0.05 + rnd() * 7000 + (fuel === "Electric" ? 4000 : 0);
      out.push({
        id: `demo-${i}`, vin: `SAMPLE${String(i).padStart(11, "0")}`, title: `${year} ${make} ${model}`,
        year, make, model, body, drivetrain, fuel, price: Math.max(3500, Math.round(base / 50) * 50), miles,
        cleanTitle: rnd() > 0.15, oneOwner: rnd() > 0.6, seller: `Sample Seller ${i + 1}`, city: "Sample", state: "",
        lat: clat, lon: clon, distance: haversineMiles(lat, lon, clat, clon), url: null, photo: null,
        daysOnMarket: Math.floor(rnd() * 90), source: "SAMPLE DATA",
      });
    }
    const radius = clampRadius(f.radius, 500), lc = s => String(s || "").toLowerCase();
    return out.filter(l =>
      qualifies(l) && l.distance <= radius &&
      (!f.make || lc(l.make) === lc(f.make)) && (!f.model || lc(l.model).includes(lc(f.model))) &&
      (!f.body || lc(f.body).split(",").includes(lc(l.body))) && (!f.fuel || lc(l.fuel) === lc(f.fuel)) &&
      (!f.priceMin || l.price >= +f.priceMin) && (!f.priceMax || l.price <= +f.priceMax)
    ).sort((a, b) => a.price - b.price || a.distance - b.distance);
  }
  function searchDemo(f, { start = 0 } = {}) {
    const all = demoAll(f);
    return page(all.slice(start, start + PAGE_SIZE), all.length, start, Math.min(PAGE_SIZE, Math.max(0, all.length - start)), "demo");
  }

  function page(results, total, start, rawCount, mode) {
    const nextStart = start + rawCount;
    return { mode, fetchedAt: Date.now(), results, total, start, nextStart, hasMore: rawCount === PAGE_SIZE && nextStart < total };
  }

  const Core = { MAX_MILES, MIN_RADIUS, PAGE_SIZE, haversineMiles, clampRadius, qualifies, marketCheckParams, normalize, searchMarketCheck, searchDemo };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  else root.AutoHuntCore = Core;
})(typeof self !== "undefined" ? self : this);
