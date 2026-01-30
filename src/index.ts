// src/index.ts - FinnTrack Cloudflare Worker
// Handles: API endpoints, OwnTracks ingestion, WebSocket routing

import { RaceState } from "./raceState";
export { RaceState };

export interface Env {
  RACE_STATE: DurableObjectNamespace;
  HISTORY: KVNamespace;
  RACES: R2Bucket;
  OWNTRACKS_KEY?: string; // Optional shared key for OwnTracks authentication
}

// ============================================================
// CORS Headers
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    h.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h,
  });
}

function json(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    })
  );
}

function text(msg: string, status = 200): Response {
  return withCors(
    new Response(msg, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  );
}

// ============================================================
// Durable Object Stub Helper
// ============================================================

function stubForRace(env: Env, raceId: string): DurableObjectStub {
  const id = env.RACE_STATE.idFromName(raceId);
  return env.RACE_STATE.get(id);
}

// ============================================================
// Predefined Races (for dropdown population)
// ============================================================

function listPredefinedRaces() {
  const mkRaces = (series: string, prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      return {
        id: `${prefix}-2026-R${String(n).padStart(2, "0")}`,
        label: `${series} - Race ${n}`,
        series,
        raceNo: n,
      };
    });

  const ausNats = mkRaces("Australian Nationals 2026", "AUSNATS", 6);
  const goldCup = mkRaces("Gold Cup 2026", "GOLDCUP", 10);
  const masters = mkRaces("Finn World Masters 2026", "MASTERS", 8);
  const training = mkRaces("Training/Undefined", "TRAINING", 10);

  return {
    races: [...ausNats, ...goldCup, ...masters, ...training],
    series: [
      { id: "AUSNATS", name: "Australian Nationals 2026", raceCount: 6 },
      { id: "GOLDCUP", name: "Gold Cup 2026", raceCount: 10 },
      { id: "MASTERS", name: "Finn World Masters 2026", raceCount: 8 },
      { id: "TRAINING", name: "Training/Undefined", raceCount: 10 },
    ],
  };
}

// ============================================================
// OwnTracks Parsing
// ============================================================

function parseBasicAuth(req: Request): { user?: string; pass?: string } {
  const h = req.headers.get("Authorization");
  if (!h || !h.startsWith("Basic ")) return {};
  try {
    const raw = atob(h.slice(6));
    const i = raw.indexOf(":");
    if (i < 0) return { user: raw };
    return { user: raw.slice(0, i), pass: raw.slice(i + 1) };
  } catch {
    return {};
  }
}

function ownTracksToUpdatePayload(
  url: URL,
  body: any,
  authBoatId?: string
): {
  raceId: string;
  boatId: string;
  lat: number;
  lon: number;
  t: number;
  sog?: number;
  cog?: number;
  heading?: number;
  boatName?: string;
} | null {
  const raceId = String(url.searchParams.get("raceId") || "").trim();
  if (!raceId) return null;

  // boatId priority: Basic Auth username > query param > body fields
  const boatId =
    String(authBoatId || "").trim() ||
    String(url.searchParams.get("boatId") || "").trim() ||
    String(body?.boatId || "").trim() ||
    String(body?.userid || "").trim() ||
    String(body?.user || "").trim() ||
    String(body?.tid || "").trim() ||
    String(body?.deviceid || "").trim();

  if (!boatId) return null;

  const lat = Number(body?.lat);
  const lon = Number(body?.lon ?? body?.lng ?? body?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // OwnTracks uses tst in seconds; normalize to ms
  let t = Number(body?.tst ?? body?.t ?? Date.now() / 1000);
  if (!Number.isFinite(t)) t = Math.floor(Date.now() / 1000);
  if (t < 1e12) t = Math.floor(t * 1000); // Convert seconds to ms
  if (t > 1e15) t = Math.floor(t / 1000); // Handle microseconds

  const sog = Number(body?.vel ?? body?.sog ?? body?.speed);
  const cog = Number(body?.cog ?? body?.heading ?? body?.course);
  const heading = Number(body?.heading ?? body?.cog);
  const boatName = String(body?.name || url.searchParams.get("name") || "").trim() || undefined;

  return {
    raceId,
    boatId,
    lat,
    lon,
    t,
    ...(Number.isFinite(sog) ? { sog } : {}),
    ...(Number.isFinite(cog) ? { cog } : {}),
    ...(Number.isFinite(heading) ? { heading } : {}),
    ...(boatName ? { boatName } : {}),
  };
}

// ============================================================
// JSON Body Parser
// ============================================================

async function readJsonBody(request: Request): Promise<any> {
  const t = await request.text();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    throw new Error("Bad JSON");
  }
}

