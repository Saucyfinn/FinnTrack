/**
 * FinnTrack API Worker (FULL updated index.js)
 *
 * Adds:
 *  - GET/POST /traccar (ingest from Traccar Client)
 *    - expects deviceKey in query (?deviceKey=...)
 *    - supports optional raceId in query (?raceId=...)
 *    - forwards to Durable Object /_do/ingest
 *
 * Existing:
 *  - GET  /races                 -> R2:RACES/races.json
 *  - GET  /fleet                 -> R2:RACES/fleet.json
 *  - GET  /boats?raceId=...       -> DO snapshot
 *  - GET  /ws/live?raceId=...     -> DO websocket
 */

const STORAGE_KEY = "state";
const DEFAULT_RACE_ID = "aus-nats-2026";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...extra,
  };
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(extraHeaders),
    },
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders(extraHeaders),
    },
  });
}

async function r2Json(env, key) {
  const obj = await env.RACES.get(key);
  if (!obj) return null;
  const text = await obj.text();

  // Validate JSON so UI doesn’t silently fail.
  try {
    JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in R2 object "${key}": ${e?.message || e}`);
  }
  return text;
}

function getRaceId(url) {
  // Accept ?raceId= or ?race=
  return url.searchParams.get("raceId") || url.searchParams.get("race");
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function readBodyAsFormOrJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      const obj = {};
      for (const [k, val] of form.entries()) obj[k] = String(val);
      return obj;
    } catch {
      return null;
    }
  }
  // Fallback: try text (may be empty)
  try {
    const t = await request.text();
    if (!t) return null;
    // try parse as querystring
    const sp = new URLSearchParams(t);
    const obj = {};
    for (const [k, v] of sp.entries()) obj[k] = v;
    return Object.keys(obj).length ? obj : { raw: t };
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ---- Health / debug ----
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return jsonResponse({
        ok: true,
        service: "finntrack-api-worker",
        endpoints: [
          "/races",
          "/fleet",
          "/boats?raceId=...",
          "/ws/live?raceId=...",
          "/traccar?deviceKey=...&raceId=... (GET/POST)",
        ],
      });
    }

    // ---- Races list (R2) ----
    if (request.method === "GET" && path === "/races") {
      try {
        const body = await r2Json(env, "races.json");
        if (!body) {
          return jsonResponse(
            { error: "races.json not found in R2 bucket binding 'RACES'", expectedKey: "races.json" },
            404
          );
        }
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return jsonResponse({ error: "Failed to serve /races", detail: e?.message || String(e) }, 500);
      }
    }

    // ---- Fleet list (R2) ----
    if (request.method === "GET" && (path === "/fleet" || path === "/boats/fleet")) {
      try {
        const body = await r2Json(env, "fleet.json");
        if (!body) {
          return jsonResponse(
            { error: "fleet.json not found in R2 bucket binding 'RACES'", expectedKey: "fleet.json" },
            404
          );
        }
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return jsonResponse({ error: "Failed to serve /fleet", detail: e?.message || String(e) }, 500);
      }
    }

    // ---- TRACCAR INGEST (GET or POST) ----
    // Traccar Client normally sends GET with query params:
    //   ?id=DEVICE_ID&lat=...&lon=...&speed=...&course=...&timestamp=...
    // We require:
    //   ?deviceKey=YOUR_SECRET
    // Optional:
    //   ?raceId=aus-nats-2026
    if ((request.method === "GET" || request.method === "POST") && path === "/traccar") {
      const deviceKey = url.searchParams.get("deviceKey");
      if (!deviceKey || deviceKey !== env.DEVICE_API_KEY) {
        // Traccar clients typically just want any response; return 401 with text for clarity.
        return textResponse("UNAUTHORIZED", 401);
      }

      // Support raceId either in URL or default
      const raceId = url.searchParams.get("raceId") || DEFAULT_RACE_ID;

      // Collect params: URL params first; if POST, also merge body fields
      const params = Object.fromEntries(url.searchParams.entries());
      if (request.method === "POST") {
        const bodyObj = await readBodyAsFormOrJson(request);
        if (bodyObj && typeof bodyObj === "object") {
          for (const [k, v] of Object.entries(bodyObj)) params[k] = String(v);
        }
      }

      // Traccar param names can vary; handle common ones
      const deviceId = params.id || params.deviceid || params.deviceId || "unknown";
      const lat = safeNumber(params.lat || params.latitude);
      const lon = safeNumber(params.lon || params.lng || params.longitude);
      const speed = safeNumber(params.speed) ?? 0;
      const course = safeNumber(params.course || params.bearing) ?? 0;
      const ts = safeNumber(params.timestamp || params.time) ?? Date.now();

      if (lat === null || lon === null) {
        return textResponse("BAD_REQUEST", 400);
      }

      // Forward to Durable Object for this race
      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      const doUrl = new URL(request.url);
      doUrl.pathname = "/_do/ingest";
      // Keep only race routing in DO name; DO doesn’t need query params
      doUrl.search = "";

      const payload = {
        deviceId: String(deviceId),
        lat,
        lon,
        speed,
        course,
        ts,
        source: "traccar",
      };

      const resp = await stub.fetch(
        new Request(doUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );

      // Traccar expects plain "OK" on success
      if (resp.ok) return textResponse("OK", 200);

      const detail = await resp.text().catch(() => "");
      return textResponse(detail || "ERROR", 500);
    }

    // ---- WebSocket live feed (Durable Object) ----
    if (path === "/ws/live") {
      const raceId = getRaceId(url);
      if (!raceId) return jsonResponse({ error: "missing race id (use ?raceId=...)" }, 400);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);
      return stub.fetch(request);
    }

    // ---- Boats state (Durable Object) ----
    if (request.method === "GET" && path === "/boats") {
      const raceId = getRaceId(url);
      if (!raceId) return jsonResponse({ error: "missing race id (use ?raceId=...)" }, 400);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      const doUrl = new URL(request.url);
      doUrl.pathname = "/_do/boats";
      doUrl.search = "";
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // ---- Fallback ----
    return jsonResponse({ error: "Not found", path }, 404);
  },
};

/**
 * Durable Object: per-race state + websocket fanout
 * Supports:
 *  - GET  /ws/live     (websocket)
 *  - GET  /_do/boats   (snapshot)
 *  - POST /_do/ingest  (position updates)
 */
export class RaceState {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /** @type {Map<string, any>} */
    this.boats = new Map();
    /** @type {Set<WebSocket>} */
    this.sockets = new Set();

    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.state.storage.get(STORAGE_KEY);
    if (stored && stored.boats) {
      try {
        this.boats = new Map(stored.boats);
      } catch (_) {
        this.boats = new Map();
      }
    }
    this.loaded = true;
  }

  async persist() {
    await this.state.storage.put(STORAGE_KEY, {
      boats: Array.from(this.boats.entries()),
      updatedAt: Date.now(),
    });
  }

  broadcast(payloadObj) {
    const msg = JSON.stringify(payloadObj);
    for (const ws of this.sockets) {
      try {
        ws.send(msg);
      } catch (_) {
        // ignore
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    await this.load();

    // Ingest endpoint (called by Worker)
    if (request.method === "POST" && path === "/_do/ingest") {
      let data;
      try {
        data = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: "invalid JSON" }, 400);
      }

      const deviceId = String(data.deviceId || "unknown");
      const lat = Number(data.lat);
      const lon = Number(data.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return jsonResponse({ ok: false, error: "missing/invalid lat/lon" }, 400);
      }

      const boat = {
        id: deviceId,
        lat,
        lon,
        speed: Number.isFinite(Number(data.speed)) ? Number(data.speed) : 0,
        course: Number.isFinite(Number(data.course)) ? Number(data.course) : 0,
        ts: Number.isFinite(Number(data.ts)) ? Number(data.ts) : Date.now(),
        source: data.source || "traccar",
      };

      this.boats.set(deviceId, boat);
      await this.persist();
      this.broadcast({ type: "update", boat });

      return jsonResponse({ ok: true });
    }

    // WebSocket endpoint
    if (path === "/ws/live") {
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return textResponse("Expected WebSocket", 426);
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sockets.add(server);

      // Initial snapshot
      server.send(
        JSON.stringify({
          type: "snapshot",
          boats: Array.from(this.boats.values()),
          ts: Date.now(),
        })
      );

      server.addEventListener("close", () => {
        this.sockets.delete(server);
      });

      server.addEventListener("message", (evt) => {
        try {
          const data = typeof evt.data === "string" ? evt.data : "";
          if (data === "ping") server.send("pong");
        } catch (_) {}
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // Snapshot endpoint used by /boats in the Worker
    if (path === "/_do/boats") {
      return jsonResponse({
        boats: Array.from(this.boats.values()),
        count: this.boats.size,
        ts: Date.now(),
      });
    }

    return jsonResponse({ error: "Not found (DO)", path }, 404);
  }
}
