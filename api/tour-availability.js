// api/tour-availability.js
// Reads tour departure dates and availability from Zoho Tours module.
// Replaces the previous Google Sheets implementation.
// Pricing per departure comes from the same Zoho record.

var zoho = require('./_zoho');

// Map Zoho Tour_Type → website tour_id
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

// Human-readable names (used for booking form dropdown)
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

// Zoho statuses that map to "Available" on the website
var AVAILABLE_STATUSES = ['Available', 'Confirmed'];
var WAITLIST_STATUSES  = ['Waitlist'];

var FETCH_FIELDS = [
  'Name',
  'Status',
  'Tour_Type',
  'Departure_Date',
  'End_Date',
  'Max_Guests',
  'Riders',
  'Price_Rider',
  'Price_Pillion',
  'Upgrade_CRF1100',
  'Upgrade_BMW',
  'Upgrade_Transalp',
  'Shared_Room_Discount',
].join(',');

// In-memory cache — 15 minute TTL (availability changes more frequently)
var cache = {
  data: null,
  timestamp: 0,
  TTL: 15 * 60 * 1000
};

// Convert Zoho date YYYY-MM-DD → DD/MM/YYYY (matches what WPCode snippet expects)
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
    var allTours = [];
    var page = 1;
    var more = true;
    while (more && page <= 5) {
      var result = await zoho.zohoApi('GET',
        'Tours?fields=' + FETCH_FIELDS + '&per_page=200&page=' + page + '&sort_by=Departure_Date&sort_order=asc'
      );
      if (result && result.data) allTours = allTours.concat(result.data);
      more = result && result.info && result.info.more_records;
      page++;
    }

    var departures = [];
    var tourNamesSeen = {};
    var tourNamesList = [];

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

      // Skip tours with no departure date
      if (!t.Departure_Date) continue;

      var tourName = TOUR_NAMES[tourId] || tourType;
      if (!tourNamesSeen[tourName]) {
        tourNamesSeen[tourName] = true;
        tourNamesList.push(tourName);
      }

      var maxGuests    = parseInt(t.Max_Guests || 12, 10);
      var ridersBooked = parseInt(t.Riders || 0, 10);
      var placesAvail  = Math.max(0, maxGuests - ridersBooked);

      departures.push({
        tour_id:              tourId,
        tour_name:            tourName,
        // departure_date in DD/MM/YYYY for WPCode snippet date parser compatibility
        departure_date:       zohoDateToDisplay(t.Departure_Date),
        tour_end_date:        zohoDateToDisplay(t.End_Date),
        tour_status:          isWaitlist ? 'Waitlist' : 'Available',
        places_available:     String(placesAvail),
        base_price:           String(Math.round(parseFloat(t.Price_Rider || 0))),
        pillion:              String(Math.round(parseFloat(t.Price_Pillion || 0))),
        shared_room_discount: String(Math.round(parseFloat(t.Shared_Room_Discount || 0))),
        bike_upgrade_crf1100: String(Math.round(parseFloat(t.Upgrade_CRF1100 || 0))),
        bike_upgrade_bmw1250gs: String(Math.round(parseFloat(t.Upgrade_BMW || 0))),
      });
    }

    var data = {
      updated:    new Date().toISOString(),
      source:     'zoho',
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
    return res.status(500).json({
      error: 'Unable to load tour availability data',
      detail: err.message
    });
  }
};
