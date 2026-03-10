// =============================================================================
// 1. CONFIGURATION
// =============================================================================

const CONFIG = Object.freeze({
  siteSlug: "bua-st-serge",
  resourceIds: ["245", "665"],
  cacheTtl: 60
});

const UPSTREAM_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer": `https://affluences.com/fr/sites/${CONFIG.siteSlug}/reservation`,
  "Cache-Control": "no-cache"
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json",
  "Cache-Control": `public, max-age=${CONFIG.cacheTtl}`,
  ...CORS_HEADERS
});

const SEAT_REGEX = /^(\d+)/;
let KV_CACHE = null;

// =============================================================================
// 2. WORKER ENTRY POINT
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---------------------------------------------------------
    // R2 IMAGE HANDLER
    // ---------------------------------------------------------
    if (url.pathname === "/assets/map.webp") {
      const object = await env.MAP_BUCKET.get("plan-bu.webp");
      if (object === null) {
        return new Response("Image Not Found", { status: 404, headers: CORS_HEADERS });
      }
      const headers = new Headers(CORS_HEADERS);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(object.body, { headers });
    }

    try {
      // ---------------------------------------------------------
      // API HANDLER (Live Availability)
      // ---------------------------------------------------------
      if (url.pathname === "/api/load_day") {
        return await handleApiRequest(request, url, ctx);
      }

      // ---------------------------------------------------------
      // CONFIG HANDLER (Exposes KV data to the Frontend)
      // ---------------------------------------------------------
      if (url.pathname === "/api/config") {
        if (!KV_CACHE) {
          KV_CACHE = await env.SEATS_KV.get(CONFIG.siteSlug, { type: "json" });
        }
        if (!KV_CACHE) {
          return new Response(JSON.stringify({ error: "Seat config missing in KV" }), { status: 500, headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(KV_CACHE), { headers: JSON_HEADERS });
      }

      return new Response("API Route Not Found", { status: 404, headers: CORS_HEADERS });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: JSON_HEADERS
      });
    }
  }
};

// =============================================================================
// 3. ROUTE HANDLERS
// =============================================================================

async function handleApiRequest(request, url, ctx) {
  const cacheKey = new Request(url.toString(), request);
  const cache = caches.default;
  const forceRefresh = url.searchParams.get("force") === "true";
  let response;
  
  if (!forceRefresh) response = await cache.match(cacheKey);

  if (!response) {
    const dateParam = url.searchParams.get("date") || new Date().toISOString().split('T')[0];
    try {
      const result = await fetchAllUpstreamData(dateParam);
      if (result.isClosed || Object.keys(result.data).length === 0) {
        response = new Response(JSON.stringify({}), { headers: JSON_HEADERS, status: 200 });
      } else {
        response = new Response(JSON.stringify(result.data), { headers: JSON_HEADERS });
      }
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: "Upstream failure" }), { status: 503, headers: JSON_HEADERS });
    }
  }
  return response;
}

// =============================================================================
// 4. BACKEND LOGIC (Efficient Scraper)
// =============================================================================

async function fetchAllUpstreamData(targetDate) {
  const promises = CONFIG.resourceIds.map(id => fetchUpstreamDataForId(targetDate, id));
  const results = await Promise.all(promises);
  let mergedData = {};
  let allClosed = true;

  for (const res of results) {
    if (!res.isClosed) allClosed = false;
    Object.assign(mergedData, res.data);
  }
  return { data: mergedData, isClosed: allClosed };
}

async function fetchUpstreamDataForId(targetDate, typeId) {
  const targetUrl = `https://affluences.com/fr/sites/${CONFIG.siteSlug}/reservation?type=${typeId}&date=${targetDate}`;
  try {
    const resp = await fetch(targetUrl, { headers: UPSTREAM_HEADERS });
    if (!resp.ok) return { data: {}, isClosed: false };

    let jsonString = "";
    let isClosed = false;
    const rewriter = new HTMLRewriter()
      .on('script[id="ng-state"]', { text(chunk) { jsonString += chunk.text; } })
      .on('app-all-resources-closed-and-no-future', { element() { isClosed = true; } });

    await rewriter.transform(resp).text(); 

    if (isClosed) return { data: {}, isClosed: true };
    if (!jsonString) return { data: {}, isClosed: false };

    const rawData = JSON.parse(jsonString);
    if (!rawData || typeof rawData !== 'object') throw new Error("Invalid Upstream JSON");

    const resources = Object.values(rawData)
      .filter(val => val && Array.isArray(val.b) && val.b.length > 0)
      .flatMap(val => val.b);

    const map = {};
    if (resources.length > 0) parseResources(resources, map, typeId);
    return { data: map, isClosed: false };
  } catch (e) {
    console.error(`Fetch failed for type ${typeId}:`, e);
    throw e; 
  }
}

function parseResources(resources, map, typeId) {
  for (const res of resources) {
    if (!res.resource_name) continue;
    const numMatch = res.resource_name.match(SEAT_REGEX);
    const seatId = numMatch ? numMatch[1] : res.resource_name.trim(); 
    
    const desc = (res.description || "").toLowerCase();
    const hasPlug = desc.includes("prise") && !desc.includes("proximit");
    const hasLight = desc.includes("lampe");
    
    const freeSlots = (res.hours || [])
      .filter(h => h.state === 'available')
      .map(h => h.hour.toString());

    if (!map[seatId]) {
      map[seatId] = {
        slots: freeSlots,
        hasPlug,
        hasLight,
        resourceId: res.resource_id,
        typeId: typeId
      };
    }
  }
}