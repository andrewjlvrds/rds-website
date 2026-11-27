// api/_bike-availability.js
// Which bike models are still free for a tour departure.
// Pure functions, no network: tour-availability.js feeds them Zoho data.
//
// RULE (Andrew, 26 Nov 2026): guests pick a bike 10-15 months ahead and tours
// can be only days apart, so a model is free for departure X only if the whole
// fleet of that model, minus guide bikes, minus the most bikes of that model
// needed on any one day by X and by every other tour within BUFFER_DAYS of X,
// is still above zero. Fleets A and B are one shared pool.

var BUFFER_DAYS = 7; // turnaround days a bike needs between two tours (one constant, change here only)

// Keys the booking form uses (book.html BIKES_STD / BIKES_UP).
var MODEL_KEYS = ['crf1000', 'transalp', 'nx500', 'crf1100', 'bmw1250gs', 'bmw1300gs'];

// Guide bikes that travel with the guides and are never in the guest pool
// (Mike and Rogan each have their own CRF1100 - Andrew, fleet notes Sep 2026).
var GUIDE_BIKES = { crf1100: 2 };

// Zoho Vehicles.Vehcile_Type (sic) -> form key. Trucks and trailers are not listed so they are ignored.
var VEHICLE_TYPE_TO_KEY = {
  'CRF 1000': 'crf1000',
  'CRF 1100': 'crf1100',
  'Transalp 750': 'transalp',
  'NX 500': 'nx500',
  'BMW 1250 GS': 'bmw1250gs',
  'BMW 1300 GS': 'bmw1300gs'
};

// Vehicles that are not in the guest pool right now.
var OUT_OF_POOL_BIKE_STATUS = ['Not in service'];

// Bookings that hold a bike. Same statuses that hold a seat (tour-availability SEAT_INCLUDE) plus legacy "Booked".
var BIKE_HOLDING_STATUS = { 'Deposit Details Sent': 1, 'Deposit Paid': 1, 'Balance Paid': 1, 'Booked': 1 };
// Participants who do not take a bike of their own.
var NO_BIKE_PARTICIPANT = { 'Pillion': 1, 'Support Car Passenger': 1, 'Support Vehicle Driver': 1 };

var DAY_MS = 86400000;

// Free-text bike names from Zoho (Motorcycle_Preference / Allocated_Bike hold many spellings,
// e.g. "Honda Africa Twin CRF1000 (2016-2018)", "BMW1250", "Transalp 2026") -> form key, or null.
function modelKey(text) {
  if (!text) return null;
  var s = String(text).toLowerCase();
  if (s.indexOf('own bike') !== -1) return null;
  if (/1300/.test(s)) return 'bmw1300gs';
  if (/1250/.test(s)) return 'bmw1250gs';
  if (/nx\s*-?500/.test(s)) return 'nx500';
  if (/transalp/.test(s)) return 'transalp';
  if (/crf\s*-?1100/.test(s) || /africa twin.*1100/.test(s)) return 'crf1100';
  if (/crf\s*-?1000/.test(s) || /africa twin.*1000/.test(s)) return 'crf1000';
  return null;
}

// The bike a booking actually holds: the allocated bike if it names a model, else the guest's pick.
function bookingModel(b) {
  return modelKey(b.Allocated_Bike) || modelKey(b.Motorcycle_Preference);
}

function dayNum(iso) { // 'YYYY-MM-DD' -> whole days
  var p = String(iso || '').slice(0, 10).split('-');
  if (p.length !== 3) return NaN;
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY_MS);
}

// Fleet per model from Zoho Vehicles rows, less guide bikes. Returns {key: count}.
function fleetCapacity(vehicles) {
  var cap = {};
  MODEL_KEYS.forEach(function (k) { cap[k] = 0; });
  (vehicles || []).forEach(function (v) {
    var key = VEHICLE_TYPE_TO_KEY[v.Vehcile_Type];
    if (!key) return;
    if (v.Record_Status__s && v.Record_Status__s !== 'Available') return;
    if (OUT_OF_POOL_BIKE_STATUS.indexOf(v.Bike_Status) !== -1) return;
    cap[key]++;
  });
  Object.keys(GUIDE_BIKES).forEach(function (k) { cap[k] = Math.max(0, cap[k] - GUIDE_BIKES[k]); });
  return cap;
}

// Turn booking rows into demand: [{tourId, model}] for bookings that hold a bike.
function bikeDemandFromBooking(b) {
  if (!b || !b.Tour || !b.Tour.id) return null;
  if (!BIKE_HOLDING_STATUS[b.Booking_Status]) return null;
  if (NO_BIKE_PARTICIPANT[b.Participant_Type]) return null;
  var m = bookingModel(b);
  return m ? { tourId: b.Tour.id, model: m } : null;
}

// tours: [{id, Departure_Date, End_Date, Status}] (all tours, any type, cancelled ones ignored).
// demand: [{tourId, model}]. capacity: {key: n}.
// Returns {key: left} for the tour `targetId`, never below 0.
// Each tour occupies [start, end + BUFFER_DAYS): two tours clash when the gap between them is under BUFFER_DAYS.
// Bikes needed = the highest total, on any one day of the target's window, of that model across
// the target and every tour that clashes with it. A bike freed by an earlier tour can serve a later one.
function bikesLeft(targetId, tours, demand, capacity, bufferDays) {
  var buf = bufferDays == null ? BUFFER_DAYS : bufferDays;
  var iv = {};
  tours.forEach(function (t) {
    if (t.Status === 'Cancelled') return;
    var s = dayNum(t.Departure_Date), e = dayNum(t.End_Date);
    if (isNaN(s) || isNaN(e)) return;
    iv[t.id] = { s: s, e: e + buf };
  });
  var tgt = iv[targetId];
  var out = {};
  MODEL_KEYS.forEach(function (k) { out[k] = null; });
  if (!tgt) return null;
  var perTour = {}; // tourId -> {model: n}
  demand.forEach(function (d) {
    if (!iv[d.tourId]) return;
    var p = perTour[d.tourId] || (perTour[d.tourId] = {});
    p[d.model] = (p[d.model] || 0) + 1;
  });
  // Check days: target start, and the start day of every tour that begins inside the target window.
  var days = [tgt.s];
  Object.keys(iv).forEach(function (id) { if (iv[id].s > tgt.s && iv[id].s < tgt.e) days.push(iv[id].s); });
  MODEL_KEYS.forEach(function (k) {
    var peak = 0;
    days.forEach(function (day) {
      var load = 0;
      Object.keys(perTour).forEach(function (id) {
        var x = iv[id];
        var overlapsTarget = x.s < tgt.e && x.e > tgt.s;
        if (id === targetId || overlapsTarget) { if (x.s <= day && day < x.e) load += perTour[id][k] || 0; }
      });
      if (load > peak) peak = load;
    });
    out[k] = Math.max(0, (capacity[k] || 0) - peak);
  });
  return out;
}

module.exports = {
  BUFFER_DAYS: BUFFER_DAYS, MODEL_KEYS: MODEL_KEYS, GUIDE_BIKES: GUIDE_BIKES,
  modelKey: modelKey, bookingModel: bookingModel, fleetCapacity: fleetCapacity,
  bikeDemandFromBooking: bikeDemandFromBooking, bikesLeft: bikesLeft
};
