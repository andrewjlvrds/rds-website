var zoho = require("./_zoho.js");
var getZohoToken = zoho.getZohoToken;
var zohoSearch = zoho.zohoSearch;
var ZOHO_API = zoho.ZOHO_API;
var corsHeaders = zoho.corsHeaders;

// Convert DD/MM/YYYY or D/M/YYYY to YYYY-MM-DD for Zoho
function toZohoDate(s) {
  if (!s) return null;
  if (s.indexOf("/") !== -1) {
    var parts = s.split("/");
    return parts[2] + "-" + parts[1].padStart(2, "0") + "-" + parts[0].padStart(2, "0");
  }
  return s; // already YYYY-MM-DD
}

// Tour type mapping: form tour name → Zoho Tour_Type pick list value
var TOUR_TYPE_MAP = {
  "Feast of Southern Africa: 21 days": "FoSA 21",
  "Feast of Southern Africa: 16 days": "FoSA 16",
  "Feast of Southern Africa: 15 days": "FoSA 16", // legacy label, product renamed 16-day 2026-08-19
  "Edge of Africa: 14 days": "Edge 14",
  "Edge of Africa: 12 days": "Edge 12",
  "Best of Namibia": "BoN",
  "Best of Namibia: 17 days": "BoN",
  "Best of Namibia: 15 days": "BoN", // legacy: pre-17-day form submissions
  "Best of Namibia: 14 days": "BoN", // legacy: pre-rename form submissions
  "Best of Namibia: 13 days": "BoN", // legacy: pre-rename form submissions
  "Southern Sweep: 14 days": "SST 14",
  "Great Lakes & Rift Valley: 24 days": "GL 24",
  "Great Lakes & Rift Valley: 14 days": "GL 14",
};

// Motorcycle preference mapping: form value → Zoho Motorcycle_Preference pick list
var BIKE_MAP = {
  "crf1000": "Honda Africa Twin CRF1000",
  "transalp": "Honda Transalp 750",
  "nx500": "Honda NX500",
  "crf1100": "Honda Africa Twin CRF1100",
  "bmw1250gs": "BMW 1250GS",
  "own": "Own Bike",
};

// Zoho single-line text fields cap at 255 chars. A rider writing a paragraph in
// any free-text box used to hard-fail the whole submission with INVALID_DATA
// (four confirmed consecutive failures, 18 Aug 2026). Never lose a booking to a
// long answer: store the capped value on the field, keep the full text, and
// write it to a Note on the record so nothing the rider typed is discarded.
var ZOHO_TEXT_MAX = 255;
function capText(overflow, label, value) {
  var v = (value == null ? "" : String(value)).trim();
  if (v.length <= ZOHO_TEXT_MAX) return v;
  overflow.push({ label: label, text: v });
  return v.substring(0, ZOHO_TEXT_MAX - 3) + "...";
}

