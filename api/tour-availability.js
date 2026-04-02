var SPREADSHEET_ID = '1LcmK8TPLT32XJL6APJQPjR5JLSKmxuBsLVuDHgfAckQ';
var SHEET_NAME = 'Tour_List';

// In-memory cache — shorter TTL for availability
var cache = {
  data: null,
  timestamp: 0,
  TTL: 15 * 60 * 1000 // 15 minutes
};

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var now = Date.now();

  if (cache.data && (now - cache.timestamp) < cache.TTL) {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('X-Cache', 'HIT');
    res.status(200).json(cache.data);
    return;
  }

  var apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server configuration error — missing API key' });
    return;
  }

  var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
    SPREADSHEET_ID +
    '/values/' + encodeURIComponent(SHEET_NAME) +
    '?key=' + apiKey;

  fetch(url)
    .then(function (response) {
      if (!response.ok) {
        throw new Error('Google Sheets API returned ' + response.status);
      }
      return response.json();
    })
    .then(function (sheetsData) {
      var rows = sheetsData.values;
      if (!rows || rows.length < 2) {
        throw new Error('No data found in spreadsheet');
      }

      var headerRow = rows[0];
      var col = {};
      for (var h = 0; h < headerRow.length; h++) {
        var key = headerRow[h].toString().trim().toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '');
        col[key] = h;
      }

      function getVal(row, colName) {
        var idx = col[colName];
        if (idx === undefined || idx >= row.length) return '';
        return (row[idx] || '').toString().trim();
      }

      var allTours = [];

      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        var tourId = getVal(row, 'tour_id');
        if (!tourId) continue;

        // Only include Available and Waitlist tours
        var status = getVal(row, 'tour_status').toLowerCase();
        if (status !== 'available' && status !== 'waitlist') continue;

        allTours.push({
          tour_id: tourId,
          tour_ref: getVal(row, 'tour_ref'),
          tour_name: getVal(row, 'tour_name'),
          departure_date: getVal(row, 'departure_date'),
          tour_end_date: getVal(row, 'tour_end_date'),
          tour_status: getVal(row, 'tour_status'),
          places_available: getVal(row, 'places_available'),
          base_price: getVal(row, 'base_price'),
          pillion: getVal(row, 'pillion'),
          shared_room_discount: getVal(row, 'shared_room_discount'),
          bike_upgrade_crf1100: getVal(row, 'bike_upgrade_crf1100'),
          bike_upgrade_bmw1250gs: getVal(row, 'bike_upgrade_bmw1250gs')
        });
      }

      // Distinct tour names for the dropdown
      var tourNames = [];
      var seen = {};
      for (var k = 0; k < allTours.length; k++) {
        var name = allTours[k].tour_name;
        if (!seen[name]) {
          seen[name] = true;
          tourNames.push(name);
        }
      }

      var result = {
        updated: new Date().toISOString(),
        tour_names: tourNames,
        departures: allTours
      };

      cache.data = result;
      cache.timestamp = Date.now();

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      res.setHeader('X-Cache', 'MISS');
      res.status(200).json(result);
    })
    .catch(function (err) {
      console.error('Tour availability fetch error:', err.message);
      res.status(500).json({
        error: 'Unable to load tour availability data',
        detail: err.message
      });
    });
};
