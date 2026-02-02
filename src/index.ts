/**
 * FinnTrack API Worker (drop-in index.js)
 *
 * Endpoints:
 *  - GET  / -> service info and list of endpoints
 *  - GET  /debug/r2 -> list keys in R2 bucket
 *  - GET  /races -> returns R2:RACES/races.json
 *  - GET  /races/:raceId/fleet -> returns fleet for specific race
 *  - GET  /races/:raceId/boats -> returns boats with live state from DO
 *  - GET  /fleet?raceId=... -> legacy fleet endpoint
 *  - GET  /boats?raceId=... -> legacy boats endpoint
 *  - WebSocket /ws/live?raceId=... -> live updates
 *  - WebSocket /live?raceId=... -> legacy live endpoint
 *  - POST /update, /owntracks, /traccar, /ingest -> position updates
 */

export interface Env {
  HISTORY: KVNamespace;
  HISTORY_PREVIEW: KVNamespace;
  RACES: R2Bucket;
  DB: D1Database;
  API_SECRET: string;
  DEVICE_API_KEY?: string;
  SHARE?: string;
  CORS_ORIGIN: string;
  RACE_STATE: DurableObjectNamespace;
}

function jsonResponse(obj: any, status = 200, extraHeaders: Record<string, string> = {}, corsOrigin = "*"): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...extraHeaders,
    },
  });
}

function textResponse(text: string, status = 200, extraHeaders: Record<string, string> = {}, corsOrigin = "*"): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...extraHeaders,
    },
  });
}

