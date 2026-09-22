// api/tour-availability.js
// Reads tour departure dates and availability from Zoho Tours module.
// Replaces the previous Google Sheets implementation.

var zoho = require('./_zoho');

var TOUR_TYPE_TO_ID = {
  'FoSA 20': 'feast-20',
  'FoSA 21': 'feast-21',
  'FoSA 16': 'feast-16',
  'Edge 14':  'edge-14',
  'Edge 12':  'edge-12',
  'Edge 21':  'edge-21',
  'Edge 21 LWU': 'edge-21',
  'Edge 13 SWD': 'edge-13',
  'BoN':      'bon-14',
  'GL':       'greatlakes-24',
  'GL 14':    'greatlakes-14',
  'SST 14':   'sst-14',
};

var TOUR_NAMES = {
  'feast-20':      'Feast of Southern Africa: 20 days',
  'feast-21':      'Feast of Southern Africa: 21 days',
  'feast-16':      'Feast of Southern Africa: 16 days',
  'edge-14':       'Edge of Africa: 14 days',
  'edge-12':       'Edge of Africa: 12 days',
  'edge-21':       'Edge of Africa: 21 days',
  'edge-13':       'Edge of Africa: 13 days',
  'bon-14':        'Best of Namibia',
  'greatlakes-24': 'Great Lakes & Rift Valley: 24 days',
  'greatlakes-14': 'Great Lakes & Rift Valley: 14 days',
  'sst-14':        'Southern Sweep: 14 days',
};

var AVAILABLE_STATUSES = ['Available', 'Confirmed'];
var WAITLIST_STATUSES  = ['Waitlist'];

var FETCH_FIELDS = 'Name,Status,Tour_Type,Departure_Date,End_Date,Max_Guests,Riders,Price_Rider,Price_Pillion,Upgrade_CRF1100,Upgrade_BMW,Shared_Room_Discount';

var cache = {
  data: null,
  timestamp: 0,
  TTL: 15 * 60 * 1000 // 15 minutes
};

// Tour_Types (the canonical price list, Andrew 3 Jul 2026; reaffirmed
// 21-22 Sep 2026: "all prices must come from zoho tour types"). The WPCode
// tour-page widget (.rds-tour-prices) reads the FIRST departure for a tour
// from this feed, so the departure record's own Price_* fields leaked onto
// tour pages (found 22 Sep: /best-of-namibia/ showed the past May-2026
// departure's R134,000). From now on each departure's price fields are the
// Tour_Types set for its departure year (_27, _28 ...); the Tours record's
// figures are only a fallback when Tour_Types has no set for that year.
var TYPE_CODE_TO_ID = {
  'FoSA 21': 'feast-21',
  'FoSA 16': 'feast-16',
  'Edge 21': 'edge-21',
  'BoN':     'bon-14',
  'SST 14':  'sst-14',
};
var TYPE_FIELDS = 'Tour_Code,Status,Price_Rider_27,Price_Pillion_27,Upgrade_CRF1100_27,Upgrade_BMW_R1250GS_27,Shared_Room_Discount_27,Price_Rider_28,Price_Pillion_28,Upgrade_CRF1100_28,Upgrade_BMW_R1250GS_28,Shared_Room_Discount_28';

function n(v) { return Math.round(parseFloat(v || 0)); }

async function loadTypePrices(token) {
  var out = {}; // tourId -> { '2027': {...}, '2028': {...} }
  try {
    var r = await zoho.zohoFetch(token, '/Tour_Types?fields=' + TYPE_FIELDS + '&per_page=200');
    var types = (r && r.data) || [];
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      var id = TYPE_CODE_TO_ID[t.Tour_Code];
      if (!id || (t.Status || '') !== 'Active') continue;
      out[id] = {};
      ['27', '28'].forEach(function (yy) {
        if (!n(t['Price_Rider_' + yy])) return;
        out[id]['20' + yy] = {
          base_price:             String(n(t['Price_Rider_' + yy])),
          pillion:                String(n(t['Price_Pillion_' + yy])),
          shared_room_discount:   String(n(t['Shared_Room_Discount_' + yy])),
          bike_upgrade_crf1100:   String(n(t['Upgrade_CRF1100_' + yy])),
          bike_upgrade_bmw1250gs: String(n(t['Upgrade_BMW_R1250GS_' + yy])),
        };
      });
    }
  } catch (e) {
    console.error('[tour-availability] Tour_Types read failed, falling back to departure prices:', e.message);
  }
  return out;
}

