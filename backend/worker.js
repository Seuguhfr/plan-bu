// =============================================================================
// 1. CONFIGURATION
// =============================================================================

const SITES = Object.freeze({
  "bua-st-serge": {
    slug: "bua-st-serge",
    name: "BU Saint-Serge",
    resourceIds: ["245", "665"],
    mapObject: "plan-bu.webp"
  },
  "bua-provisoire-belle-beille": {
    slug: "bua-provisoire-belle-beille",
    name: "BUA Provisoire Belle-Beille",
    resourceIds: ["5420", "5421"],
    mapObject: "map-belle-beille.webp"
  }
});

const DEFAULT_SITE = "bua-st-serge";
const CACHE_TTL = 60;

const BASE_UPSTREAM_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Cache-Control": "no-cache"
});

const SECURITY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json",
  "Cache-Control": `public, max-age=${CACHE_TTL}`,
  ...SECURITY_HEADERS
});

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const SEAT_REGEX = /^(\d+)/;

const KV_CACHES = new Map();
const KV_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory refresh window

function getTodayInFrance() {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function getSiteConfig(url) {
  const param = url.searchParams.get("site");
  if (param && SITES[param]) {
    return SITES[param];
  }
  return SITES[DEFAULT_SITE];
}

// =============================================================================
// 2. WORKER ENTRY POINT
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: SECURITY_HEADERS });
    }

    // Enforce GET requests for API endpoints
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: JSON_HEADERS
      });
    }

    // ---------------------------------------------------------
    // R2 IMAGE HANDLER
    // ---------------------------------------------------------
    if (url.pathname === "/assets/map.webp" || url.pathname === "/assets/map-belle-beille.webp") {
      let objectKey = "plan-bu.webp";
      if (url.pathname === "/assets/map-belle-beille.webp" || url.searchParams.get("site") === "bua-provisoire-belle-beille") {
        objectKey = "map-belle-beille.webp";
      }
      const object = await env.MAP_BUCKET.get(objectKey);
      if (object === null) {
        return new Response("Image Not Found", { status: 404, headers: SECURITY_HEADERS });
      }
      const headers = new Headers(SECURITY_HEADERS);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(object.body, { headers });
    }

    try {
      // ---------------------------------------------------------
      // SITES LIST HANDLER
      // ---------------------------------------------------------
      if (url.pathname === "/api/sites") {
        return new Response(JSON.stringify(SITES), { headers: JSON_HEADERS });
      }

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
        const siteConfig = getSiteConfig(url);
        const now = Date.now();
        let cached = KV_CACHES.get(siteConfig.slug);

        if (!cached || now > cached.expiry) {
          const fresh = await env.SEATS_KV.get(siteConfig.slug, { type: "json" });
          if (fresh) {
            cached = { data: fresh, expiry: now + KV_TTL_MS };
            KV_CACHES.set(siteConfig.slug, cached);
          }
        }

        if (!cached?.data) {
          return new Response(JSON.stringify({ error: `Seat config missing in KV for ${siteConfig.slug}` }), { status: 500, headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(cached.data), { headers: JSON_HEADERS });
      }

      return new Response(JSON.stringify({ error: "API Route Not Found" }), { status: 404, headers: JSON_HEADERS });

    } catch (error) {
      console.error("Worker unhandled error:", error);
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
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
  const siteConfig = getSiteConfig(url);
  const rawDate = url.searchParams.get("date");
  const dateParam = (rawDate && DATE_REGEX.test(rawDate)) ? rawDate : getTodayInFrance();
  
  // Normalized cache key: ignore extra arbitrary query params (e.g. cache busters)
  const cacheUrl = new URL(`${url.origin}${url.pathname}?site=${siteConfig.slug}&date=${dateParam}`);
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = caches.default;
  const forceRefresh = url.searchParams.get("force") === "true";
  let response;
  
  if (!forceRefresh) response = await cache.match(cacheKey);

  if (!response) {
    try {
      const result = await fetchAllUpstreamData(siteConfig, dateParam);
      if (result.isClosed || Object.keys(result.data).length === 0) {
        response = new Response(JSON.stringify({}), { headers: JSON_HEADERS, status: 200 });
      } else {
        response = new Response(JSON.stringify(result.data), { headers: JSON_HEADERS });
      }
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } catch (err) {
      console.error(`Upstream fetch error for ${siteConfig.slug}:`, err);
      return new Response(JSON.stringify({ error: "Upstream failure" }), { status: 503, headers: JSON_HEADERS });
    }
  }
  return response;
}

// =============================================================================
// 4. BACKEND LOGIC (Scraper)
// =============================================================================

async function fetchAllUpstreamData(siteConfig, targetDate) {
  const promises = siteConfig.resourceIds.map(id => fetchUpstreamDataForId(siteConfig.slug, targetDate, id));
  const results = await Promise.all(promises);
  let mergedData = Object.create(null);
  let allClosed = true;

  for (const res of results) {
    if (!res.isClosed) allClosed = false;
    Object.assign(mergedData, res.data);
  }
  return { data: mergedData, isClosed: allClosed };
}

async function fetchUpstreamDataForId(siteSlug, targetDate, typeId) {
  const targetUrl = `https://affluences.com/fr/sites/${siteSlug}/reservation?type=${encodeURIComponent(typeId)}&date=${encodeURIComponent(targetDate)}`;
  const headers = {
    ...BASE_UPSTREAM_HEADERS,
    "Referer": `https://affluences.com/fr/sites/${siteSlug}/reservation`
  };

  try {
    const resp = await fetch(targetUrl, { headers });
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

    const map = Object.create(null);
    if (resources.length > 0) parseResources(resources, map, typeId);
    return { data: map, isClosed: false };
  } catch (e) {
    console.error(`Fetch failed for ${siteSlug} type ${typeId}:`, e);
    throw e; 
  }
}

function parseResources(resources, map, typeId) {
  for (const res of resources) {
    if (!res || !res.resource_name) continue;
    const numMatch = res.resource_name.match(SEAT_REGEX);
    const seatId = numMatch ? numMatch[1] : res.resource_name.trim(); 
    if (!seatId || seatId === "__proto__" || seatId === "constructor" || seatId === "prototype") continue;

    const desc = (res.description || "").toLowerCase();
    const hasPlug = desc.includes("prise") && !desc.includes("proximit");
    const hasLight = desc.includes("lampe");
    const isComputer = desc.includes("ordinateur");
    const isGroup = (res.capacity && res.capacity > 1);
    
    const freeSlots = (res.hours || [])
      .filter(h => h.state === 'available')
      .map(h => h.hour.toString());

    if (!map[seatId]) {
      map[seatId] = {
        slots: freeSlots,
        hasPlug,
        hasLight,
        isComputer,
        isGroup,
        capacity: res.capacity || 1,
        resourceId: res.resource_id,
        resourceName: res.resource_name,
        typeId: typeId
      };
    }
  }
}