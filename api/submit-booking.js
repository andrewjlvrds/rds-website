var zoho = require("./_zoho.js");
var getZohoToken = zoho.getZohoToken;
var zohoSearch = zoho.zohoSearch;
var ZOHO_API = zoho.ZOHO_API;
var corsHeaders = zoho.corsHeaders;

// Tour type mapping: form tour name → Zoho Tour_Type pick list value
var TOUR_TYPE_MAP = {
  "Feast of Southern Africa: 21 days": "FoSA 21",
  "Feast of Southern Africa: 16 days": "FoSA 16",
  "Feast of Southern Africa: 15 days": "FoSA 15",
  "Edge of Africa: 14 days": "Edge 14",
  "Edge of Africa: 12 days": "Edge 12",
  "Best of Namibia: 13 days": "BoN",
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
    if (!body || !body.email || !body.tour || !body.departureDate) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    var token = await getZohoToken();

    // ── 1. Search Tours module for matching tour record ──
    var tourType = TOUR_TYPE_MAP[body.tour] || "";
    var tourRecordId = null;

    if (tourType && body.departureDate) {
      // Departure date comes as "2027-03-20" from the form
      var depDate = body.departureDate; // already YYYY-MM-DD
      try {
        var tourSearch = await zohoSearch(
          token,
          "Tours",
          "((Tour_Type:equals:" + tourType + ") and (Departure_Date:equals:" + depDate + "))"
        );
        if (tourSearch.data && tourSearch.data.length > 0) {
          tourRecordId = tourSearch.data[0].id;
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

    var bookingName = (body.firstName || "").trim() + " " + (body.lastName || "").trim();
    // Add tour short code and date to make it unique
    var shortTour = tourType || body.tour.substring(0, 10);
    var shortDate = body.departureDate.substring(5, 7) + "/" + body.departureDate.substring(2, 4);
    bookingName = bookingName + " - " + shortTour + " " + shortDate;

    var record = {
      Name: bookingName,
      First_Name: (body.firstName || "").trim(),
      Last_Name: (body.lastName || "").trim(),
      Email: (body.email || "").trim(),
      Phone_1: (body.phone || "").trim(),
      Nationality: body.country || "",

      // Tour fields
      Which_Tour: body.tour || "",
      Tour_Name: body.tour || "",
      Departure_Dates: body.departureDate || "",
      Tour_start_date: body.departureDate || null,
      Tour_end_date: body.tourEndDate || null,

      // Room
      Are_you_sharing_a_room: hasRoommate ? "Yes" : "No",
      Roommate_Name: hasRoommate ? body.sharedRoomName.trim() : "",

      // Pillion
      Pillion: hasPillion ? "Yes" : "No",

      // Motorcycle
      Motorcycle_Preference: BIKE_MAP[bikeKey] || "",
      CRF1100_Upgrade: isUpgradeCRF ? "Yes" : "No",
      BMW1250_Upgrade: isUpgradeBMW ? "Yes" : "No",

      // Pricing
      Tour_Price: parseFloat(body.basePrice) || 0,
      Bike_Upgrade_Amount: parseFloat(body.upgradeAmount) || 0,
      Shared_Room_Discount: parseFloat(body.sharedRoomDiscount) || 0,
      Pillion1: parseFloat(body.pillionAmount) || 0,

      // Riding experience
      How_many_years_riding: body.yearsRiding || "",
      Bike_and_Gear_Notes: body.bikeExperience || "",
      Previous_Adventure_Riding_Experience: body.previousTours || "",
      Tar_Roads_Experience: body.onroad || "",
      Gravel_Roads_Experience: body.offroad || "",
      Do_you_have_a_bike_licence: body.licence ? "Yes" : "No",
      Seat_height_ok: body.seatHeight || "",
      Any_physical_or_medical_limitations: body.medical || "",
      Anything_else_we_should_know: body.anythingElse || "",

      // Attribution
      How_did_you_find_out_about_RDS: body.referral || "",

      // T&Cs
      Waiver_Signed: body.terms === true,

      // Auto-set
      Booking_Date: new Date().toISOString().split("T")[0],
      Booking_Status: "New Booking",
    };

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
    });

  } catch (err) {
    console.error("Submit booking error:", err.message, err.stack);
    return res.status(500).json({
      error: "Something went wrong. Please email andrew@ridedownsouth.com",
      detail: err.message,
    });
  }
}