module.exports = async function handler(req, res) {
  // CORS
  var headers = corsHeaders();
  for (var key in headers) {
    res.setHeader(key, headers[key]);
  }
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    var body = req.body;
    if (!body || !body.email || !body.tour) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    // Departure date is only collected by the form for FULL tours. The 1-Day,
    // "one of the other tours" and Custom categories never collect one, so a
    // blanket departureDate requirement rejected every one of those
    // submissions with "Missing required fields" (fixed 2026-08-18).
    var FULL_TOUR_CATEGORIES = { feast: 1, edge21: 1, edge14: 1, sst: 1, bon: 1 };
    if (FULL_TOUR_CATEGORIES[body.tourCategory] && !body.departureDate) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    var token = await getZohoToken();

    // ── 1. Search Tours module for matching tour record ──
    // Map tour variant to Zoho Tour_Type
    var VARIANT_TYPE_MAP = {
      "feast-21": "FoSA 21",
      "feast-16": "FoSA 21",
      "feast-15": "FoSA 21", // legacy id; 16-day hop-off rides the FoSA 21 departure
      "feast-20": "FoSA 20",
      "edge-21": "Edge 21",
      "edge-14": "Edge 14",
      "sst-14": "SST 14",
      "edge-13": "Edge 13 SWD",   // legacy: pre-rename form submissions
      "edge-12": "Edge 12",
      "bon-14": "BoN",
      "bon-13": "BoN"  // legacy: pre-rename form submissions
    };
    var tourType = VARIANT_TYPE_MAP[body.tourVariant] || TOUR_TYPE_MAP[body.tour] || "";
    var tourRecordId = null;

    if (tourType && body.departureDate) {
      var depDate = toZohoDate(body.departureDate);
      try {
        var tourSearchResp = await zohoSearch(
          token,
          "Tours",
          "((Tour_Type:equals:" + tourType + ") and (Departure_Date:equals:" + depDate + "))"
        );
        if (tourSearchResp && tourSearchResp.data && tourSearchResp.data.length > 0) {
          tourRecordId = tourSearchResp.data[0].id;
        }
      } catch (e) {
        console.error("Tour search failed:", e.message);
        // Non-fatal — booking still created without tour link
      }
    }

    // ── 2. Build the Booking record ──
    var bikeKey = body.bike || "";
    var isUpgradeCRF = bikeKey === "crf1100";
    var isUpgradeBMW = bikeKey === "bmw1250gs";
    var hasRoommate = body.sharedRoomName && body.sharedRoomName.trim() !== "";
    var hasPillion = body.addPillion === "Yes";

    var overflow = [];

    var bookingName = (body.firstName || "").trim() + " " + (body.lastName || "").trim();
    // Add tour short code and date to make it unique
    var shortTour = tourType || body.tour.substring(0, 10);
    var zohoDate = toZohoDate(body.departureDate) || "";
    var shortDate = zohoDate ? (zohoDate.substring(5, 7) + "/" + zohoDate.substring(2, 4)) : "enquiry";
    var ts = Date.now().toString(36);
    bookingName = bookingName + " - " + shortTour + " " + shortDate + " " + ts;

    var record = {
      Name: bookingName,
      First_Name: (body.firstName || "").trim(),
      Last_Name: (body.lastName || "").trim(),
      Email: (body.email || "").trim(),
      Phone_1: (body.phone || "").trim(),
      Nationality1: body.country || "",

      // Tour fields
      Which_Tour: capText(overflow, "Which tour", body.tour),
      Tour_Name: body.tour || "",
      // Free-text intent from 1-Day / "other tours" / Custom rows (empty for full tours)
      Booking_Notes: capText(overflow, "What they asked for", body.customDescription),
      Departure_Dates: body.departureDate || "",
      Tour_start_date: toZohoDate(body.departureDate),
      Tour_end_date: toZohoDate(body.tourEndDate),

      // Room
      Are_you_sharing_a_room: hasRoommate ? "Yes" : "No",
      Roommate_Name: hasRoommate ? capText(overflow, "Roommate name", body.sharedRoomName) : "",
      Room_Preference_2: body.roomType || "Single",

      // Pillion
      Pillion: hasPillion ? "Yes" : "No",

      // Motorcycle
      CRF1100_Upgrade: isUpgradeCRF ? "Yes" : "No",
      BMW1250_Upgrade: isUpgradeBMW ? "Yes" : "No",

      // Pricing
      Tour_Price: parseFloat(body.basePrice) || 0,
      Shared_Room_Discount: Math.abs(parseFloat(body.sharedRoomDiscount) || 0),
      Bike_Upgrade_Notes: isUpgradeCRF ? "CRF1100" : (isUpgradeBMW ? "BMW 1250GS" : ""),
      Pillion1: parseFloat(body.pillionAmount) || 0,

      // Riding experience
      How_many_years_riding: body.yearsRiding || "",
      Bike_and_Gear_Notes: capText(overflow, "Bike and gear experience", body.bikeExperience),
      Previous_Adventure_Riding_Experience: capText(overflow, "Previous adventure riding", body.previousTours),
      Tar_Roads_Experience: body.onroad || "",
      Gravel_Roads_Experience: body.offroad || "",
      Do_you_have_a_bike_licence: body.licence ? "Yes" : "No",
      // NOTE: Zoho's api_name carries a typo ("limitiations"). Writing the
      // correctly-spelled name silently discarded every rider's medical answer.
      Any_physical_or_medical_limitiations: capText(overflow, "Physical or medical limitations", body.medical),
      Anything_else_we_should_know: capText(overflow, "Anything else we should know", body.anythingElse),

      // Attribution
      How_did_you_find_out_about_RDS: capText(overflow, "How they found RDS", body.referral),

      // T&Cs
      Waiver_Signed: body.terms === true,
      T_s_and_C_s_checked: body.terms ? "Yes" : "No",

      // Participant type — use form value directly if provided, otherwise infer
      Participant_Type: body.participantType || (hasPillion ? "Rider + Pillion" : "Rider"),

      // Auto-set
      Booking_Date: new Date().toISOString().split("T")[0],
      Booking_Status: "New Booking",
    };

    // Picklists reject empty strings — only set when we have a real value
    if (BIKE_MAP[bikeKey]) {
      record.Motorcycle_Preference = BIKE_MAP[bikeKey];
    }

    // Link to Tour record if found
    if (tourRecordId) {
      record.Tour = { id: tourRecordId };
    }

    // Set pillion amount
    if (hasPillion && body.pillionAmount) {
      record.Pillion1 = parseFloat(body.pillionAmount) || 0;
    }

    // Set motorcycle upgrade amounts
    if (isUpgradeCRF && body.upgradeAmount) {
      record.Motorcycle_Upgrade_Honda_Africa_Twin_CRF1100 = parseFloat(body.upgradeAmount) || 0;
    }
    if (isUpgradeBMW && body.upgradeAmount) {
      record.Motorcycle_Upgrade_BMW_1250GS = parseFloat(body.upgradeAmount) || 0;
    }

    // ── 3. Create the Booking in Zoho ──
    var createResp = await fetch(ZOHO_API + "/Bookings", {
      method: "POST",
      headers: {
        "Authorization": "Zoho-oauthtoken " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: [record] }),
    });
    var createResult = await createResp.json();

    if (!createResult.data || !createResult.data[0] || createResult.data[0].code !== "SUCCESS") {
      console.error("Booking creation failed:", JSON.stringify(createResult));
      return res.status(500).json({
        error: "Booking creation failed",
        detail: createResult.data ? createResult.data[0] : createResult,
      });
    }

    var bookingId = createResult.data[0].details.id;

    // ── 3b. Preserve any answer that had to be capped ──
    if (overflow.length > 0) {
      try {
        var noteBody = "The rider's full answers, as typed. Zoho caps these fields at "
          + ZOHO_TEXT_MAX + " characters, so the record above shows a shortened version.\n\n"
          + overflow.map(function (o) { return o.label + ":\n" + o.text; }).join("\n\n");
        // ZOHO_API is the v2 base, which requires the flat Parent_Id + se_module
        // shape. The v8 nested { id, module } form is rejected here with
        // MANDATORY_NOT_FOUND $se_module — verified live 18 Aug 2026.
        var noteResp = await fetch(ZOHO_API + "/Notes", {
          method: "POST",
          headers: {
            "Authorization": "Zoho-oauthtoken " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: [{
              Note_Title: "Full booking form answers (long text)",
              Note_Content: noteBody.substring(0, 30000),
              Parent_Id: bookingId,
              se_module: "Bookings",
            }],
          }),
        });
        var noteResult = await noteResp.json();
        if (!noteResult.data || noteResult.data[0].code !== "SUCCESS") {
          console.error("Overflow note rejected:", JSON.stringify(noteResult));
        }
      } catch (e) {
        // Non-fatal — the booking exists; only the verbatim overflow copy is at risk
        console.error("Overflow note failed:", e.message);
      }
    }

    // ── 4. Lead source attribution — search Contacts/Leads by email ──
    try {
      var email = (body.email || "").trim();
      if (email) {
        var contactSearch = await zohoSearch(token, "Contacts", "(Email:equals:" + email + ")");
        var leadSource = null;

        if (contactSearch.data && contactSearch.data.length > 0) {
          leadSource = contactSearch.data[0].Lead_Source;
        } else {
          // Try Leads module
          var leadSearch = await zohoSearch(token, "Leads", "(Email:equals:" + email + ")");
          if (leadSearch.data && leadSearch.data.length > 0) {
            leadSource = leadSearch.data[0].Lead_Source;
          }
        }

        if (leadSource) {
          // PATCH the booking with the lead source
          await fetch(ZOHO_API + "/Bookings/" + bookingId, {
            method: "PUT",
            headers: {
              "Authorization": "Zoho-oauthtoken " + token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: [{ id: bookingId, Lead_Source: leadSource }],
            }),
          });
        }
      }
    } catch (e) {
      // Non-fatal — booking is already created
      console.error("Lead source lookup failed:", e.message);
    }

    // ── 5. Return success ──
    return res.status(200).json({
      success: true,
      bookingId: bookingId,
      tourLinked: !!tourRecordId,
      truncatedFields: overflow.length,
    });

  } catch (err) {
    console.error("Submit booking error:", err.message, err.stack);
    return res.status(500).json({
      error: "Something went wrong. Please email ride@ridedownsouth.com",
      detail: err.message,
    });
  }
}


