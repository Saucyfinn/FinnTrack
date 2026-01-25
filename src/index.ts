/* FinnTrack API Worker (D1 + Durable Objects)
 * Endpoints:
 *  - GET  /health
 *  - POST /track
 *  - GET  /live?raceId=...   (WebSocket)
 *  - GET  /replay?raceId=...&from=...&to=...&hz=...
 */

export interface Env {
  DB: D1Database;
  RACE_STATE: DurableObjectNamespace;
  RACES: R2Bucket;
  HISTORY: KVNamespace;
  HISTORY_PREVIEW: KVNamespace;
  TRACK_SECRET?: string;
}

type TrackPoint = {
  raceId: string;
  boatId: string;
  t: number; // unix ms
  lat: number;
  lon: number;
  sog?: number;
  cog?: number;
  name?: string;
};

type LiveBoat = {
  boatId: string;
  name?: string;
  lat: number;
  lon: number;
  sog?: number;
  cog?: number;
  t: number;
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function badRequest(message: string, details?: any) {
  return json({ ok: false, error: message, details }, 400);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Durable Object: one per raceId */
export class RaceState {
  private state: DurableObjectState;
  private boats: Map<string, LiveBoat> = new Map();
  private watchers: Set<WebSocket> = new Set();
  private ACTIVE_MS = 120_000;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;

    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<Record<string, LiveBoat>>("boats");
      if (saved) {
        for (const [id, boat] of Object.entries(saved)) this.boats.set(id, boat);
      }
    });
  }

  private prune() {
    const now = Date.now();
    for (const [boatId, boat] of this.boats.entries()) {
      if (now - boat.t > this.ACTIVE_MS) this.boats.delete(boatId);
    }
  }

  private snapshot() {
    this.prune();
    return Array.from(this.boats.values()).sort((a, b) => a.boatId.localeCompare(b.boatId));
  }

  private broadcast(payload: any) {
    const msg = JSON.stringify(payload);
    for (const ws of this.watchers) {
      try {
        ws.send(msg);
      } catch {
        try { ws.close(); } catch {}
        this.watchers.delete(ws);
      }
    }
  }

  private async persist() {
    const obj: Record<string, LiveBoat> = {};
    for (const [k, v] of this.boats.entries()) obj[k] = v;
    await this.state.storage.put("boats", obj);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    // WebSocket for live viewers
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426, headers: corsHeaders() });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.watchers.add(server);

      server.send(JSON.stringify({ type: "snapshot", boats: this.snapshot(), t: Date.now() }));

      server.addEventListener("close", () => this.watchers.delete(server));
      server.addEventListener("error", () => this.watchers.delete(server));

      return new Response(null, { status: 101, webSocket: client });
    }

    // Ingest from main Worker after D1 write
    if (url.pathname === "/ingest" && request.method === "POST") {
      let p: TrackPoint;
      try {
        p = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400, headers: corsHeaders() });
      }

      const boat: LiveBoat = {
        boatId: p.boatId,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        sog: p.sog,
        cog: p.cog,
        t: p.t,
      };

      this.boats.set(p.boatId, boat);
      await this.persist();
      this.broadcast({ type: "point", boat });
      return new Response("ok", { status: 200, headers: corsHeaders() });
    }

    if (url.pathname === "/latest") {
      return json({ ok: true, boats: this.snapshot(), t: Date.now() });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "finntrack-api", t: Date.now() });
    }

    // Live WebSocket -> DO
    if (url.pathname === "/live") {
      const raceId = url.searchParams.get("raceId");
      if (!raceId) return badRequest("Missing raceId");
      if (request.headers.get("Upgrade") !== "websocket") {
        return badRequest("Expected WebSocket (Upgrade: websocket)");
      }

      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      const wsUrl = new URL(request.url);
      wsUrl.pathname = "/ws";
      return stub.fetch(wsUrl.toString(), request);
    }

    // Boat ingest
    if (url.pathname === "/track" && request.method === "POST") {
      if (env.TRACK_SECRET) {
        const auth = request.headers.get("authorization") || "";
        if (auth !== `Bearer ${env.TRACK_SECRET}`) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }
      }

      let p: Partial<TrackPoint>;
      try {
        p = await request.json();
      } catch {
        return badRequest("Invalid JSON");
      }

      const raceId = String(p.raceId || "").trim();
      const boatId = String(p.boatId || "").trim();
      if (!raceId) return badRequest("raceId is required");
      if (!boatId) return badRequest("boatId is required");

      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return badRequest("lat/lon must be numbers");
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return badRequest("lat/lon out of range");

      const t = isFiniteNumber(p.t) ? Math.floor(p.t) : Date.now();
      const sog = isFiniteNumber(p.sog) ? p.sog : undefined;
      const cog = isFiniteNumber(p.cog) ? p.cog : undefined;
      const name = p.name ? String(p.name).slice(0, 80) : undefined;

      const point: TrackPoint = { raceId, boatId, t, lat, lon, sog, cog, name };

      // D1 write
      try {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO track_points (raceId, boatId, t, lat, lon, sog, cog, name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(point.raceId, point.boatId, point.t, point.lat, point.lon, point.sog ?? null, point.cog ?? null, point.name ?? null)
          .run();
      } catch (e: any) {
        return json({ ok: false, error: "D1 write failed", details: String(e?.message || e) }, 500);
      }

      // Fanout to DO
      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      const ingestUrl = new URL(request.url);
      ingestUrl.pathname = "/ingest";

      await stub.fetch(ingestUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(point),
      });

      return json({ ok: true });
    }

    // Replay frames (smoothed interpolation)
    if (url.pathname === "/replay" && request.method === "GET") {
      const raceId = url.searchParams.get("raceId");
      if (!raceId) return badRequest("Missing raceId");

      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const hzRaw = Number(url.searchParams.get("hz") || "4");

      if (!isFiniteNumber(from) || !isFiniteNumber(to)) return badRequest("from/to must be unix ms");
      if (to <= from) return badRequest("to must be > from");

      const maxWindowMs = 6 * 60 * 60 * 1000;
      if (to - from > maxWindowMs) return badRequest("time window too large (max 6 hours)");

      const hz = clamp(isFiniteNumber(hzRaw) ? hzRaw : 4, 1, 10);
      const stepMs = Math.floor(1000 / hz);

      let rows: any[] = [];
      try {
        const res = await env.DB.prepare(
          `SELECT raceId, boatId, t, lat, lon, sog, cog, name
             FROM track_points
            WHERE raceId = ?
              AND t >= ?
              AND t <= ?
            ORDER BY boatId ASC, t ASC`
        )
          .bind(raceId, from, to)
          .all();
        rows = res.results || [];
      } catch (e: any) {
        return json({ ok: false, error: "D1 read failed", details: String(e?.message || e) }, 500);
      }

      const byBoat = new Map<string, TrackPoint[]>();
      for (const r of rows) {
        const tp: TrackPoint = {
          raceId: r.raceId,
          boatId: r.boatId,
          t: r.t,
          lat: r.lat,
          lon: r.lon,
          sog: r.sog ?? undefined,
          cog: r.cog ?? undefined,
          name: r.name ?? undefined,
        };
        if (!byBoat.has(tp.boatId)) byBoat.set(tp.boatId, []);
        byBoat.get(tp.boatId)!.push(tp);
      }

      const frames: { t: number; boats: LiveBoat[] }[] = [];

      function lerp(a: number, b: number, x: number) {
        return a + (b - a) * x;
      }

      function interp(p0: TrackPoint, p1: TrackPoint, t: number): LiveBoat {
        const span = p1.t - p0.t;
        const alpha = span <= 0 ? 0 : (t - p0.t) / span;
        const x = clamp(alpha, 0, 1);
        return {
          boatId: p0.boatId,
          name: p0.name ?? p1.name,
          lat: lerp(p0.lat, p1.lat, x),
          lon: lerp(p0.lon, p1.lon, x),
          sog: isFiniteNumber(p0.sog) && isFiniteNumber(p1.sog) ? lerp(p0.sog, p1.sog, x) : (p0.sog ?? p1.sog),
          cog: isFiniteNumber(p0.cog) && isFiniteNumber(p1.cog) ? lerp(p0.cog, p1.cog, x) : (p0.cog ?? p1.cog),
          t,
        };
      }

      const idx = new Map<string, number>();
      for (const boatId of byBoat.keys()) idx.set(boatId, 0);

      for (let t = from; t <= to; t += stepMs) {
        const boats: LiveBoat[] = [];

        for (const [boatId, pts] of byBoat.entries()) {
          if (pts.length === 0) continue;

          let i = idx.get(boatId) ?? 0;
          while (i + 1 < pts.length && pts[i + 1].t < t) i++;
          idx.set(boatId, i);

          if (t <= pts[0].t) {
            const first = pts[0];
            boats.push({ boatId, name: first.name, lat: first.lat, lon: first.lon, sog: first.sog, cog: first.cog, t });
            continue;
          }
          if (t >= pts[pts.length - 1].t) {
            const last = pts[pts.length - 1];
            boats.push({ boatId, name: last.name, lat: last.lat, lon: last.lon, sog: last.sog, cog: last.cog, t });
            continue;
          }

          const p0 = pts[i];
          const p1 = pts[i + 1];
          boats.push(interp(p0, p1, t));
        }

        frames.push({ t, boats });
      }

      return json({ ok: true, raceId, from, to, hz, stepMs, frames });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
