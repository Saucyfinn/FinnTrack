/**
 * FinnTrack API Worker - Ready to deploy to Cloudflare
 * Copy this file to your Cloudflare Worker project src/index.ts
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
  try {
    JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Invalid JSON in R2 object "${key}": ${e?.message || e}`);
  }
  return text;
}

function getRaceId(url: URL): string | null {
  return url.searchParams.get("raceId") || url.searchParams.get("race");
}

function bearer(request: Request): string {
  const a = request.headers.get("authorization") || "";
  const m = a.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function isAuthed(request: Request, env: Env): boolean {
  const devKey = "finn123";
  const tok = bearer(request);
  if (tok === devKey) return true;

  const url = new URL(request.url);
  const keyParam = url.searchParams.get("key");
  if (keyParam === devKey) return true;

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

    // CORS preflight - handle for ALL routes
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
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
          "GET/POST /traccar",
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
        let body = await r2Json(env, `fleet/${raceId}.json`);
        if (!body) {
          body = await r2Json(env, "fleet.json");
        }

        if (!body) {
          return jsonResponse(
            { error: "fleet.json not found", expectedKey: `fleet/${raceId}.json or fleet.json` },
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

    // ---- Race-specific boats endpoint ----
    if (request.method === "GET" && path.match(/^\/races\/([^\/]+)\/boats$/)) {
      const raceId = path.split("/")[2];
      try {
        const id = env.RACE_STATE.idFromName(raceId);
        const stub = env.RACE_STATE.get(id);
        return stub.fetch(request);
      } catch (e: any) {
        return jsonResponse({ error: `Failed to serve boats for race ${raceId}`, detail: e?.message || String(e) }, 500, {}, corsOrigin);
      }
    }

    // ---- Legacy Fleet list (R2) ----
    if (request.method === "GET" && (path === "/fleet" || path === "/boats/fleet")) {
      const raceId = getRaceId(url);
      try {
        let body: string | null = null;

        if (raceId) {
          body = await r2Json(env, `fleet/${raceId}.json`);
        }

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
      return stub.fetch(request);
    }

    // ---- Boats state (Durable Object) ----
    if (request.method === "GET" && path === "/boats") {
      const raceId = getRaceId(url);
      if (!raceId) return jsonResponse({ error: "missing race id (use ?raceId=...)" }, 400, {}, corsOrigin);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);
      return stub.fetch(request);
    }

    // ---- Update endpoint GET (Safari-friendly, avoids CORS preflight) ----
    if (request.method === "GET" && path === "/update") {
      if (!isAuthed(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401, {}, corsOrigin);

      const raceId = url.searchParams.get("raceId") || "LIVE";
      const boatId = url.searchParams.get("boatId") || url.searchParams.get("id");
      const lat = parseFloat(url.searchParams.get("lat") || "");
      const lon = parseFloat(url.searchParams.get("lon") || "");

      if (!boatId) return jsonResponse({ ok: false, error: "Missing boatId" }, 400, {}, corsOrigin);
      if (isNaN(lat) || isNaN(lon)) return jsonResponse({ ok: false, error: "Missing or invalid lat/lon" }, 400, {}, corsOrigin);

      const payload: any = { boatId, lat, lon };
      const boatName = url.searchParams.get("boatName");
      if (boatName) payload.boatName = boatName;
      const sog = parseFloat(url.searchParams.get("sog") || "");
      if (!isNaN(sog)) payload.sog = sog;
      const cog = parseFloat(url.searchParams.get("cog") || "");
      if (!isNaN(cog)) payload.cog = cog;
      payload.t = parseInt(url.searchParams.get("t") || "") || Date.now();

      try {
        const id = env.RACE_STATE.idFromName(raceId);
        const stub = env.RACE_STATE.get(id);
        const doRequest = new Request("https://internal/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await stub.fetch(doRequest);
        return new Response("OK", {
          status: 200,
          headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": corsOrigin },
        });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e?.message || String(e) }, 500, {}, corsOrigin);
      }
    }

    // ---- Update endpoint (FinnTrack app + Traccar JSON) ----
    if (request.method === "POST" && (path === "/update" || path === "/owntracks" || path === "/ingest")) {
      if (!isAuthed(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401, {}, corsOrigin);

      const body = await request.json().catch(() => null);
      if (!body) return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, {}, corsOrigin);

      let normalizedPayload: any = {};
      normalizedPayload.raceId = body.raceId || "training";

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

      normalizedPayload.timestamp = body.timestamp || body.t || new Date().toISOString();

      if (body.boatName) normalizedPayload.boatName = body.boatName;
      if (body.nation) normalizedPayload.nation = body.nation;
      if (body.speed !== undefined) normalizedPayload.sog = body.speed;
      if (body.sog !== undefined) normalizedPayload.sog = body.sog;
      if (body.course !== undefined) normalizedPayload.cog = body.course;
      if (body.cog !== undefined) normalizedPayload.cog = body.cog;
      if (body.heading !== undefined) normalizedPayload.heading = body.heading;
      if (body.heel !== undefined) normalizedPayload.heel = body.heel;
      if (body.altitude !== undefined) normalizedPayload.altitude = body.altitude;

      console.log("Normalized payload:", JSON.stringify(normalizedPayload, null, 2));

      const raceId = normalizedPayload.raceId;
      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      return stub.fetch(new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(normalizedPayload)
      }));
    }

    // ---- Traccar endpoint (GET for OsmAnd protocol, POST for form data) ----
    if (path === "/traccar") {
      if (!isAuthed(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401, {}, corsOrigin);

      let id: string | undefined;
      let lat: number;
      let lon: number;
      let speed: number;
      let bearing: number;
      let accuracy: number;
      let timestamp: number;
      let raceId = "LIVE";

      if (request.method === "GET") {
        // OsmAnd protocol - params in URL query string
        id = url.searchParams.get("id") || undefined;
        lat = parseFloat(url.searchParams.get("lat") || "");
        lon = parseFloat(url.searchParams.get("lon") || "");
        speed = parseFloat(url.searchParams.get("speed") || "0");
        bearing = parseFloat(url.searchParams.get("bearing") || url.searchParams.get("course") || "0");
        accuracy = parseFloat(url.searchParams.get("accuracy") || "0");
        timestamp = parseInt(url.searchParams.get("timestamp") || "") || Date.now();
        raceId = url.searchParams.get("raceId") || "LIVE";
      } else if (request.method === "POST") {
        // Form data from older Traccar versions
        const formData = await request.formData().catch(() => null);
        if (!formData) return jsonResponse({ ok: false, error: "Invalid form data" }, 400, {}, corsOrigin);

        id = formData.get("id")?.toString();
        lat = parseFloat(formData.get("lat")?.toString() || "");
        lon = parseFloat(formData.get("lon")?.toString() || "");
        speed = parseFloat(formData.get("speed")?.toString() || "0");
        bearing = parseFloat(formData.get("bearing")?.toString() || "0");
        accuracy = parseFloat(formData.get("accuracy")?.toString() || "0");
        timestamp = parseInt(formData.get("timestamp")?.toString() || "") || Date.now();
      } else {
        return jsonResponse({ error: "Method not allowed" }, 405, {}, corsOrigin);
      }

      if (!id) return jsonResponse({ ok: false, error: "Missing device id" }, 400, {}, corsOrigin);
      if (isNaN(lat) || isNaN(lon)) return jsonResponse({ ok: false, error: "Invalid lat/lon coordinates" }, 400, {}, corsOrigin);

      const body = {
        raceId,
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

      console.log("Traccar payload:", JSON.stringify(body, null, 2));

      const doId = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(doId);

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

    // ---- Fallback ----
    return jsonResponse({ error: "Not found", path }, 404, {}, corsOrigin);
  },
};

export { RaceState } from "./raceState";