async function r2Json(env: Env, key: string): Promise<string | null> {
  const obj = await env.RACES.get(key);
  if (!obj) return null;
  const text = await obj.text();
  // Validate it is JSON so UI doesn't silently fail.
  try {
    JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Invalid JSON in R2 object "${key}": ${e?.message || e}`);
  }
  return text;
}

function getRaceId(url: URL): string | null {
  // Accept either ?raceId=xxx or ?race=xxx to be forgiving
  return url.searchParams.get("raceId") || url.searchParams.get("race");
}

function bearer(request: Request): string {
  const a = request.headers.get("authorization") || "";
  const m = a.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function isAuthed(request: Request, env: Env): boolean {
  // For dev mode, just check against finn123 or any configured key
  const devKey = "finn123";

  // Check Bearer token first
  const tok = bearer(request);
  if (tok === devKey) return true;

  // Check query param ?key=... for Traccar clients
  const url = new URL(request.url);
  const keyParam = url.searchParams.get("key");
  if (keyParam === devKey) return true;

  // Also check against API_SECRET if it exists and isn't the long hash
  if (env.API_SECRET && env.API_SECRET.length < 50) {
    if (tok === env.API_SECRET || keyParam === env.API_SECRET) return true;
  }

  return false;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsOrigin = env.CORS_ORIGIN || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // ---- Health / debug ----
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return jsonResponse({
        ok: true,
        service: "finntrack-api-worker",
        endpoints: [
          "GET /races",
          "GET /races/:raceId/fleet",
          "GET /races/:raceId/boats",
          "GET /fleet?raceId=...",
          "GET /boats?raceId=...",
          "GET /debug/r2",
          "WebSocket /ws/live?raceId=...",
          "WebSocket /live?raceId=...",
          "POST /update",
          "POST /owntracks",
          "POST /traccar",
          "POST /ingest"
        ],
      }, 200, {}, corsOrigin);
    }

    // ---- Debug R2 listing ----
    if (request.method === "GET" && path === "/debug/r2") {
      try {
        const prefix = url.searchParams.get("prefix") || "";
        const options: R2ListOptions = { prefix };
        const result = await env.RACES.list(options);

        return jsonResponse({
          ok: true,
          bucket: "RACES",
          prefix,
          objects: result.objects.map(obj => ({
            key: obj.key,
            size: obj.size,
            uploaded: obj.uploaded?.toISOString()
          })),
          truncated: result.truncated,
          cursor: result.cursor
        }, 200, {}, corsOrigin);
      } catch (e: any) {
        return jsonResponse({
          error: "Failed to list R2 bucket",
          detail: e?.message || String(e)
        }, 500, {}, corsOrigin);
      }
    }

    // ---- Races list (R2) ----
    if (request.method === "GET" && path === "/races") {
      try {
        const body = await r2Json(env, "races.json");
        if (!body) {
          return jsonResponse(
            { error: "races.json not found in R2 bucket binding 'RACES'", expectedKey: "races.json" },
            404, {}, corsOrigin
          );
        }
        // Return file as-is (it can be { races: [...] } or [...] — frontend should handle)
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": corsOrigin,
          },
        });
      } catch (e: any) {
        return jsonResponse({ error: "Failed to serve /races", detail: e?.message || String(e) }, 500, {}, corsOrigin);
      }
    }

    // ---- New Race-specific fleet endpoint ----
    if (request.method === "GET" && path.match(/^\/races\/([^\/]+)\/fleet$/)) {
      const raceId = path.split("/")[2];
      try {
        // Try race-specific fleet first (fleet/raceId.json), then fallback to global fleet.json
        let body = await r2Json(env, `fleet/${raceId}.json`);
        if (!body) {
          body = await r2Json(env, "fleet.json");
        }

        if (!body) {
          return jsonResponse(
            { error: `Fleet data not found for race ${raceId}`, checkedKeys: [`fleet/${raceId}.json`, "fleet.json"] },
            404, {}, corsOrigin
          );
        }

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": corsOrigin,
          },
        });
      } catch (e: any) {
        return jsonResponse({ error: `Failed to serve fleet for race ${raceId}`, detail: e?.message || String(e) }, 500, {}, corsOrigin);
      }
    }

    // ---- New Race-specific boats endpoint (fleet + live state) ----
    if (request.method === "GET" && path.match(/^\/races\/([^\/]+)\/boats$/)) {
      const raceId = path.split("/")[2];
      const within = url.searchParams.get("within");

      try {
        // Get fleet data first
        let fleetBody = await r2Json(env, `fleet/${raceId}.json`);
        if (!fleetBody) {
          fleetBody = await r2Json(env, "fleet.json");
        }

        if (!fleetBody) {
          return jsonResponse(
            { error: `Fleet data not found for race ${raceId}` },
            404, {}, corsOrigin
          );
        }

        // Get live state from Durable Object
        const id = env.RACE_STATE.idFromName(raceId);
        const stub = env.RACE_STATE.get(id);

        // Build URL with within parameter if provided
        const doUrl = new URL(request.url);
        doUrl.pathname = "/boats";
        if (within) {
          doUrl.searchParams.set("within", within);
        }

        const doResponse = await stub.fetch(new Request(doUrl.toString(), {
          method: "GET",
          headers: request.headers
        }));

        if (!doResponse.ok) {
          return jsonResponse(
            { error: `Failed to get live state for race ${raceId}`, status: doResponse.status },
            500, {}, corsOrigin
          );
        }

        const liveData = await doResponse.json();
        const fleet = JSON.parse(fleetBody);

        // Merge fleet with live data
        const boats = liveData.boats || [];
        const fleetArray = Array.isArray(fleet) ? fleet : fleet.fleet || [];

        // Add active flag based on live status
        const mergedBoats = boats.map((boat: any) => ({
          ...boat,
          active: boat.live || false
        }));

        return jsonResponse({
          ok: true,
          raceId,
          now: liveData.now || Date.now(),
          boats: mergedBoats,
          fleetCount: fleetArray.length
        }, 200, {}, corsOrigin);

      } catch (e: any) {
        return jsonResponse({ error: `Failed to serve boats for race ${raceId}`, detail: e?.message || String(e) }, 500, {}, corsOrigin);
      }
    }

    // ---- Legacy Fleet list (R2) ----
    if (request.method === "GET" && (path === "/fleet" || path === "/boats/fleet")) {
      const raceId = getRaceId(url);
      try {
        let body: string | null = null;

        // If raceId is provided, try race-specific fleet first
        if (raceId) {
          body = await r2Json(env, `fleet/${raceId}.json`);
        }

        // Fallback to global fleet.json
        if (!body) {
          body = await r2Json(env, "fleet.json");
        }

        if (!body) {
          return jsonResponse(
            { error: "fleet.json not found in R2 bucket binding 'RACES'", expectedKey: "fleet.json" },
            404, {}, corsOrigin
          );
        }
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": corsOrigin,
          },
        });
      } catch (e: any) {
        return jsonResponse({ error: "Failed to serve /fleet", detail: e?.message || String(e) }, 500, {}, corsOrigin);
      }
    }

    // ---- WebSocket live feed (Durable Object) ----
    if (path === "/ws/live" || path === "/live") {
      const raceId = getRaceId(url);
      if (!raceId) return jsonResponse({ error: "missing race id (use ?raceId=...)" }, 400, {}, corsOrigin);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      // Forward the request to the DO (it will upgrade if it's a websocket)
      return stub.fetch(request);
    }

    // ---- Boats state (Durable Object) ----
    if (request.method === "GET" && path === "/boats") {
      const raceId = getRaceId(url);
      if (!raceId) return jsonResponse({ error: "missing race id (use ?raceId=...)" }, 400, {}, corsOrigin);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      // Forward to the DO with proper path
      return stub.fetch(request);
    }

    // ---- Update endpoint (FinnTrack app + Traccar JSON) ----
    if (request.method === "POST" && (path === "/update" || path === "/owntracks" || path === "/ingest")) {
      if (!isAuthed(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401, {}, corsOrigin);

      const body = await request.json().catch(() => null);
      if (!body) return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, {}, corsOrigin);

      // Normalize the payload to FinnTrack format
      let normalizedPayload: any = {};

      // 1. Handle raceId - default to "training" if not provided
      normalizedPayload.raceId = body.raceId || "training";

      // 2. Map boatId from various possible fields
      let boatId: string | undefined;
      if (body.boatId) {
        boatId = String(body.boatId);
      } else if (body.id) {
        boatId = String(body.id);
      } else if (body.uniqueId) {
        boatId = String(body.uniqueId);
      }

      if (!boatId) {
        return jsonResponse({ ok: false, error: "Missing boatId" }, 400, {}, corsOrigin);
      }
      normalizedPayload.boatId = boatId;

      // 3. Map latitude/longitude coordinates
      let lat: number | undefined;
      let lon: number | undefined;

      if (typeof body.lat === "number" && typeof body.lon === "number") {
        lat = body.lat;
        lon = body.lon;
      } else if (typeof body.latitude === "number" && typeof body.longitude === "number") {
        lat = body.latitude;
        lon = body.longitude;
      }

      if (lat === undefined || lon === undefined) {
        return jsonResponse({ ok: false, error: "Missing or invalid lat/lon coordinates" }, 400, {}, corsOrigin);
      }
      normalizedPayload.lat = lat;
      normalizedPayload.lon = lon;

      // 4. Add timestamp - use provided or current time
      normalizedPayload.timestamp = body.timestamp || body.t || new Date().toISOString();

      // 5. Copy other optional fields that might be present
      if (body.boatName) normalizedPayload.boatName = body.boatName;
      if (body.nation) normalizedPayload.nation = body.nation;
      if (body.speed !== undefined) normalizedPayload.sog = body.speed;
      if (body.sog !== undefined) normalizedPayload.sog = body.sog;
      if (body.course !== undefined) normalizedPayload.cog = body.course;
      if (body.cog !== undefined) normalizedPayload.cog = body.cog;
      if (body.heading !== undefined) normalizedPayload.heading = body.heading;
      if (body.heel !== undefined) normalizedPayload.heel = body.heel;
      if (body.altitude !== undefined) normalizedPayload.altitude = body.altitude;

      // Console log the final normalized payload
      console.log("Normalized payload:", JSON.stringify(normalizedPayload, null, 2));

      const raceId = normalizedPayload.raceId;
      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      // Forward to the DO with proper path
      return stub.fetch(new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(normalizedPayload)
      }));
    }

    // ---- Traccar endpoint (form data) ----
    if (request.method === "POST" && path === "/traccar") {
      if (!isAuthed(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401, {}, corsOrigin);

      const formData = await request.formData().catch(() => null);
      if (!formData) return jsonResponse({ ok: false, error: "Invalid form data" }, 400, {}, corsOrigin);

      // Parse Traccar fields
      const id = formData.get("id")?.toString();
      const lat = parseFloat(formData.get("lat")?.toString() || "");
      const lon = parseFloat(formData.get("lon")?.toString() || "");
      const speed = parseFloat(formData.get("speed")?.toString() || "0");
      const bearing = parseFloat(formData.get("bearing")?.toString() || "0");
      const accuracy = parseFloat(formData.get("accuracy")?.toString() || "0");
      const timestamp = parseInt(formData.get("timestamp")?.toString() || "") || Date.now();

      // Validation
      if (!id) return jsonResponse({ ok: false, error: "Missing device id" }, 400, {}, corsOrigin);
      if (isNaN(lat) || isNaN(lon)) return jsonResponse({ ok: false, error: "Invalid lat/lon coordinates" }, 400, {}, corsOrigin);

      // Map to existing update format
      const body = {
        raceId: "traccar", // Default race for Traccar devices
        boatId: id,
        boatName: `Device ${id}`,
        lat,
        lon,
        t: timestamp,
        sog: !isNaN(speed) ? speed : undefined,
        cog: !isNaN(bearing) ? bearing : undefined,
        heading: !isNaN(bearing) ? bearing : undefined,
        accuracy: !isNaN(accuracy) ? accuracy : undefined
      };

      const raceId = "traccar";
      const doId = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(doId);

      // Forward to the DO with proper path
      return stub.fetch(new Request(request.url.replace("/traccar", "/update"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }));
    }

    // ---- GET help for endpoints ----
    if (request.method === "GET" && path === "/update") {
      return jsonResponse({
        endpoint: "/update",
        method: "POST",
        description: "Update boat position for FinnTrack app",
        auth: "Bearer token in Authorization header or ?key=... query param",
        contentType: "application/json",
        requiredFields: ["raceId", "boatId", "lat", "lon"],
        optionalFields: ["boatName", "nation", "t", "sog", "cog", "heading", "heel"]
      }, 200, {}, corsOrigin);
    }

    if (request.method === "GET" && path === "/traccar") {
      return jsonResponse({
        endpoint: "/traccar",
        method: "POST",
        description: "Accept Traccar Client position updates",
        auth: "?key=... query parameter (Traccar clients can't send headers)",
        contentType: "application/x-www-form-urlencoded",
        requiredFields: ["id", "lat", "lon"],
        optionalFields: ["speed", "bearing", "accuracy", "timestamp"],
        note: "Automatically maps to race 'traccar'"
      }, 200, {}, corsOrigin);
    }

    // ---- Fallback ----
    return jsonResponse({ error: "Not found", path }, 404, {}, corsOrigin);
  },
};

// Export RaceState from the separate module
export { RaceState } from "./raceState";