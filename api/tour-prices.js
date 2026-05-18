// api/tour-prices.js
// Reads pricing from Zoho Tours module (source of truth since May 2026).
// Replaces the previous Google Sheets implementation.
// Pricing is managed in RDS Dash → pushed to Zoho via tour-push-prices.

var zoho = require('./_zoho');

// Map Zoho Tour_Type values → website tour_id keys
var TOUR_TYPE_TO_ID = {
  'FoSA 20': 'feast-20',
  'FoSA 21': 'feast-21',
  'FoSA 15': 'feast-15',
  'Edge 14':  'edge-14',
  'Edge 12':  'edge-12',
  'Edge 21':  'edge-21',
  'BoN':      'bon-13',
  'GL':       'greatlakes-24',
  'GL 14':    'greatlakes-14',
};

// Human-readable names for each tour_id
var TOUR_NAMES = {
  'feast-20':     'Feast of Southern Africa: 20 days',
  'feast-21':     'Feast of Southern Africa: 21 days',
  'feast-15':     'Feast of Southern Africa: 15 days',
  'edge-14':      'Edge of Africa: 14 days',
  'edge-12':      'Edge of Africa: 12 days',
  'edge-21':      'Edge of Africa: 21 days',
  'bon-13':       'Best of Namibia: 13 days',
  'greatlakes-24':'Great Lakes & Rift Valley: 24 days',
  'greatlakes-14':'Great Lakes & Rift Valley: 14 days',
};

var FETCH_FIELDS = [
  'Tour_Type',
  'Price_Rider',
  'Price_Pillion',
  'Upgrade_CRF1100',
  'Upgrade_BMW',
  'Upgrade_Transalp',
  'Shared_Room_Discount',
].join(',');

// In-memory cache — 1 hour TTL (pricing changes infrequently)
var cache = {
  data: null,
  timestamp: 0,
  TTL: 60 * 60 * 1000
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  var now = Date.now();
  if (cache.data && (now - cache.timestamp) < cache.TTL) {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }

  try {
    // Fetch all tours from Zoho, paginated
    var allTours = [];
    var page = 1;
    var more = true;
    while (more && page <= 5) {
      var result = await zoho.zohoApi('GET',
        'Tours?fields=' + FETCH_FIELDS + '&per_page=200&page=' + page
      );
      if (result && result.data) allTours = allTours.concat(result.data);
      more = result && result.info && result.info.more_records;
      page++;
    }

    // Deduplicate by Tour_Type — pricing is the same across all departures
    // Take the first non-zero price found for each type
    var seen = {};
    var tours = {};

    for (var i = 0; i < allTours.length; i++) {
      var t = allTours[i];
      var tourType = t.Tour_Type;
      if (!tourType) continue;
      if (seen[tourType]) continue;

      var tourId = TOUR_TYPE_TO_ID[tourType];
      if (!tourId) continue;

      var priceRider = parseFloat(t.Price_Rider || 0);
      if (!priceRider) continue; // skip tours with no pricing set

      seen[tourType] = true;
      tours[tourId] = {
        tour_id:              tourId,
        tour_name:            TOUR_NAMES[tourId] || tourType,
        base_price:           String(Math.round(priceRider)),
        pillion:              String(Math.round(parseFloat(t.Price_Pillion || 0))),
        shared_room_discount: String(Math.round(parseFloat(t.Shared_Room_Discount || 0))),
        bike_upgrade_crf1100: String(Math.round(parseFloat(t.Upgrade_CRF1100 || 0))),
        bike_upgrade_bmw1250gs: String(Math.round(parseFloat(t.Upgrade_BMW || 0))),
        bike_upgrade_transalp:  String(Math.round(parseFloat(t.Upgrade_Transalp || 0))),
      };
    }

    var data = {
      updated: new Date().toISOString(),
      source: 'zoho',
      tours: tours
    };

    cache.data = data;
    cache.timestamp = Date.now();

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (err) {
    console.error('[tour-prices] error:', err.message);
    return res.status(500).json({
      error: 'Unable to load tour pricing data',
      detail: err.message
    });
  }
};
