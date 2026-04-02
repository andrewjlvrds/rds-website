var SPREADSHEET_ID = '1LcmK8TPLT32XJL6APJQPjR5JLSKmxuBsLVuDHgfAckQ';
var SHEET_NAME = 'Tour_List';

// In-memory cache
var cache = {
  data: null,
  timestamp: 0,
  TTL: 60 * 60 * 1000 // 1 hour
};

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ridedownsouth.com');
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
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
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

      // Map column positions by header name (case-insensitive, trimmed)
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

      // Deduplicate by tour_id — pricing is the same across all departures
      var tours = {};

      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        var tourId = getVal(row, 'tour_id');
        if (!tourId) continue;
        if (tours[tourId]) continue;

        tours[tourId] = {
          tour_id: tourId,
          tour_name: getVal(row, 'tour_name'),
          base_price: getVal(row, 'base_price'),
          pillion: getVal(row, 'pillion'),
          shared_room_discount: getVal(row, 'shared_room_discount'),
          bike_upgrade_crf1100: getVal(row, 'bike_upgrade_crf1100'),
          bike_upgrade_bmw1250gs: getVal(row, 'bike_upgrade_bmw1250gs'),
          pre_tour_1_day_ride: getVal(row, 'pre_tour_1_day_ride'),
          extra_night_cape_town: getVal(row, 'extra_night_cape_town_v_v') || getVal(row, 'extra_night_cape_town_v_amp_v')
        };
      }

      var result = {
        updated: new Date().toISOString(),
        tours: tours
      };

      cache.data = result;
      cache.timestamp = Date.now();

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
      res.setHeader('X-Cache', 'MISS');
      res.status(200).json(result);
    })
    .catch(function (err) {
      console.error('Tour prices fetch error:', err.message);
      res.status(500).json({
        error: 'Unable to load tour pricing data',
        detail: err.message
      });
    });
};
