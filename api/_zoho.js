var ZOHO_API = "https://www.zohoapis.com/crm/v2";

var tokenCache = { access_token: null, expires_at: 0 };
var refreshPromise = null;

async function refreshToken() {
  var params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  var resp = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  var data = await resp.json();
  if (!data.access_token) {
    throw new Error("Token refresh failed: " + JSON.stringify(data));
  }
  var expiresAt = Date.now() + 3000000;
  tokenCache.access_token = data.access_token;
  tokenCache.expires_at = expiresAt;
  return data.access_token;
}

async function getZohoToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) {
    return tokenCache.access_token;
  }
  if (!refreshPromise) {
    refreshPromise = refreshToken().then(function(t) {
      refreshPromise = null;
      return t;
    }).catch(function(err) {
      refreshPromise = null;
      throw err;
    });
  }
  return refreshPromise;
}

async function zohoFetch(token, path) {
  var resp = await fetch(ZOHO_API + path, {
    headers: { "Authorization": "Zoho-oauthtoken " + token },
  });
  return await resp.json();
}

// v8 variant: rollup fields (e.g. Tours.Riders) are NOT returned by the v2
// records API via fields= — they come back undefined. v8 returns them.
// Added 2026-07-11 for tour-availability places_available. Additive only;
// do not repoint existing v2 consumers without testing.
var ZOHO_API_V8 = "https://www.zohoapis.com/crm/v8";
async function zohoFetchV8(token, path) {
  var resp = await fetch(ZOHO_API_V8 + path, {
    headers: { "Authorization": "Zoho-oauthtoken " + token },
  });
  return await resp.json();
}

async function zohoSearch(token, module, criteria) {
  var url = ZOHO_API + "/" + module + "/search?criteria=" + encodeURIComponent(criteria);
  var resp = await fetch(url, {
    headers: { "Authorization": "Zoho-oauthtoken " + token },
  });
  return await resp.json();
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

module.exports = { getZohoToken: getZohoToken, zohoFetch: zohoFetch, zohoFetchV8: zohoFetchV8, zohoSearch: zohoSearch, corsHeaders: corsHeaders, ZOHO_API: ZOHO_API };
