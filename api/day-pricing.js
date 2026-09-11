// api/day-pricing.js — single source of truth for one-day tour pricing.
// GET returns the config + a pure calculator is exported for server-side use.
//
// STATUS GATE (Andrew, 11 Sep 2026): the route prices, group discounts and
// bike supplements below are PROPOSALS. Until Andrew approves them, status
// stays 'proposed' — the public form shows them as "proposed, confirmed by
// Andrew with your booking" and submit-day-booking.js writes NO Tour_Price
// (Tour_Price_Notes carries the proposed figure instead). Flip status to
// 'published' ONLY on Andrew's explicit decision, and only after the page copy
// carries the same figures. Existing bookings keep their own snapshot; nothing
// here ever recalculates a historical booking (e.g. Anna BK26334 = R8,500).
var CONFIG = {
  version: '2026-09-11.1',
  status: 'proposed',           // 'proposed' | 'published'
  currency: 'ZAR',
  legacyPublishedPrice: 8500,   // the figure still on the live page today; informational only
  routes: [
    { id: 'peninsula', label: 'Cape Peninsula and Cape of Good Hope', zoho: 'Cape Peninsula and Cape of Good Hope', base: 9000 },
    { id: 'winelands', label: 'Cape Coast and Winelands', zoho: 'Cape Coast and Winelands', base: 9500 },
    { id: 'passes',    label: 'Four Passes Ride', zoho: 'Four Passes Ride', base: 10000 },
    { id: 'help',      label: 'Help me choose', zoho: 'Help me choose', base: null },
    { id: 'custom',    label: 'Custom route', zoho: 'Custom route', base: null }
  ],
  // Alternative Andrew has not selected between (GPT proposal): 9000/10000/11000.
  alternativeBases: { peninsula: 9000, winelands: 10000, passes: 11000 },
  groupDiscount: [ { minRiders: 3, pct: 15 }, { minRiders: 2, pct: 10 } ],
  bikes: [
    { id: 'nx500',     label: 'Honda NX500',                          zoho: 'NX 500',       supplement: 0 },
    { id: 'transalp',  label: 'Honda Transalp 750',                   zoho: 'Transalp',     supplement: 0 },
    { id: 'crf1000',   label: 'Honda Africa Twin CRF1000 (manual)',   zoho: 'CRF1000',      supplement: 0 },
    { id: 'crf1000dct',label: 'Honda Africa Twin CRF1000 (DCT)',      zoho: 'CRF1000 DCT',  supplement: 0 },
    { id: 'crf1100',   label: 'Honda Africa Twin CRF1100',            zoho: 'CRF1100',      supplement: 1000 },
    { id: 'r1250gs',   label: 'BMW R1250GS (Triple Black / Trophy)',  zoho: 'BMW1250',      supplement: 1500 },
    { id: 'r1300gs',   label: 'BMW R1300GS',                          zoho: 'BMW R1300GS',  supplement: 2000 },
    { id: 'none',      label: 'No preference / help me choose',       zoho: null,           supplement: 0 }
  ],
  rules: {
    supplementsDiscounted: false,   // supplements never receive the group discount
    pillionsCount: false,           // pillions/guides do not count as paying riders
    payment: 'Card on arrival (PoS); no advance deposit'
  }
};

function routeById(id) { for (var i = 0; i < CONFIG.routes.length; i++) if (CONFIG.routes[i].id === id) return CONFIG.routes[i]; return null; }
function bikeById(id) { for (var i = 0; i < CONFIG.bikes.length; i++) if (CONFIG.bikes[i].id === id) return CONFIG.bikes[i]; return null; }
function discountPct(n) { for (var i = 0; i < CONFIG.groupDiscount.length; i++) if (n >= CONFIG.groupDiscount[i].minRiders) return CONFIG.groupDiscount[i].pct; return 0; }

// quote(routeId, [bikeId,...]) -> { status, riders:[{bike,base,discountPct,discount,supplement,total}], groupTotal, priceable }
function quote(routeId, bikeIds) {
  var route = routeById(routeId);
  var n = bikeIds.length;
  var pct = discountPct(n);
  var riders = [], total = 0, priceable = !!(route && route.base);
  for (var i = 0; i < n; i++) {
    var bike = bikeById(bikeIds[i]) || bikeById('none');
    var base = priceable ? route.base : null;
    var disc = priceable ? Math.round(base * pct / 100) : null;
    var sup = bike.supplement || 0;
    var t = priceable ? (base - disc + sup) : null;
    if (priceable) total += t;
    riders.push({ index: i + 1, bike: bike.id, bikeLabel: bike.label, bikeZoho: bike.zoho, base: base, discountPct: pct, discount: disc, supplement: sup, total: t });
  }
  return { status: CONFIG.status, version: CONFIG.version, route: route ? route.id : null, routeLabel: route ? route.label : null, riders: riders, payingRiders: n, groupTotal: priceable ? total : null, priceable: priceable };
}

module.exports = function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(200).json(CONFIG);
};
module.exports.CONFIG = CONFIG;
module.exports.quote = quote;
module.exports.routeById = routeById;
module.exports.bikeById = bikeById;
