// src/index.ts

export interface Env {
  // Durable Object
  RACE_STATE: DurableObjectNamespace;

  // Optional storage (bindings can be absent; code won’t crash)
  HISTORY?: KVNamespace;
  HISTORY_PREVIEW?: KVNamespace;

  // Optional buckets/db
  RACES?: R2Bucket;
  DB?: D1Database;

  // Optional secrets / vars
  API_KEY?: string;      // if set, require ?key= or x-api-key
  CORS_ORIGIN?: string;  // default "*"
}

type BoatUpdate = {
  boatId?: string;
  name?: string;
  raceId?: string;

  lat: number;
  lon: number;

  speed?: number;
  heading?: number;
  accuracy?: number;
  timestamp?: number;

  source?: string;
};

function json(data: any, env: Env, status = 200) {
  const origin = env.CORS_ORIGIN || "*";
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-API-Key",
      "access-control-max-age": "86400",
    },
  });
}

function ok(env: Env, status = 200) {
  const origin = env.CORS_ORIGIN || "*";
  return new Response(null, {
    status,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-API-Key",
      "access-control-max-age": "86400",
    },
  });
}

function requireAuth(request: Request, env: Env) {
  const apiKey = env.API_KEY && env.API_KEY !== "YOUR_SECRET_API_KEY" ? env.API_KEY : null;
  if (!apiKey) return true;

  const url = new URL(request.url);
  const key = url.searchParams.get("key") || request.headers.get("x-api-key");
  return key === apiKey;
}

function toRaceId(url: URL) {
  // allow raceId= or liveRaceId=
  return url.searchParams.get("raceId") || url.searchParams.get("liveRaceId") || "";
}

function stableBoatId(u: BoatUpdate) {
  if (u.boatId && String(u.boatId).trim()) return String(u.boatId).trim();
  return "";
}

/**
 * Durable Object: RaceState
 * - stores latest position per boatId for a raceId
 * - supports /_fleet, /_boats, /_update, /_ws
 */
export class RaceStateDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return ok(this.env, 204);

    if (path === "/_fleet" && request.method === "GET") {
      const data = await this.state.storage.get<Record<string, any>>("fleet");
      return json({ ok: true, raceId: url.searchParams.get("raceId"), fleet: data || {} }, this.env);
    }

    if (path === "/_boats" && request.method === "GET") {
      const fleet = (await this.state.storage.get<Record<string, any>>("fleet")) || {};
      const boats = Object.keys(fleet).sort();
      return json({ ok: true, boats }, this.env);
    }

    if (path === "/_update" && request.method === "POST") {
      const body = (await request.json()) as BoatUpdate;
      const boatId = stableBoatId(body) || "unknown";
      const now = Date.now();

      const fleet = (await this.state.storage.get<Record<string, any>>("fleet")) || {};
      fleet[boatId] = {
        boatId,
        name: body.name || boatId,
        raceId: body.raceId,
        lat: body.lat,
        lon: body.lon,
        speed: body.speed ?? null,
        heading: body.heading ?? null,
        accuracy: body.accuracy ?? null,
        timestamp: body.timestamp ?? now,
        source: body.source || "unknown",
        updatedAt: now,
      };
      await this.state.storage.put("fleet", fleet);

      // broadcast to websocket clients
      const conns = (await this.state.storage.get<WebSocket[]>("conns")) || [];
      const msg = JSON.stringify({ type: "update", boat: fleet[boatId] });
      const alive: WebSocket[] = [];
      for (const ws of conns) {
        try {
          ws.send(msg);
          alive.push(ws);
        } catch {}
      }
      await this.state.storage.put("conns", alive);

      return json({ ok: true }, this.env);
    }

    if (path === "/_ws" && request.method === "GET") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      // register connection
      const conns = (await this.state.storage.get<WebSocket[]>("conns")) || [];
      conns.push(server);
      await this.state.storage.put("conns", conns);

      // initial snapshot
      const fleet = (await this.state.storage.get<Record<string, any>>("fleet")) || {};
      server.send(JSON.stringify({ type: "snapshot", fleet }));

      server.addEventListener("close", async () => {
        const cur = (await this.state.storage.get<WebSocket[]>("conns")) || [];
        await this.state.storage.put("conns", cur.filter((w) => w !== server));
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "Not found", path }, this.env, 404);
  }
}

