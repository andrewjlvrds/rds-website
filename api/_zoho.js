var ZOHO_API = "https://www.zohoapis.com/crm/v2";
var BLOB_API = "https://blob.vercel-storage.com";
var TOKEN_PREFIX = "zoho-token-cache";

// In-memory cache (works within same invocation)
var tokenCache = { access_token: null, expires_at: 0 };

// Prevent concurrent refresh attempts
var refreshPromise = null;

// --- Blob-based persistent token cache ---

async function readBlobToken() {
  var blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return null;
  try {
    var listResp = await fetch(BLOB_API + "?prefix=" + TOKEN_PREFIX, {
      headers: { "Authorization": "Bearer " + blobToken },
    });
    if (!listResp.ok) return null;
    var listing = await listResp.json();
    if (!listing.blobs || listing.blobs.length === 0) return null;
    var dataResp = await fetch(listing.blobs[0].url);
    if (!dataResp.ok) return null;
    return await dataResp.json();
  } catch(e) {
    return null;
  }
}

async function writeBlobToken(accessToken, expiresAt) {
  var blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return;
  try {
    // Delete ALL existing token blobs first
    var listResp = await fetch(BLOB_API + "?prefix=" + TOKEN_PREFIX, {
      headers: { "Authorization": "Bearer " + blobToken },
    });
    if (listResp.ok) {
      var listing = await listResp.json();
      if (listing.blobs && listing.blobs.length > 0) {
        await fetch(BLOB_API + "/delete", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + blobToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ urls: listing.blobs.map(function (b) { return b.url; }) }),
        });
      }
    }
    // Write new token
    await fetch(BLOB_API + "/" + TOKEN_PREFIX + ".json", {
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + blobToken,
        "x-api-version": "7",
        "x-content-type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt }),
    });
  } catch(e) {
    console.error("Blob token write failed:", e.message);
  }
}

// --- Token refresh ---

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
  writeBlobToken(data.access_token, expiresAt).catch(function() {});
  return data.access_token;
}

// --- Public API ---

async function getZohoToken() {
  // Layer 1: In-memory
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) {
    return tokenCache.access_token;
  }
  // Layer 2: Blob Storage
  var blobData = await readBlobToken();
  if (blobData && blobData.access_token && Date.now() < blobData.expires_at) {
    tokenCache.access_token = blobData.access_token;
    tokenCache.expires_at = blobData.expires_at;
    return blobData.access_token;
  }
  // Layer 3: Refresh (deduplicated)
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

export { getZohoToken, zohoFetch, zohoSearch, corsHeaders, ZOHO_API };
