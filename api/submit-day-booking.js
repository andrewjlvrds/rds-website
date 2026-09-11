// api/submit-day-booking.js — POST from /book-day (public one-day tour request).
// Creates ONE Bookings record per paying rider (Zoho convention: a booking is a
// person), all sharing Day_Group_Ref, each carrying its own Day_Quote_Snapshot.
//
// Pricing gate: while day-pricing CONFIG.status === 'proposed', no Tour_Price is
// written — Tour_Price_Notes says "Quote pending" and the proposed figure sits
// in the snapshot for Andrew to confirm on approval. When 'published', the
// snapshot total is written to Tour_Price (day_Ride_Amount mirrors it).
//
// Native Zoho workflows are SUPPRESSED on create (trigger: []) so the multi-day
// "Booking form confirmation" template (signed Darren, promises deposit
// details) never goes to a one-day guest. This endpoint sends its own one-day
// acknowledgement (from Andrew <ride@>, no deposit promise) and an internal
// "New Tour Booking" notification to ride@ in the same shape the client-ops
// new-bookings inbox already parses. Multi-day bookings via /book are untouched.
//
// testMode (secret-gated, ?secret=CRON_SECRET): records are named "TEST …",
// no guest email is sent, and the created ids are returned for read-back + delete.
var zoho = require("./_zoho.js");
var pricing = require("./day-pricing.js");

var TOUR_NAME = "1-Day Tour from Cape Town";
var ZOHO_TEXT_MAX = 255;
var MEETING_POINT = "Unit 16, Prime Park, Montague Gardens, Cape Town";
var MAP_URL = "https://maps.app.goo.gl/Xgf64s13rpLVeiM39?g_st=aw";

