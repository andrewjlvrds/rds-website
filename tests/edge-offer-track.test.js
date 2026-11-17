// Crude v1 test: stubs Zoho, runs the availability feed, and evaluates book.html getPricing.
var assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
var root = path.join(__dirname, '..');
var zohoPath = require.resolve(path.join(root, 'api/_zoho.js'));
var types = [
  { Tour_Code: 'Edge 21', Status: 'Active', Price_Rider_27: 190000, Price_Pillion_27: 96000, Upgrade_CRF1100_27: 15000, Upgrade_BMW_R1250GS_27: 21000, Upgrade_BMW_R1300GS: 26000, Shared_Room_Discount_27: 15000, Price_Adventure_Track_27: 20000 },
  { Tour_Code: 'FoSA 21', Status: 'Active', Price_Rider_27: 150000, Price_Pillion_27: 80000, Upgrade_CRF1100_27: 18000, Upgrade_BMW_R1250GS_27: 21000, Shared_Room_Discount_27: 12000 }
];
var tours = [
  { id: '1', Name: 'a', Status: 'Available', Tour_Type: 'Edge 21', Departure_Date: '2027-01-14', End_Date: '2027-02-03', Max_Guests: 12, Riders: 0 },
  { id: '2', Name: 'b', Status: 'Available', Tour_Type: 'Edge 21', Departure_Date: '2028-10-05', End_Date: '2028-10-25', Max_Guests: 12, Riders: 0 },
  { id: '3', Name: 'c', Status: 'Available', Tour_Type: 'FoSA 21', Departure_Date: '2027-03-01', End_Date: '2027-03-21', Max_Guests: 12, Riders: 0 }
];
require.cache[zohoPath] = { id: zohoPath, filename: zohoPath, loaded: true, exports: {
  getZohoToken: async function () { return 't'; },
  zohoFetch: async function () { return { data: types }; },
  zohoFetchV8: async function (t, url) {
    if (url.indexOf('/Bookings') === 0) return { data: [], info: {} };
    return { data: tours, info: { more_records: false } };
  }
} };
var handler = require(path.join(root, 'api/tour-availability.js'));

function getDeps() {
  var out;
  var res = { setHeader: function () {}, status: function () { return res; }, json: function (d) { out = d; return res; }, end: function () {} };
  return handler({ method: 'GET' }, res).then(function () { return out; });
}

function loadPricing(dep, form) {
  var html = fs.readFileSync(path.join(root, 'book.html'), 'utf8');
  function grab(name) {
    var i = html.indexOf('  function ' + name + '(');
    var j = html.indexOf('\n  }\n', i);
    return html.substring(i, j + 5);
  }
  var code = ['parsePrice', 'isPassenger', 'trackOffered', 'priceSource', 'getPricing'].map(grab).join('\n');
  var ctx = { form: form, getSelDep: function () { return dep; }, priceData: null, ONEDAY_PRICE: 8500 };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis.getPricing = getPricing;', ctx);
  return ctx.getPricing();
}

getDeps().then(function (d) {
  var jan = d.departures.filter(function (x) { return x.departure_date === '14/01/2027'; })[0];
  var oct = d.departures.filter(function (x) { return x.departure_date === '05/10/2028'; })[0];
  var feast = d.departures.filter(function (x) { return x.tour_id === 'feast-21'; })[0];
  assert.strictEqual(jan.base_price, '152000'); assert.strictEqual(jan.pillion, '76800');
  assert.strictEqual(jan.offer_label, 'January offer: 20% off'); assert.strictEqual(jan.offer_percent, 20);
  assert.strictEqual(jan.bike_upgrade_crf1100, '15000'); assert.strictEqual(jan.bike_upgrade_bmw1300gs, '26000');
  assert.strictEqual(jan.adventure_track_price, '20000');
  assert.strictEqual(oct.base_price, '205000'); assert.strictEqual(oct.pillion, '96000'); assert.strictEqual(oct.offer_label, '');
  assert.strictEqual(feast.base_price, '150000'); assert.strictEqual(feast.pillion, '80000'); assert.strictEqual(feast.offer_label, '');
  assert.strictEqual(feast.bike_upgrade_bmw1300gs, '0');
  function f(o) { var b = { tourVariant: 'edge-21', participantType: 'Rider', track: 'classic', roomType: 'Single', addPillion: 'No', bike: 'crf1000' }; for (var k in o) b[k] = o[k]; return b; }
  assert.strictEqual(loadPricing(jan, f({})).total, 152000);
  assert.strictEqual(loadPricing(jan, f({ track: 'adventure', bike: 'crf1000' })).total, 152000 + 20000);
  assert.strictEqual(loadPricing(jan, f({ track: 'adventure', bike: 'crf1100' })).total, 152000 + 20000 + 15000);
  assert.strictEqual(loadPricing(jan, f({ track: 'adventure', bike: 'bmw1250gs' })).total, 152000 + 20000 + 21000);
  assert.strictEqual(loadPricing(jan, f({ track: 'adventure', bike: 'bmw1300gs' })).total, 152000 + 20000 + 26000);
  // standard-price 2027 departure, base 190,000 (24 Oct 2027 steps are not in this fixture; use Jan base 190000 via oct2027 stub below)
  var std = Object.assign({}, jan, { base_price: '190000', pillion: '96000', offer_label: '', offer_percent: 0 });
  assert.strictEqual(loadPricing(std, f({ track: 'adventure', bike: 'crf1000' })).total, 210000);
  assert.strictEqual(loadPricing(std, f({ track: 'adventure', bike: 'crf1100' })).total, 225000);
  assert.strictEqual(loadPricing(std, f({ track: 'adventure', bike: 'bmw1250gs' })).total, 231000);
  assert.strictEqual(loadPricing(std, f({ track: 'adventure', bike: 'bmw1300gs' })).total, 236000);
  assert.strictEqual(loadPricing(std, f({ track: 'classic', bike: 'bmw1300gs' })).total, 190000 + 26000);
  assert.strictEqual(loadPricing(std, f({ track: 'classic', bike: 'crf1100' })).total, 190000 + 15000);
  assert.strictEqual(loadPricing(jan, f({ bike: 'bmw1250gs' })).total, 152000 + 21000);
  assert.strictEqual(loadPricing(jan, f({ addPillion: 'Yes' })).total, 152000 + 76800);
  assert.strictEqual(loadPricing(jan, f({ participantType: 'Pillion', track: 'adventure' })).total, 76800);
  assert.strictEqual(loadPricing(feast, f({ tourVariant: 'feast-21', track: 'adventure' })).track, 0);
  console.log('ALL TESTS PASSED');
}).catch(function (e) { console.error('FAIL', e); process.exit(1); });
