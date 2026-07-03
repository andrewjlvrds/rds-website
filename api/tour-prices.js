// api/tour-prices.js
// Reads pricing from Zoho Tours module (source of truth since May 2026).
// "From" price = the nearest UPCOMING departure of each tour type, so the
// headline figure is always the next thing a guest can actually book.
// Falls back to the highest-priced departure if no upcoming one has a price yet.

var zoho = require('./_zoho');

var TOUR_TYPE_TO_ID = {
  'FoSA 20': 'feast-20',
  'FoSA 21': 'feast-21',
  'FoSA 15': 'feast-15',
  'Edge 14':  'edge-14',
  'Edge 12':  'edge-12',
  'Edge 21':  'edge-21',
  'Edge 21 LWU': 'edge-21',
  'Edge 13 SWD': 'edge-13',
  'BoN':      'bon-13',
  'GL':       'greatlakes-24',
  'GL 14':    'greatlakes-14',
  'SST 14':   'sst-14',
};

var TOUR_NAMES = {
  'feast-20':      'Feast of Southern Africa: 20 days',
  'feast-21':      'Feast of Southern Africa: 21 days',
  'feast-15':      'Feast of Southern Africa: 15 days',
  'edge-14':       'Edge of Africa: 14 days',
  'edge-12':       'Edge of Africa: 12 days',
  'edge-21':       'Edge of Africa: 21 days',
  'edge-13':       'Edge of Africa: 13 days',
  'bon-13':        'Best of Namibia: 13 days',
  'greatlakes-24': 'Great Lakes & Rift Valley: 24 days',
  'greatlakes-14': 'Great Lakes & Rift Valley: 14 days',
  'sst-14':        'Southern Sweep: 14 days',
};

var FETCH_FIELDS = 'Tour_Type,Departure_Date,Status,Price_Rider,Price_Pillion,Upgrade_CRF1100,Upgrade_BMW,Upgrade_Transalp,Shared_Room_Discount';

var cache = {
  data: null,
  timestamp: 0,
  TTL: 60 * 60 * 1000
};

function riderOf(t) { return parseFloat((t && t.Price_Rider) || 0); }

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

    var allTours = [];
    var page = 1;
    var more = true;
    while (more && page <= 5) {
      var result = await zoho.zohoFetch(token,
        '/Tours?fields=' + FETCH_FIELDS + '&per_page=200&page=' + page
      );
      if (result && result.data) allTours = allTours.concat(result.data);
      more = result && result.info && result.info.more_records;
      page++;
    }

    if (debug) {
      return res.status(200).json({
        total: allTours.length,
        sample: allTours.slice(0, 5),
        allTourTypes: allTours.map(function(t) {
          return { type: t.Tour_Type, date: t.Departure_Date, status: t.Status, price: t.Price_Rider };
        })
      });
    }

    var todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // For each tour type track: nearest upcoming departure, and highest-priced (fallback)
    var nearestByType = {};
    var maxByType = {};

    for (var i = 0; i < allTours.length; i++) {
      var t = allTours[i];
      var tourType = t.Tour_Type;
      if (!tourType || !TOUR_TYPE_TO_ID[tourType]) continue;

      var status = t.Status || '';
      if (status === 'Completed' || status === 'Cancelled') continue;

      var dep = (t.Departure_Date || '');

      // Highest-priced fallback
      if (!maxByType[tourType] || riderOf(t) > riderOf(maxByType[tourType])) {
        maxByType[tourType] = t;
      }

      // Nearest upcoming (earliest departure on/after today)
      if (dep && dep >= todayStr) {
        var curNear = nearestByType[tourType];
        if (!curNear || dep < (curNear.Departure_Date || '9999')) {
          nearestByType[tourType] = t;
        }
      }
    }

    var tours = {};
    Object.keys(TOUR_TYPE_TO_ID).forEach(function(tourType) {
      var tourId = TOUR_TYPE_TO_ID[tourType];

      // Prefer nearest upcoming; if it has no price yet, fall back to highest-priced
      var pick = nearestByType[tourType];
      if (!pick || riderOf(pick) <= 0) {
        if (maxByType[tourType] && riderOf(maxByType[tourType]) > 0) pick = maxByType[tourType];
      }
      if (!pick) pick = maxByType[tourType] || nearestByType[tourType];
      if (!pick) return;

      var priceRider = riderOf(pick);
      if (!priceRider) return;

      tours[tourId] = {
        tour_id:                tourId,
        tour_name:              TOUR_NAMES[tourId] || tourType,
        from_date:              pick.Departure_Date || '',
        base_price:             String(Math.round(priceRider)),
        pillion:                String(Math.round(parseFloat(pick.Price_Pillion || 0))),
        shared_room_discount:   String(Math.round(parseFloat(pick.Shared_Room_Discount || 0))),
        bike_upgrade_crf1100:   String(Math.round(parseFloat(pick.Upgrade_CRF1100 || 0))),
        bike_upgrade_bmw1250gs: String(Math.round(parseFloat(pick.Upgrade_BMW || 0))),
        bike_upgrade_transalp:  String(Math.round(parseFloat(pick.Upgrade_Transalp || 0))),
      };
    });

    var data = {
      updated: new Date().toISOString(),
      source: 'zoho',
      basis: 'nearest-upcoming',
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