function cap(s, n) { s = (s == null ? "" : String(s)).trim(); return s.length > (n || ZOHO_TEXT_MAX) ? s.substring(0, (n || ZOHO_TEXT_MAX) - 3) + "..." : s; }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || ""); }
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function fmtR(n) { return "R" + Number(n).toLocaleString("en-ZA"); }
function fmtDate(iso) {
  var d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getDay()] + " " + d.getDate() + " " + ["January","February","March","April","May","June","July","August","September","October","November","December"][d.getMonth()] + " " + d.getFullYear();
}
function groupRef() { return "DAY-" + new Date().toISOString().slice(2, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase(); }

// Emails are sent by rds-client-ops (which holds the ride@ Gmail OAuth):
// POST /api/day/notify with the shared DAY_BRIDGE_KEY. Never throws.
async function bridgeNotify(payload) {
  try {
    if (!process.env.DAY_BRIDGE_KEY) return { ok: false, error: "DAY_BRIDGE_KEY missing on rds-website" };
    var r = await fetch("https://rds-client-ops.vercel.app/api/day/notify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.DAY_BRIDGE_KEY }, body: JSON.stringify(payload) });
    var j = await r.json().catch(function () { return {}; });
    return { ok: r.ok, status: r.status, result: j };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = async function handler(req, res) {
  var h = zoho.corsHeaders(); for (var k in h) res.setHeader(k, h[k]);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  var b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { return res.status(400).json({ error: "Bad JSON" }); } }
  if ((b.hp_field || "").trim() !== "") return res.status(200).json({ success: true });

  var testMode = !!(b.testMode && process.env.DAY_BRIDGE_KEY && b.secret === process.env.DAY_BRIDGE_KEY);
  var first = cap(b.firstName, 100), last = cap(b.lastName, 100), email = cap(b.email, 100).toLowerCase(), phone = cap(b.phone, 30);
  var country = cap(b.country, 80), date = String(b.date || "").slice(0, 10), altDates = cap(b.altDates, 255);
  var routeId = String(b.route || "help"), route = pricing.routeById(routeId) || pricing.routeById("help");
  var riders = Array.isArray(b.riders) ? b.riders.slice(0, 8) : [];
  var pillion = b.pillion === true || b.pillion === "Yes";
  var notes = cap(b.notes, 255), fullNotes = String(b.notes || "").trim();
  var experience = cap(b.experience, 255), ownBike = cap(b.ownBike, 255), licence = !!b.licence, licenceNo = cap(b.licenceNumber, 50);
  var gear = cap(b.gear, 255), medical = cap(b.medical, 255), emergency = cap(b.emergency, 255), referral = cap(b.referral, 255);
  var consent = !!b.consent, terms = !!b.terms, submissionId = cap(b.submissionId, 60);

  if (!first || !last) return res.status(400).json({ error: "Please enter your first and last name." });
  if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!phone) return res.status(400).json({ error: "Please enter a phone/WhatsApp number." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) return res.status(400).json({ error: "Please choose a date." });
  if (Date.parse(date) < Date.now() - 86400000) return res.status(400).json({ error: "That date is in the past." });
  if (!riders.length || riders.length > 8) return res.status(400).json({ error: "Please add between 1 and 8 riders." });
  if (!terms) return res.status(400).json({ error: "Please accept the terms to continue." });
  for (var i = 0; i < riders.length; i++) {
    riders[i] = { name: cap(riders[i].name, 100), bike: String(riders[i].bike || "none") };
    if (!pricing.bikeById(riders[i].bike)) riders[i].bike = "none";
    if (i > 0 && !riders[i].name) return res.status(400).json({ error: "Please give a name for rider " + (i + 1) + "." });
  }
  riders[0].name = riders[0].name || (first + " " + last);

  var q = pricing.quote(route.id, riders.map(function (r) { return r.bike; }));
  var published = pricing.CONFIG.status === "published";
  var ref = groupRef();
  var prefix = testMode ? "TEST " : "";

  try {
    var token = await zoho.getZohoToken();
    // Idempotency: same submissionId already created → return it.
    if (submissionId && !testMode) {
      try {
        var dup = await zoho.zohoSearch(token, "Bookings", "((Email:equals:" + email + ")and(Tour_start_date:equals:" + date + "))");
        var hit = (dup && dup.data || []).filter(function (r) { return r.Day_Group_Ref && String(r.Booking_Notes || "").indexOf("[sid:" + submissionId + "]") !== -1; })[0];
        if (hit) return res.status(200).json({ success: true, duplicate: true, groupRef: hit.Day_Group_Ref, bookingIds: [hit.id] });
      } catch (e) {}
    }

    var created = [];
    for (var r = 0; r < riders.length; r++) {
      var rq = q.riders[r];
      var isLead = r === 0;
      var nm = riders[r].name.split(/\s+/);
      var rFirst = isLead ? first : nm[0], rLast = isLead ? last : (nm.slice(1).join(" ") || "(group of " + first + " " + last + ")");
      var snapshot = JSON.stringify({ v: q.version, s: q.status, route: q.route, riders: q.payingRiders, bike: rq.bike, base: rq.base, pct: rq.discountPct, disc: rq.discount, sup: rq.supplement, total: rq.total });
      var rec = {
        Name: prefix + rFirst + " " + rLast + " - 1-Day Tour " + date.slice(5, 7) + "/" + date.slice(2, 4) + " " + Date.now().toString(36),
        First_Name: rFirst, Last_Name: rLast,
        Email: isLead ? email : email,           // group riders share the organiser's email until they supply their own
        Phone_1: phone, Nationality1: country || undefined,
        Which_Tour: TOUR_NAME, Tour_Name: TOUR_NAME,
        Tour_start_date: date, Tour_end_date: date,
        Booking_Date: new Date().toISOString().slice(0, 10),
        Booking_Status: "New Booking", Booking_Approved: false,
        Participant_Type: "Rider", Pillion: (isLead && pillion) ? "Yes" : "No",
        Payment_Method: "Card Payment (PoS)",
        Day_Route: route.zoho, Day_Group_Ref: ref, Day_Quote_Snapshot: snapshot.slice(0, 255),
        Booking_Notes: cap((isLead ? "" : "Group rider " + (r + 1) + " of " + riders.length + " (organiser " + first + " " + last + "). ") + (altDates ? "Alt dates: " + altDates + ". " : "") + fullNotes + (submissionId ? " [sid:" + submissionId + "]" : ""), 255),
        Tour_Price_Notes: published ? ("Day tour quote " + q.version + ": " + fmtR(rq.total) + " (" + rq.bikeLabel + (rq.discountPct ? ", " + rq.discountPct + "% group" : "") + ")")
          : ("Quote pending - proposed " + (rq.total != null ? fmtR(rq.total) : "TBC") + " per pricing " + q.version + " (NOT approved). Andrew to confirm price before confirmation."),
        Bike_and_Gear_Notes: cap((ownBike ? "Own bike: " + ownBike + ". " : "") + (gear ? "Gear needed: " + gear : ""), 255),
        Previous_Adventure_Riding_Experience: experience || undefined,
        Do_you_have_a_bike_licence: licence ? "Yes" : "No", License: licenceNo || undefined,
        Any_physical_or_medical_limitiations: medical || undefined,
        Emergency_Contact: emergency || undefined,
        How_did_you_find_out_about_RDS: referral || undefined,
        Communication_Consent: consent, T_s_and_C_s_checked: terms ? "Yes" : "No", Waiver_Signed: false
      };
      if (rq.bikeZoho) rec.Motorcycle_Preference = rq.bikeZoho;
      if (published && rq.total != null) rec.Tour_Price = rq.total; // NOT day_Ride_Amount (multi-day add-on, summed into Total_Amount_Due)
      Object.keys(rec).forEach(function (k) { if (rec[k] === undefined || rec[k] === "") delete rec[k]; });
      var cr = await fetch(zoho.ZOHO_API + "/Bookings", { method: "POST", headers: { Authorization: "Zoho-oauthtoken " + token, "Content-Type": "application/json" }, body: JSON.stringify({ data: [rec], trigger: [] }) });
      var cj = await cr.json();
      var d0 = cj && cj.data && cj.data[0];
      if (!d0 || d0.code !== "SUCCESS") { console.error("day booking create failed", JSON.stringify(cj)); return res.status(500).json({ error: "Booking creation failed", detail: d0 || cj, createdSoFar: created }); }
      created.push(d0.details.id);
    }

    // Acknowledgement to guest + internal notification, via client-ops (ride@ Gmail).
    var mail = await bridgeNotify({
      testMode: testMode, groupRef: ref, bookingIds: created,
      guest: { firstName: first, lastName: last, email: email, phone: phone },
      date: date, routeLabel: route.base ? route.label : (route.id === "custom" ? "Custom route" : null), routeZoho: route.zoho,
      riders: riders.map(function (x) { return { name: x.name, bike: pricing.bikeById(x.bike).label }; }),
      quote: { status: q.status, version: q.version, groupTotal: q.groupTotal }
    });

    return res.status(200).json({ success: true, groupRef: ref, bookingIds: created, quote: q, priceStatus: q.status, mail: mail, testMode: testMode });
  } catch (err) {
    console.error("submit-day-booking error:", err.message);
    return res.status(500).json({ error: "Something went wrong. Please email ride@ridedownsouth.com", detail: err.message });
  }
};