// ============================================================
// Main Worker Fetch Handler
// ============================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---------------------------------------------------------
    // CORS Preflight
    // ---------------------------------------------------------
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    // ---------------------------------------------------------
    // Health Check
    // ---------------------------------------------------------
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, service: "finntrack-api", timestamp: Date.now() });
    }

    // ---------------------------------------------------------
    // Race List (for dropdowns)
    // Supports both /race/list and /races for compatibility
    // ---------------------------------------------------------
    if (request.method === "GET" && (path === "/race/list" || path === "/races")) {
      return json(listPredefinedRaces());
    }

    // ---------------------------------------------------------
    // List Boats (legacy endpoint support)
    // ---------------------------------------------------------
    if (request.method === "GET" && path === "/listBoats") {
      const raceId = url.searchParams.get("raceId") || "";
      if (!raceId) return text("Missing raceId", 400);

      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = "/boats";

      const fwd = new Request(doUrl.toString(), request);
      return withCors(await stubForRace(env, raceId).fetch(fwd));
    }

    // ---------------------------------------------------------
    // List Races (legacy endpoint support)
    // ---------------------------------------------------------
    if (request.method === "GET" && path === "/listRaces") {
      return json(listPredefinedRaces());
    }

    // ---------------------------------------------------------
    // Positions (legacy endpoint for compatibility)
    // ---------------------------------------------------------
    if (request.method === "GET" && path === "/positions") {
      const raceId = url.searchParams.get("raceId") || "";
      if (!raceId) return text("Missing raceId", 400);

      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = "/boats";

      const fwd = new Request(doUrl.toString(), request);
      return withCors(await stubForRace(env, raceId).fetch(fwd));
    }

    // ---------------------------------------------------------
    // WebSocket Live Feed (supports both /live and /ws/live)
    // ---------------------------------------------------------
    if (path === "/live" || path === "/ws/live") {
      const raceId = url.searchParams.get("raceId") || "";
      if (!raceId) return text("Missing raceId", 400);

      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = "/ws/live";

      const fwd = new Request(doUrl.toString(), request);
      return stubForRace(env, raceId).fetch(fwd);
    }

    // ---------------------------------------------------------
    // Boats Endpoint
    // ---------------------------------------------------------
    if (request.method === "GET" && path === "/boats") {
      const raceId = url.searchParams.get("raceId") || "";
      if (!raceId) return text("Missing raceId", 400);

      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = "/boats";

      const fwd = new Request(doUrl.toString(), request);
      return withCors(await stubForRace(env, raceId).fetch(fwd));
    }

    // ---------------------------------------------------------
    // Join Race (register boat)
    // ---------------------------------------------------------
    if (request.method === "POST" && path === "/join") {
      let body: any;
      try {
        body = await readJsonBody(request);
      } catch {
        return text("Bad JSON", 400);
      }

      const raceId = String(body?.raceId || "");
      if (!raceId) return text("Missing raceId", 400);

      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = "/join";

      const fwd = new Request(doUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      return withCors(await stubForRace(env, raceId).fetch(fwd));
    }

    // ---------------------------------------------------------
    // Telemetry Update
    // ---------------------------------------------------------
    if (request.method === "POST" && path === "/update") {
      let body: any;
      try {
        body = await readJsonBody(request);
      } catch {
        return text("Bad JSON", 400);
      }

      const raceId = String(body?.raceId || "");
      if (!raceId) return text("Missing raceId", 400);

      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = "/update";

      const fwd = new Request(doUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      return withCors(await stubForRace(env, raceId).fetch(fwd));
    }

    // ---------------------------------------------------------
    // OwnTracks HTTP Ingestion
    // URL: POST /ingest/owntracks?raceId=AUSNATS-2026-R01
    // Basic Auth username = boatId
    // ---------------------------------------------------------
    if (path === "/ingest/owntracks") {
      if (request.method !== "POST") {
        return text("Method Not Allowed", 405);
      }

      // Optional shared key authentication
      if (env.OWNTRACKS_KEY) {
        const key = url.searchParams.get("key") || "";
        if (!key || key !== env.OWNTRACKS_KEY) {
          return text("Unauthorized", 401);
        }
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return text("Bad JSON", 400);
      }

      // OwnTracks sends various event types; only process location
      const eventType = String(body?._type || "").toLowerCase();
      if (eventType && eventType !== "location") {
        return json({ ok: true, skipped: true, reason: "non-location event" });
      }

      const { user: authBoatId } = parseBasicAuth(request);
      const updatePayload = ownTracksToUpdatePayload(url, body, authBoatId);

      if (!updatePayload) {
        return text("Missing raceId/boatId/lat/lon", 400);
      }

      const raceId = updatePayload.raceId;

      // Forward to Durable Object
      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = "/update";

      const fwd = new Request(doUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatePayload),
      });

      const resp = await stubForRace(env, raceId).fetch(fwd);
      return withCors(resp);
    }

    // ---------------------------------------------------------
    // Autocourse (placeholder - returns empty for now)
    // ---------------------------------------------------------
    if (request.method === "GET" && path === "/autocourse") {
      // Course data would be loaded from R2 or generated
      return json({
        startLine: null,
        finishLine: null,
        marks: [],
        coursePolygon: null,
        windDirection: null,
      });
    }

    // ---------------------------------------------------------
    // Replay Multi (placeholder)
    // ---------------------------------------------------------
    if (request.method === "GET" && (path === "/replay-multi" || path === "/replay")) {
      const raceId = url.searchParams.get("raceId") || "";
      if (!raceId) return text("Missing raceId", 400);

      // Would load from R2 archive
      return json({ raceId, boats: [], frames: [] });
    }

    // ---------------------------------------------------------
    // Export GPX
    // ---------------------------------------------------------
    if (request.method === "GET" && path === "/export/gpx") {
      const raceId = url.searchParams.get("raceId") || "";
      if (!raceId) return text("Missing raceId", 400);

      // Placeholder GPX
      const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FinnTrack">
  <metadata>
    <name>FinnTrack Race ${raceId}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
</gpx>`;

      return withCors(
        new Response(gpx, {
          status: 200,
          headers: {
            "Content-Type": "application/gpx+xml",
            "Content-Disposition": `attachment; filename="finntrack_${raceId}.gpx"`,
          },
        })
      );
    }

    // ---------------------------------------------------------
    // Export KML
    // ---------------------------------------------------------
    if (request.method === "GET" && path === "/export/kml") {
      const raceId = url.searchParams.get("raceId") || "";
      if (!raceId) return text("Missing raceId", 400);

      const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>FinnTrack Race ${raceId}</name>
  </Document>
</kml>`;

      return withCors(
        new Response(kml, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.google-earth.kml+xml",
            "Content-Disposition": `attachment; filename="finntrack_${raceId}.kml"`,
          },
        })
      );
    }

    // ---------------------------------------------------------
    // 404 for unmatched routes
    // ---------------------------------------------------------
    return text("Not found", 404);
  },
};
