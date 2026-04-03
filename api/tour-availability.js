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

      function cleanPrice(val) {
        if (!val) return '';
        return val.toString().replace(/,/g, '').replace(/\s/g, '');
      }

      var allTours = [];

      // First pass: read bike upgrade prices from the bottom section
      // The sheet has a "Bike Upgrade Prices" section with rows like:
      // "Edge 14" | 13500 | 18000
      // "FoSA 15" | 13500 | 18000
      var upgradeMap = {};
      var inUpgradeSection = false;
      var upgradeCRFCol = -1;
      var upgradeBMWCol = -1;

      for (var u = 0; u < rows.length; u++) {
        var firstCell = (rows[u][0] || '').toString().trim();
        if (firstCell === 'Bike Upgrade Prices') {
          inUpgradeSection = true;
          // Next row has column headers: blank | CRF1100 | BMW1250GS
          if (u + 1 < rows.length) {
            for (var uc = 0; uc < rows[u+1].length; uc++) {
              var uHeader = (rows[u+1][uc] || '').toString().trim().toLowerCase();
              if (uHeader.indexOf('crf1100') !== -1) upgradeCRFCol = uc;
              if (uHeader.indexOf('bmw') !== -1) upgradeBMWCol = uc;
            }
          }
          u++; // skip header row
          continue;
        }
        if (inUpgradeSection && firstCell) {
          var upgKey = firstCell.toLowerCase().replace(/\s+/g, '');
          var crfVal = (upgradeCRFCol >= 0 && rows[u][upgradeCRFCol]) ? cleanPrice(rows[u][upgradeCRFCol]) : '';
          var bmwVal = (upgradeBMWCol >= 0 && rows[u][upgradeBMWCol]) ? cleanPrice(rows[u][upgradeBMWCol]) : '';
          upgradeMap[upgKey] = { crf: crfVal, bmw: bmwVal };
        }
        if (inUpgradeSection && !firstCell) {
          inUpgradeSection = false;
        }
      }

      // Map tour_id prefixes to upgrade keys
      function getUpgradeForTour(tourId) {
        // Try exact matches first, then prefix matches
        var id = tourId.toLowerCase();
        if (id.indexOf('edge-14') === 0 || id.indexOf('edge-12') === 0) {
          return upgradeMap['edge14'] || upgradeMap['edge'] || { crf:'', bmw:'' };
        }
        if (id.indexOf('feast-') === 0) {
          return upgradeMap['fosa15'] || upgradeMap['fosa'] || { crf:'', bmw:'' };
        }
        return { crf:'', bmw:'' };
      }

      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        var tourId = getVal(row, 'tour_id');
        if (!tourId) continue;

        // Only include Available and Waitlist tours
        var status = getVal(row, 'tour_status').toLowerCase();
        if (status !== 'available' && status !== 'waitlist') continue;

        var upgrades = getUpgradeForTour(tourId);

        allTours.push({
          tour_id: tourId,
          tour_ref: getVal(row, 'tour_ref'),
          tour_name: getVal(row, 'tour_name'),
          departure_date: getVal(row, 'departure_date'),
          tour_end_date: getVal(row, 'tour_end_date'),
          tour_status: getVal(row, 'tour_status'),
          places_available: getVal(row, 'places_available'),
          base_price: cleanPrice(getVal(row, 'base_price')),
          pillion: cleanPrice(getVal(row, 'pillion')),
          shared_room_discount: cleanPrice(getVal(row, 'shared_room_discount')),
          bike_upgrade_crf1100: upgrades.crf,
          bike_upgrade_bmw1250gs: upgrades.bmw
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
