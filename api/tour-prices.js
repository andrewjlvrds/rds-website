// api/tour-prices.js
// Reads pricing from the Zoho Tour_Types module — the canonical price list —
// showing 2027 pricing only (Price_*_27 fields). Decision: Andrew, 3 Jul 2026.
// (Previously read prices off individual Tours departure records, which
// carried stale draft figures — do not revert to that source.)
// Only Tour_Types with Status = Active and a non-null Price_Rider_27 appear.

var zoho = require('./_zoho');

// Tour_Code (Tour_Types module) -> site tour id used by page widgets.
var TOUR_CODE_TO_ID = {
  'FoSA 21': 'feast-21',
  'FoSA 15': 'feast-15',
  'Edge 21': 'edge-21',
  'BoN':     'bon-13',
  'SST 14':  'sst-14',
};

var TOUR_NAMES = {
  'feast-21': 'Feast of Southern Africa: 21 days',
  'feast-15': 'Feast of Southern Africa: 15 days',
  'edge-21':  'Edge of Africa: 21 days',
  'bon-13':   'Best of Namibia: 13 days',
  'sst-14':   'Southern Sweep: 14 days',
};

var FETCH_FIELDS = 'Tour_Code,Name,Status,Price_Rider_27,Price_Pillion_27,Upgrade_CRF1100_27,Upgrade_BMW_R1250GS_27,Shared_Room_Discount_27';

var cache = {
  data: null,
  timestamp: 0,
  TTL: 60 * 60 * 1000
};

function num(v) { return parseFloat(v || 0); }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // ?debug=1 bypasses cache and returns raw Zoho data for diagnosis
  var debug = req.query && req.query.debug === '1';

  var now = Date.now();
  if (!debug && cache.data && (now - cache.timestamp) < cache.TTL) {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }

  try {
    var token = await zoho.getZohoToken();

    var result = await zoho.zohoFetch(token,
      '/Tour_Types?fields=' + FETCH_FIELDS + '&per_page=200'
    );
    var types = (result && result.data) || [];

    if (debug) {
      return res.status(200).json({
        total: types.length,
        sample: types
      });
    }

    var tours = {};
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      var tourId = TOUR_CODE_TO_ID[t.Tour_Code];
      if (!tourId) continue;
      if ((t.Status || '') !== 'Active') continue;

      var priceRider = num(t.Price_Rider_27);
      if (!priceRider) continue;

      tours[tourId] = {
        tour_id:                tourId,
        tour_name:              TOUR_NAMES[tourId] || t.Name || t.Tour_Code,
        from_date:              '',
        base_price:             String(Math.round(priceRider)),
        pillion:                String(Math.round(num(t.Price_Pillion_27))),
        shared_room_discount:   String(Math.round(num(t.Shared_Room_Discount_27))),
        bike_upgrade_crf1100:   String(Math.round(num(t.Upgrade_CRF1100_27))),
        bike_upgrade_bmw1250gs: String(Math.round(num(t.Upgrade_BMW_R1250GS_27))),
        bike_upgrade_transalp:  '0',
      };
    }

    var data = {
      updated: new Date().toISOString(),
      source: 'zoho-tour-types',
      basis: '2027-pricing',
      tours: tours
    };

    cache.data = data;
    cache.timestamp = Date.now();

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (err) {
    console.error('[tour-prices] error:', err.message);
    return res.status(500).json({ error: 'Unable to load tour pricing data', detail: err.message });
  }
};
