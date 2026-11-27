// Crude v1 test for the bike availability rule. Run: node tests/bike-availability.test.js
var assert = require('assert'), path = require('path');
var ba = require(path.join(__dirname, '..', 'api', '_bike-availability.js'));

assert.strictEqual(ba.BUFFER_DAYS, 7);
assert.strictEqual(ba.modelKey('Honda Africa Twin CRF1000 (2016-2018)'), 'crf1000');
assert.strictEqual(ba.modelKey('Honda Africa Twin CRF1100'), 'crf1100');
assert.strictEqual(ba.modelKey('BMW1250'), 'bmw1250gs');
assert.strictEqual(ba.modelKey('BMW R1300GS'), 'bmw1300gs');
assert.strictEqual(ba.modelKey('Transalp 2026'), 'transalp');
assert.strictEqual(ba.modelKey('Honda NX500'), 'nx500');
assert.strictEqual(ba.modelKey('Add a set of pannier bags'), null);
assert.strictEqual(ba.modelKey('Own Bike'), null);

// Fleet: 3 CRF1100 (guide bikes take 2 -> capacity 1), 2 Transalp (one not in service)
var cap = ba.fleetCapacity([
  { Vehcile_Type: 'CRF 1100', Bike_Status: 'Available', Record_Status__s: 'Available' },
  { Vehcile_Type: 'CRF 1100', Bike_Status: 'Available', Record_Status__s: 'Available' },
  { Vehcile_Type: 'CRF 1100', Bike_Status: null, Record_Status__s: 'Available' },
  { Vehcile_Type: 'Transalp 750', Bike_Status: 'Available', Record_Status__s: 'Available' },
  { Vehcile_Type: 'Transalp 750', Bike_Status: 'Not in service', Record_Status__s: 'Available' },
  { Vehcile_Type: 'Trailer', Bike_Status: null, Record_Status__s: 'Available' }
]);
assert.strictEqual(cap.crf1100, 1);
assert.strictEqual(cap.transalp, 1);
assert.strictEqual(cap.nx500, 0);

// Tours: A 1-21 Mar, B 25 Mar-10 Apr (gap 4 days -> clash), C 25 Apr-15 May (gap 15 -> free of A and B)
var tours = [
  { id: 'A', Departure_Date: '2027-03-01', End_Date: '2027-03-21', Status: 'Confirmed' },
  { id: 'B', Departure_Date: '2027-03-25', End_Date: '2027-04-10', Status: 'Confirmed' },
  { id: 'C', Departure_Date: '2027-04-25', End_Date: '2027-05-15', Status: 'Confirmed' },
  { id: 'X', Departure_Date: '2027-03-01', End_Date: '2027-03-21', Status: 'Cancelled' }
];
var capacity = { crf1000: 3, transalp: 3, nx500: 3, crf1100: 3, bmw1250gs: 3, bmw1300gs: 3 };
function d(tourId, model, n) { var a = []; for (var i = 0; i < n; i++) a.push({ tourId: tourId, model: model }); return a; }
var demand = [].concat(d('A', 'transalp', 2), d('B', 'transalp', 1), d('C', 'transalp', 3));

// A and B clash, so for B: 1 own + 2 from A are all out at once -> 3 needed -> 0 left
assert.strictEqual(ba.bikesLeft('B', tours, demand, capacity).transalp, 0);
// For C: B ends 10 Apr +7 = 17 Apr, C starts 25 Apr -> no clash, only C's own 3 -> 0 left
assert.strictEqual(ba.bikesLeft('C', tours, demand, capacity).transalp, 0);
// Other models untouched
assert.strictEqual(ba.bikesLeft('B', tours, demand, capacity).crf1000, 3);
// Gap exactly 7 days is fine: A ends 21 Mar, D starts 28 Mar
var tours2 = tours.concat([{ id: 'D', Departure_Date: '2027-03-28', End_Date: '2027-04-05', Status: 'Confirmed' }]);
assert.strictEqual(ba.bikesLeft('D', tours2, d('A', 'transalp', 3), capacity).transalp, 3);
// Gap of 6 days clashes
var tours3 = tours.concat([{ id: 'E', Departure_Date: '2027-03-27', End_Date: '2027-04-05', Status: 'Confirmed' }]);
assert.strictEqual(ba.bikesLeft('E', tours3, d('A', 'transalp', 3), capacity).transalp, 0);
// A bike freed early is reused: P and R never overlap each other, target Q clashes with both by buffer
var t4 = [
  { id: 'P', Departure_Date: '2027-06-01', End_Date: '2027-06-10', Status: 'Confirmed' },
  { id: 'R', Departure_Date: '2027-06-28', End_Date: '2027-07-08', Status: 'Confirmed' },
  { id: 'Q', Departure_Date: '2027-06-12', End_Date: '2027-06-18', Status: 'Confirmed' }
];
assert.strictEqual(ba.bikesLeft('Q', t4, d('P', 'nx500', 2).concat(d('R', 'nx500', 2)), capacity).nx500, 1);
// Bookings filter
assert.strictEqual(ba.bikeDemandFromBooking({ Tour: { id: 'A' }, Booking_Status: 'Provisional', Participant_Type: 'Rider', Motorcycle_Preference: 'NX 500' }), null);
assert.strictEqual(ba.bikeDemandFromBooking({ Tour: { id: 'A' }, Booking_Status: 'Deposit Paid', Participant_Type: 'Pillion', Motorcycle_Preference: 'NX 500' }), null);
assert.strictEqual(ba.bikeDemandFromBooking({ Tour: { id: 'A' }, Booking_Status: 'Deposit Paid', Participant_Type: 'Rider', Motorcycle_Preference: 'Honda Africa Twin CRF1000', Allocated_Bike: 'Transalp (23-24)' }).model, 'transalp');
console.log('BIKE AVAILABILITY TESTS PASSED');
