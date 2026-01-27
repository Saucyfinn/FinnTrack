// src/index.ts
import { RaceState } from "./raceState";
export { RaceState };

type Env = {
  RACE_STATE: DurableObjectNamespace;
  HISTORY: KVNamespace;
  RACES: R2Bucket;
  DB: D1Database;

  // Optional shared key for OwnTracks ingest.
  // If set, requests must include ?key=... matching this value.
  OWNTRACKS_KEY?: string;
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function withCors(resp: Response): Response {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: h,
  });
}

function getRaceIdFromUrl(url: URL): string | null {
  return url.searchParams.get("raceId");
}

function stubForRace(env: Env, raceId: string) {
  const id = env.RACE_STATE.idFromName(raceId);
  return env.RACE_STATE.get(id);
}

// Predefined race series for 2026
function listPredefinedRaces() {
  const mk = (series: string, prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      return {
        raceId: `${prefix}-2026-R${String(n).padStart(2, "0")}`,
        title: `${series} - Race ${n}`,
        series,
        raceNo: n,
      };
    });

  const ausNats = mk("Australian Nationals 2026", "AUSNATS", 6);
  const goldCup = mk("Gold Cup 2026", "GOLDCUP", 10);
  const masters = mk("Finn World Masters 2026", "MASTERS", 8);
  const training = mk("Training/Undefined", "TRAINING", 10);

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

/**
 * Map OwnTracks HTTP payload -> FinnTrack update payload.
 * We keep it tolerant because OwnTracks fields vary slightly.
 */
function ownTracksToUpdatePayload(
  url: URL,
  body: any
): { raceId: string; boatId: string; lat: number; lon: number; t: number; sog?: number; cog?: number; name?: string } | null {
  const raceId = String(url.searchParams.get("raceId") || "").trim();
  if (!raceId) return null;

  // Prefer boatId passed in query; otherwise fall back to OwnTracks fields.
  const boatId =
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

  // OwnTracks uses tst in *seconds* since epoch.
  // Some loggers might send ms; we normalize to seconds.
  let t = Number(body?.tst ?? body?.t ?? Date.now() / 1000);
  if (!Number.isFinite(t)) t = Math.floor(Date.now() / 1000);
  if (t > 1e12) t = Math.floor(t / 1000);

  // speed/heading
  const sog = Number(body?.vel ?? body?.sog ?? body?.speed);
  const cog = Number(body?.cog ?? body?.heading);

  const name = String(body?.name || url.searchParams.get("name") || "").trim() || undefined;

  return {
    raceId,
    boatId,
    lat,
    lon,
    t,
    ...(Number.isFinite(sog) ? { sog } : {}),
    ...(Number.isFinite(cog) ? { cog } : {}),
    ...(name ? { name } : {}),
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    // Redirect root and /finntrack to /finntrack.html
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/" || path === "/index.html" || path === "/finntrack") {
        const redirectUrl = new URL(request.url);
        redirectUrl.pathname = "/finntrack.html";
        return Response.redirect(redirectUrl.toString(), 302);
      }
    }

    // Race list
    if (request.method === "GET" && path === "/race/list") {
      return withCors(Response.json(listPredefinedRaces()));
    }

    // Health
    if (request.method === "GET" && path === "/health") {
      return withCors(new Response("ok", { status: 200 }));
    }

    // --- OwnTracks ingest (NEW) ---
    // OwnTracks HTTP mode posts JSON. We'll forward it into the Race DO /update.
    if (path === "/ingest/owntracks") {
      if (request.method !== "POST") {
        return withCors(new Response("Method Not Allowed", { status: 405 }));
      }

      // Optional shared key check (only enforced if OWNTRACKS_KEY is set)
      if (env.OWNTRACKS_KEY) {
        const key = url.searchParams.get("key") || "";
        if (!key || key !== env.OWNTRACKS_KEY) {
          return withCors(new Response("Unauthorized", { status: 401 }));
        }
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return withCors(new Response("Bad JSON", { status: 400 }));
      }

      // OwnTracks sends several event types; we only accept location-like payloads.
      const t = String(body?._type || "").toLowerCase();
      if (t && t !== "location") {
        // Ignore non-location events but respond 200 so OwnTracks stays happy.
        return withCors(new Response("ok", { status: 200 }));
      }

      const updatePayload = ownTracksToUpdatePayload(url, body);
      if (!updatePayload) {
        return withCors(new Response("Missing raceId/boatId/lat/lon", { status: 400 }));
      }

      const raceId = updatePayload.raceId;

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
      // We always return 200-ish if DO accepted; pass through status for debugging
      return withCors(resp);
    }

    // WebSocket live feed for a race (DO handles upgrade)
    if (path === "/ws/live") {
      const raceId = getRaceIdFromUrl(url);
      if (!raceId) return withCors(new Response("Missing raceId", { status: 400 }));
      // Don't wrap WebSocket responses in CORS - pass through directly
      return stubForRace(env, raceId).fetch(request);
    }

    // Read-only endpoints served by DO
    if (
      path === "/boats" ||
      path === "/replay-multi" ||
      path === "/autocourse" ||
      path === "/export/gpx" ||
      path === "/export/kml"
    ) {
      const raceId = getRaceIdFromUrl(url);
      if (!raceId) return withCors(new Response("Missing raceId", { status: 400 }));

      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = path;

      return withCors(await stubForRace(env, raceId).fetch(new Request(doUrl.toString(), request)));
    }

    // Update endpoint: POST body forwarded into DO
    if (request.method === "POST" && path === "/update") {
      const bodyText = await request.text();
      let parsed: any;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        return withCors(new Response("Bad JSON", { status: 400 }));
      }

      const raceId = String(parsed?.raceId || "");
      if (!raceId) return withCors(new Response("Missing raceId", { status: 400 }));

      const doUrl = new URL(request.url);
      doUrl.protocol = "https:";
      doUrl.host = "do";
      doUrl.pathname = "/update";

      const fwd = new Request(doUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyText,
      });

      return withCors(await stubForRace(env, raceId).fetch(fwd));
    }

    return withCors(new Response("Not found", { status: 404 }));
  },
};

