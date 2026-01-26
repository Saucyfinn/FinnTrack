/* FinnTrack API Worker (Cloudflare Workers + Durable Objects + D1)
 *
 * Endpoints:
 *   GET  /health
 *   GET  /version
 *   POST /track               (accepts single point OR boats[] batch)
 *   GET  /replay?raceId=...&from=...&to=...&hz=...
 *   GET  /live?raceId=...     (WebSocket; use ws(s):// in client)
 */

export interface Env {
  DB: D1Database;
  RACE_STATE: DurableObjectNamespace;
  // Optional bindings you may have; not required by this file:
  HISTORY?: KVNamespace;
  HISTORY_PREVIEW?: KVNamespace;
  RACES?: R2Bucket;
}

type TrackPoint = {
  raceId: string;
  boatId: string;
  name?: string;
  lat: number;
  lon: number;
  sog?: number;
  cog?: number;
  t: number; // unix ms
};

type TrackBatch = {
  raceId: string;
  boats: Array<{
    boatId: string;
    name?: string;
    lat: number;
    lon: number;
    sog?: number;
    cog?: number;
    t: number;
  }>;
};

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function bad(message: string, status = 400) {
  return json({ ok: false, error: message }, status);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function normalizeTrackPayload(body: unknown): TrackPoint[] | { error: string } {
  if (!isObj(body)) return { error: "Invalid JSON" };

  const raceId = typeof body.raceId === "string" ? body.raceId.trim() : "";
  if (!raceId) return { error: "raceId is required" };

  // Batch shape: { raceId, boats: [...] }
  if (Array.isArray(body.boats)) {
    const boats = body.boats as TrackBatch["boats"];
    const points: TrackPoint[] = [];

    for (const b of boats) {
      if (!isObj(b)) return { error: "boats[] must be objects" };
      const boatId = typeof b.boatId === "string" ? b.boatId.trim() : "";
      if (!boatId) return { error: "boatId is required" };

      const lat = toNumber(b.lat);
      const lon = toNumber(b.lon);
      const t = toNumber(b.t);

      if (lat === null || lon === null) return { error: "lat/lon are required numbers" };
      if (t === null) return { error: "t is required (unix ms)" };

      const name = typeof b.name === "string" ? b.name : undefined;
      const sog = toNumber(b.sog ?? undefined) ?? undefined;
      const cog = toNumber(b.cog ?? undefined) ?? undefined;

      points.push({ raceId, boatId, name, lat, lon, sog, cog, t });
    }

    return points;
  }

  // Single shape: { raceId, boatId, lat, lon, t, ... }
  const boatId = typeof body.boatId === "string" ? body.boatId.trim() : "";
  if (!boatId) return { error: "boatId is required" };

  const lat = toNumber(body.lat);
  const lon = toNumber(body.lon);
  const t = toNumber(body.t);

  if (lat === null || lon === null) return { error: "lat/lon are required numbers" };
  if (t === null) return { error: "t is required (unix ms)" };

  const name = typeof body.name === "string" ? body.name : undefined;
  const sog = toNumber(body.sog ?? undefined) ?? undefined;
  const cog = toNumber(body.cog ?? undefined) ?? undefined;

  return [{ raceId, boatId, name, lat, lon, sog, cog, t }];
}

async function handleReplay(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const raceId = url.searchParams.get("raceId")?.trim() || "";
  const from = toNumber(url.searchParams.get("from"));
  const to = toNumber(url.searchParams.get("to"));
  const hz = Math.max(0.1, Math.min(10, toNumber(url.searchParams.get("hz")) ?? 2)); // clamp 0.1..10

  if (!raceId) return bad("raceId is required");
  if (from === null || to === null) return bad("from/to must be unix ms");
  if (!(to > from)) return bad("to must be > from");

  const stepMs = Math.max(50, Math.round(1000 / hz)); // at least 50ms steps

  // Pull points in range (ordered)
  const res = await env.DB.prepare(
    `SELECT raceId, boatId, t, lat, lon, sog, cog, name
     FROM track_points
     WHERE raceId = ?1 AND t >= ?2 AND t <= ?3
     ORDER BY t ASC`
  )
    .bind(raceId, from, to)
    .all<any>();

  const rows = (res.results || []) as Array<any>;

  // Build frames by time bucket; keep last-seen per boat up to that bucket
  const frames: Array<{ t: number; boats: TrackPoint[] }> = [];
  const lastByBoat = new Map<string, TrackPoint>();

  let rowIdx = 0;
  for (let ts = from; ts <= to; ts += stepMs) {
    while (rowIdx < rows.length && Number(rows[rowIdx].t) <= ts) {
      const r = rows[rowIdx++];
      lastByBoat.set(String(r.boatId), {
        raceId: String(r.raceId),
        boatId: String(r.boatId),
        name: r.name ?? undefined,
        lat: Number(r.lat),
        lon: Number(r.lon),
        sog: r.sog === null || r.sog === undefined ? undefined : Number(r.sog),
        cog: r.cog === null || r.cog === undefined ? undefined : Number(r.cog),
        t: Number(r.t),
      });
    }

    frames.push({
      t: ts,
      boats: Array.from(lastByBoat.values()),
    });
  }

  return json({
    ok: true,
    raceId,
    from,
    to,
    hz,
    stepMs,
    frames,
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (url.pathname === "/health") {
      return json({ ok: true, service: "finntrack-api-worker" });
    }

    if (url.pathname === "/version") {
      return json({
        ok: true,
        service: "finntrack-api-worker",
        build: "2026-01-26-b", // change this string each deploy
      });
    }

    if (url.pathname === "/replay" && req.method === "GET") {
      return handleReplay(req, env);
    }

    if (url.pathname === "/live" && req.method === "GET") {
      const raceId = url.searchParams.get("raceId")?.trim() || "";
      if (!raceId) return bad("raceId is required");
      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);
      // Forward to DO for websocket handling
      return stub.fetch(req);
    }

    if (url.pathname === "/track" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return bad("Invalid JSON");
      }

      const normalized = normalizeTrackPayload(body);
      if (!Array.isArray(normalized)) return bad(normalized.error);

      const raceId = normalized[0].raceId;
      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      // Send points to DO (DO will store + broadcast)
      ctx.waitUntil(
        stub.fetch("https://race-state/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ points: normalized }),
        })
      );

      return json({ ok: true, accepted: normalized.length });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};

/* Durable Object: RaceState
 * - Keeps last point per boat in memory
 * - Persists incoming points to D1 (track_points)
 * - Streams snapshots/updates to websocket listeners
 */
export class RaceState {
  private state: DurableObjectState;
  private env: Env;
  private boats = new Map<string, TrackPoint>();
  private sockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // best-effort restore from storage on cold start
    this.state.blockConcurrencyWhile(async () => {
      const stored = (await this.state.storage.get<Record<string, TrackPoint>>("boats")) || {};
      for (const [k, v] of Object.entries(stored)) this.boats.set(k, v);
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // WebSocket live stream
    if (url.pathname === "/live") {
      const upgrade = req.headers.get("Upgrade");
      if (upgrade?.toLowerCase() !== "websocket") {
        return bad("Expected WebSocket (Upgrade: websocket)", 400);
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sockets.add(server);

      // initial snapshot
      server.send(
        JSON.stringify({
          type: "snapshot",
          t: Date.now(),
          boats: Array.from(this.boats.values()),
        })
      );

      server.addEventListener("close", () => {
        this.sockets.delete(server);
      });
      server.addEventListener("error", () => {
        this.sockets.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // Update points
    if (url.pathname === "/update" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return bad("Invalid JSON");
      }

      if (!isObj(body) || !Array.isArray((body as any).points)) return bad("points[] is required");

      const points = (body as any).points as TrackPoint[];
      for (const p of points) {
        // hard validate here as well
        if (!p || typeof p.raceId !== "string" || typeof p.boatId !== "string") return bad("boatId is required");
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.t)) return bad("lat/lon/t required");

        this.boats.set(p.boatId, p);

        // Persist to D1
        await this.env.DB.prepare(
          `INSERT INTO track_points (raceId, boatId, t, lat, lon, sog, cog, name)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
          .bind(p.raceId, p.boatId, p.t, p.lat, p.lon, p.sog ?? null, p.cog ?? null, p.name ?? null)
          .run();

        // broadcast update
        const msg = JSON.stringify({ type: "update", t: Date.now(), boatId: p.boatId, boat: p });
        for (const ws of this.sockets) {
          try {
            ws.send(msg);
          } catch {
            // drop bad sockets
            this.sockets.delete(ws);
          }
        }
      }

      // persist last-known set (so cold starts still have a snapshot)
      const obj: Record<string, TrackPoint> = {};
      for (const [k, v] of this.boats.entries()) obj[k] = v;
      await this.state.storage.put("boats", obj);

      return json({ ok: true });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  }
}