// Zoho date YYYY-MM-DD → DD/MM/YYYY (WPCode snippet date parser expects this format)
function zohoDateToDisplay(str) {
  if (!str) return '';
  var parts = str.split('-');
  if (parts.length !== 3) return str;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  var now = Date.now();
  if (cache.data && (now - cache.timestamp) < cache.TTL) {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }

  try {
    var token = await zoho.getZohoToken();
    var typePrices = await loadTypePrices(token);

    var allTours = [];
    var page = 1;
    var more = true;
    while (more && page <= 5) {
      // v8: the Riders rollup is undefined under v2 fields= (every departure
      // showed max places). See _zoho.js zohoFetchV8 note, 2026-07-11.
      // No sort_by: v8 records API only accepts id/Created_Time/Modified_Time
      // and rejects Departure_Date with INVALID_DATA (v2 silently allowed it).
      // Consumers sort by date client-side.
      var result = await zoho.zohoFetchV8(token,
        '/Tours?fields=' + FETCH_FIELDS + '&per_page=200&page=' + page
      );
      if (result && result.data) allTours = allTours.concat(result.data);
      more = result && result.info && result.info.more_records;
      page++;
    }

    var departures = [];
    var tourNamesSeen = {};
    var tourNamesList = [];
    var seenDep = {};

    for (var i = 0; i < allTours.length; i++) {
      var t = allTours[i];
      var tourType = t.Tour_Type;
      if (!tourType) continue;

      var tourId = TOUR_TYPE_TO_ID[tourType];
      if (!tourId) continue;

      var status = t.Status || '';
      var isAvailable = AVAILABLE_STATUSES.indexOf(status) !== -1;
      var isWaitlist  = WAITLIST_STATUSES.indexOf(status) !== -1;
      if (!isAvailable && !isWaitlist) continue;

      if (!t.Departure_Date) continue;

      // Past departures never appear: nothing can be booked on them, the
      // dates widget already hides them client-side, and the price widget
      // does not (22 Sep 2026: a past May-2026 BoN departure still marked
      // Available in Zoho was the first record and set the page price).
      if (t.Departure_Date < new Date().toISOString().slice(0, 10)) continue;

      // Skip duplicate departures (same tour + dates) so a stray duplicate in
      // Zoho can't double up on the website or in the booking form dropdown.
      var depKey = tourId + '|' + t.Departure_Date + '|' + (t.End_Date || '');
      if (seenDep[depKey]) continue;
      seenDep[depKey] = true;

      var tourName = TOUR_NAMES[tourId] || tourType;
      if (!tourNamesSeen[tourName]) {
        tourNamesSeen[tourName] = true;
        tourNamesList.push(tourName);
      }

      var maxGuests    = parseInt(t.Max_Guests || 12, 10);
      var ridersBooked = parseInt(t.Riders || 0, 10);
      var placesAvail  = Math.max(0, maxGuests - ridersBooked);

      var depYear = String(t.Departure_Date).slice(0, 4);
      var tp = (typePrices[tourId] || {})[depYear] || null;

      departures.push({
        tour_id:                tourId,
        tour_name:              tourName,
        departure_date:         zohoDateToDisplay(t.Departure_Date),
        tour_end_date:          zohoDateToDisplay(t.End_Date),
        tour_status:            isWaitlist ? 'Waitlist' : 'Available',
        places_available:       String(placesAvail),
        base_price:             tp ? tp.base_price             : String(n(t.Price_Rider)),
        pillion:                tp ? tp.pillion                : String(n(t.Price_Pillion)),
        shared_room_discount:   tp ? tp.shared_room_discount   : String(n(t.Shared_Room_Discount)),
        bike_upgrade_crf1100:   tp ? tp.bike_upgrade_crf1100   : String(n(t.Upgrade_CRF1100)),
        bike_upgrade_bmw1250gs: tp ? tp.bike_upgrade_bmw1250gs : String(n(t.Upgrade_BMW)),
        price_source:           tp ? 'tour_types_' + depYear    : 'tours_record',
      });
    }

    // Sort departures by departure date ascending (dd/mm/yyyy). The feed
    // previously shipped in Zoho record order, which made date widgets with a
    // display limit drop the earliest departures (found 2026-08-05: LP dates
    // block missing Mar/Apr 2027 FoSA). Server-side sort fixes every consumer,
    // including the WPCode snippet that slices without sorting.
    departures.sort(function (a, b) {
      function key(dep) {
        var p = String(dep.departure_date || '').split('/');
        if (p.length !== 3) return 0;
        return parseInt(p[2], 10) * 10000 + parseInt(p[1], 10) * 100 + parseInt(p[0], 10);
      }
      return key(a) - key(b);
    });

    var data = {
      updated:    new Date().toISOString(),
      source:     'zoho',
      price_source: 'tour_types (per departure year), tours record fallback',
      tour_names: tourNamesList,
      departures: departures
    };

    cache.data = data;
    cache.timestamp = Date.now();

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (err) {
    console.error('[tour-availability] error:', err.message);
    return res.status(500).json({ error: 'Unable to load tour availability data', detail: err.message });
  }
};
