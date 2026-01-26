/* eslint-disable @typescript-eslint/no-explicit-any */
import { RaceState, type Env, type TrackPoint } from "./raceState";
import { json, parseUrl, clamp, roundTo, haversineMeters } from "./utils";

/**
 * FinnTrack API Worker
 *
 * Endpoints:
 *  - GET  /health
 *  - POST /track              ingest points (single or batch)
 *  - GET  /replay?raceId=...&from=...&to=...&hz=...
 *  - GET  /live?raceId=...    WebSocket stream
 */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname, searchParams } = parseUrl(request.url);

    // Simple landing
    if (pathname === "/") {
      return new Response("FinnTrack API Worker OK. Try /health\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Health
    if (pathname === "/health") {
      return json({ ok: true, name: "finntrack-api-worker", ts: Date.now() });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Track ingest
    if (pathname === "/track" && request.method === "POST") {
      return handleTrack(request, env, ctx);
    }

    // Replay
    if (pathname === "/replay" && request.method === "GET") {
      return handleReplay(searchParams, env);
    }

    // Live WebSocket
    if (pathname === "/live" && request.method === "GET") {
      return handleLive(request, searchParams, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
}

async function handleTrack(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const raceId = String(body.raceId || body.raceID || "");
  if (!raceId) return json({ ok: false, error: "raceId is required" }, 400);

  const now = Date.now();
  const points: TrackPoint[] = [];

  // ----------------------------
  // Batch payload: { raceId, boats: [...] }
  // ----------------------------
  if (Array.isArray(body.boats)) {
    for (const b of body.boats) {
      const boatId = String(b?.boatId || b?.id || "");
      if (!boatId) return json({ ok: false, error: "boatId is required" }, 400);

      const lat = Number(b?.lat);
      const lon = Number(b?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return json({ ok: false, error: "lat/lon must be numbers" }, 400);
      }

      const t = b?.t != null ? Number(b.t) : now;
      if (!Number.isFinite(t)) return json({ ok: false, error: "t must be unix ms" }, 400);

      const sog = b?.sog != null ? Number(b.sog) : undefined;
      const cog = b?.cog != null ? Number(b.cog) : undefined;

      points.push({
        raceId,
        boatId,
        name: b?.name != null ? String(b.name) : undefined,
        lat,
        lon,
        sog: Number.isFinite(sog as number) ? (sog as number) : undefined,
        cog: Number.isFinite(cog as number) ? (cog as number) : undefined,
        t,
      });
    }
  } else {
    // ----------------------------
    // Legacy single-point payload: { raceId, boatId, lat, lon, ... }
    // ----------------------------
    const boatId = String(body.boatId || body.id || "");
    if (!boatId) return json({ ok: false, error: "boatId is required" }, 400);

    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json({ ok: false, error: "lat/lon must be numbers" }, 400);
    }

    const t = body?.t != null ? Number(body.t) : now;
    if (!Number.isFinite(t)) return json({ ok: false, error: "t must be unix ms" }, 400);

    const sog = body?.sog != null ? Number(body.sog) : undefined;
    const cog = body?.cog != null ? Number(body.cog) : undefined;

    points.push({
      raceId,
      boatId,
      name: body?.name != null ? String(body.name) : undefined,
      lat,
      lon,
      sog: Number.isFinite(sog as number) ? (sog as number) : undefined,
      cog: Number.isFinite(cog as number) ? (cog as number) : undefined,
      t,
    });
  }

  if (points.length === 0) return json({ ok: false, error: "no points" }, 400);

  // Write to Durable Object (and it will persist + broadcast)
  const id = env.RACE_STATE.idFromName(raceId);
  const stub = env.RACE_STATE.get(id);
  ctx.waitUntil(stub.fetch("https://do/ingest", { method: "POST", body: JSON.stringify({ points }) }));

  // Also write raw points to D1 for replay queries
  ctx.waitUntil(insertPointsD1(env, points));

  return json({ ok: true, n: points.length });
}

async function insertPointsD1(env: Env, points: TrackPoint[]) {
  // Minimal insert; schema expected:
  // track_points(raceId TEXT, boatId TEXT, t INTEGER, lat REAL, lon REAL, sog REAL, cog REAL, name TEXT)
  const stmt = env.DB.prepare(
    `INSERT INTO track_points (raceId, boatId, t, lat, lon, sog, cog, name)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  );

  const batch = points.map((p) =>
    stmt.bind(
      p.raceId,
      p.boatId,
      p.t,
      p.lat,
      p.lon,
      p.sog ?? null,
      p.cog ?? null,
      p.name ?? null
    )
  );

  await env.DB.batch(batch);
}

async function handleReplay(searchParams: URLSearchParams, env: Env): Promise<Response> {
  const raceId = String(searchParams.get("raceId") || "");
  if (!raceId) return json({ ok: false, error: "raceId is required" }, 400);

  const from = Number(searchParams.get("from"));
  const to = Number(searchParams.get("to"));
  const hz = Number(searchParams.get("hz") || "1");

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return json({ ok: false, error: "from/to must be unix ms" }, 400);
  }
  if (to <= from) return json({ ok: false, error: "to must be > from" }, 400);

  const safeHz = clamp(hz, 0.1, 10);
  const stepMs = Math.round(1000 / safeHz);

  // Limit replay window size defensively (6 hours default)
  const maxWindowMs = 6 * 60 * 60 * 1000;
  const windowMs = to - from;
  const effectiveTo = windowMs > maxWindowMs ? from + maxWindowMs : to;

  // Pull raw points in window
  const rows = await env.DB.prepare(
    `SELECT raceId, boatId, t, lat, lon, sog, cog, name
     FROM track_points
     WHERE raceId = ?1 AND t >= ?2 AND t <= ?3
     ORDER BY t ASC`
  )
    .bind(raceId, from, effectiveTo)
    .all();

  const points = (rows.results || []) as any[];

  // Build frames at fixed interval by choosing "latest known point <= frame time" per boat.
  const frames: Array<{ t: number; boats: any[] }> = [];
  const boatsLatest = new Map<string, any>();

  let cursor = 0;
  for (let t = from; t <= effectiveTo; t += stepMs) {
    while (cursor < points.length && Number(points[cursor].t) <= t) {
      const p = points[cursor++];
      boatsLatest.set(String(p.boatId), p);
    }

    const boats = Array.from(boatsLatest.values()).map((p) => ({
      boatId: String(p.boatId),
      name: p.name != null ? String(p.name) : undefined,
      lat: Number(p.lat),
      lon: Number(p.lon),
      sog: p.sog != null ? Number(p.sog) : undefined,
      cog: p.cog != null ? Number(p.cog) : undefined,
      t: Number(p.t),
    }));

    frames.push({ t, boats });
  }

  return json({
    ok: true,
    raceId,
    from,
    to: effectiveTo,
    hz: safeHz,
    stepMs,
    frames,
  });
}

async function handleLive(request: Request, searchParams: URLSearchParams, env: Env): Promise<Response> {
  const raceId = String(searchParams.get("raceId") || "");
  if (!raceId) return json({ ok: false, error: "raceId is required" }, 400);

  const upgradeHeader = request.headers.get("Upgrade") || "";
  if (upgradeHeader.toLowerCase() !== "websocket") {
    return json({ ok: false, error: 'Expected WebSocket (Upgrade: websocket)' }, 400);
  }

  const id = env.RACE_STATE.idFromName(raceId);
  const stub = env.RACE_STATE.get(id);

  // Pass through to DO which owns websocket fan-out
  return stub.fetch("https://do/live", request);
}