function parseOwnTracks(payload: any): Partial<BoatUpdate> {
  // OwnTracks: { _type:"location", lat, lon, tst, acc, tid, ... }
  const tid = payload?.tid ? String(payload.tid) : "";
  const boatId = tid || payload?.deviceId || payload?.id || "";
  const ts = payload?.tst ? Number(payload.tst) * 1000 : payload?.timestamp ? Number(payload.timestamp) : Date.now();
  return {
    boatId,
    lat: Number(payload.lat),
    lon: Number(payload.lon),
    accuracy: payload.acc != null ? Number(payload.acc) : undefined,
    timestamp: ts,
    source: "owntracks",
  };
}

function parseTraccar(payload: any): Partial<BoatUpdate> {
  // Typical: { deviceId, latitude, longitude, speed, course, fixTime }
  const boatId = payload?.deviceId != null ? String(payload.deviceId) : payload?.id != null ? String(payload.id) : "";
  const ts = payload?.fixTime ? Date.parse(payload.fixTime) : Date.now();
  return {
    boatId,
    lat: Number(payload.latitude ?? payload.lat),
    lon: Number(payload.longitude ?? payload.lon),
    speed: payload.speed != null ? Number(payload.speed) : undefined,
    heading: payload.course != null ? Number(payload.course) : payload.heading != null ? Number(payload.heading) : undefined,
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
    source: "traccar",
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight for ALL routes
    if (request.method === "OPTIONS") return ok(env, 204);

    // Auth
    if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, env, 401);

    // Health
    if (request.method === "GET" && path === "/health") {
      return json(
        {
          ok: true,
          service: "finntrack-api-worker",
          endpoints: [
            "GET /health",
            "GET /races",
            "GET /fleet/static",
            "GET /races/:raceId/fleet",
            "GET /fleet?raceId=...",
            "GET /boats?raceId=...",
            "GET /debug/r2",
            "WebSocket /ws/live?raceId=...",
            "POST /update",
            "POST /owntracks",
            "POST /traccar",
            "POST /ingest",
          ],
        },
        env,
      );
    }

    // Races list (from R2 if present, else fallback)
    if (request.method === "GET" && path === "/races") {
      if (env.RACES) {
        const obj = await env.RACES.get("races.json");
        if (obj) {
          try {
            const races = JSON.parse(await obj.text());
            return json({ ok: true, races }, env);
          } catch {
            return json({ ok: false, error: "Invalid races.json" }, env, 500);
          }
        }
      }
      return json(
        {
          ok: true,
          races: [
            { id: "training", name: "Training" },
            { id: "goldcup-2026", name: "2026 Finn Gold Cup" },
            { id: "nationals-2026", name: "2026 Australian Finn Nationals" },
          ],
        },
        env,
      );
    }

    // ✅ Static fleet list (from R2 fleet.json if present)
    if (request.method === "GET" && path === "/fleet/static") {
      if (env.RACES) {
        const obj = await env.RACES.get("fleet.json");
        if (obj) {
          try {
            const fleet = JSON.parse(await obj.text());
            return json({ ok: true, fleet }, env);
          } catch {
            return json({ ok: false, error: "Invalid fleet.json" }, env, 500);
          }
        }
      }
      return json({ ok: true, fleet: [] }, env);
    }

    // /races/:raceId/fleet
    const raceFleetMatch = path.match(/^\/races\/([^/]+)\/fleet$/);
    if (request.method === "GET" && raceFleetMatch) {
      const raceId = decodeURIComponent(raceFleetMatch[1]);
      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);
      return stub.fetch(`https://do/_fleet?raceId=${encodeURIComponent(raceId)}`);
    }

    // /fleet?raceId=...
    if (request.method === "GET" && path === "/fleet") {
      const raceId = toRaceId(url);
      if (!raceId) return json({ error: "Missing raceId" }, env, 400);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);
      return stub.fetch(`https://do/_fleet?raceId=${encodeURIComponent(raceId)}`);
    }

    // /boats?raceId=...
    if (request.method === "GET" && path === "/boats") {
      const raceId = toRaceId(url);
      if (!raceId) return json({ error: "Missing raceId" }, env, 400);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);
      return stub.fetch(`https://do/_boats?raceId=${encodeURIComponent(raceId)}`);
    }

    // WebSocket live
    if (request.method === "GET" && path === "/ws/live") {
      const raceId = toRaceId(url);
      if (!raceId) return json({ error: "Missing raceId" }, env, 400);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);
      return stub.fetch("https://do/_ws");
    }

    // POST /update
    if (request.method === "POST" && path === "/update") {
      const body = (await request.json()) as BoatUpdate;
      if (!body || !Number.isFinite(body.lat) || !Number.isFinite(body.lon)) {
        return json({ error: "Invalid lat/lon" }, env, 400);
      }

      const raceId = body.raceId || toRaceId(url) || "training";
      const boatId = stableBoatId(body);
      if (!boatId) return json({ error: "Missing boatId" }, env, 400);

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      const payload: BoatUpdate = {
        ...body,
        boatId,
        raceId,
        timestamp: body.timestamp ?? Date.now(),
        source: body.source || "ios",
      };

      const res = await stub.fetch("https://do/_update", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      // Optional: snapshot to KV
      ctx.waitUntil(
        (async () => {
          if (env.HISTORY) {
            await env.HISTORY.put(`${raceId}:${boatId}`, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 });
          }
        })(),
      );

      return res;
    }

    // POST /owntracks
    if (request.method === "POST" && path === "/owntracks") {
      const raw = await request.json();
      const parsed = parseOwnTracks(raw);
      const raceId = (raw?.raceId || toRaceId(url) || "training") as string;
      const boatId = parsed.boatId || "";

      if (!boatId) return json({ error: "Missing boatId/tid" }, env, 400);
      if (!Number.isFinite(parsed.lat as number) || !Number.isFinite(parsed.lon as number)) {
        return json({ error: "Invalid lat/lon" }, env, 400);
      }

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      const payload: BoatUpdate = {
        boatId,
        name: raw?.name,
        raceId,
        lat: parsed.lat as number,
        lon: parsed.lon as number,
        accuracy: parsed.accuracy,
        timestamp: parsed.timestamp,
        source: "owntracks",
      };

      return stub.fetch("https://do/_update", { method: "POST", body: JSON.stringify(payload) });
    }

    // POST /traccar
    if (request.method === "POST" && path === "/traccar") {
      const raw = await request.json();
      const parsed = parseTraccar(raw);
      const raceId = (raw?.raceId || toRaceId(url) || "training") as string;
      const boatId = parsed.boatId || "";

      if (!boatId) return json({ error: "Missing deviceId" }, env, 400);
      if (!Number.isFinite(parsed.lat as number) || !Number.isFinite(parsed.lon as number)) {
        return json({ error: "Invalid lat/lon" }, env, 400);
      }

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      const payload: BoatUpdate = {
        boatId,
        name: raw?.name,
        raceId,
        lat: parsed.lat as number,
        lon: parsed.lon as number,
        speed: parsed.speed,
        heading: parsed.heading,
        timestamp: parsed.timestamp,
        source: "traccar",
      };

      return stub.fetch("https://do/_update", { method: "POST", body: JSON.stringify(payload) });
    }

    // POST /ingest (generic)
    if (request.method === "POST" && path === "/ingest") {
      const body = (await request.json()) as any;
      return this.fetch(
        new Request(new URL("/update", url).toString(), {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ ...body, source: body?.source || "ingest" }),
        }),
        env,
        ctx,
      );
    }

    // Debug R2
    if (request.method === "GET" && path === "/debug/r2") {
      if (!env.RACES) return json({ ok: false, error: "RACES bucket not bound" }, env, 400);
      const listed = await env.RACES.list({ limit: 50 });
      return json({ ok: true, keys: listed.objects.map((o) => o.key) }, env);
    }

    return json({ error: "Not found", path }, env, 404);
  },
};
