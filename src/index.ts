// src/index.ts
import { RaceState } from "./raceState";
import { json } from "./utils";

export interface Env {
  DB: D1Database;
  RACES: R2Bucket;
  HISTORY: KVNamespace;
  HISTORY_PREVIEW: KVNamespace;
  RACE_STATE: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("FinnTrack API Worker OK. Try /health\n", { status: 200 });
    }

    if (url.pathname === "/track" && request.method === "POST") {
      // Accept either:
      //  A) single point payload: { raceId, boatId, lat, lon, sog?, cog?, t, name? }
      //  B) batch payload: { raceId, boats: [ { boatId, lat, lon, sog?, cog?, t, name? }, ... ] }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      const raceId: string | undefined = body?.raceId;
      if (!raceId) return json({ ok: false, error: "raceId is required" }, 400);

      const normalizePoint = (b: any) => {
        const boatId = b?.boatId;
        if (!boatId) throw new Error("boatId is required");
        const lat = b?.lat;
        const lon = b?.lon;
        const t = b?.t;
        if (lat === undefined || lon === undefined) throw new Error("lat/lon are required");
        if (t === undefined) throw new Error("t is required");
        const name = b?.name;
        const sog = b?.sog;
        const cog = b?.cog;
        return { raceId, boatId, name, lat, lon, sog, cog, t };
      };

      const points: Array<any> = [];
      try {
        if (Array.isArray(body?.boats)) {
          for (const b of body.boats) points.push(normalizePoint(b));
        } else {
          // treat body itself as a single point
          points.push(normalizePoint(body));
        }
      } catch (e: any) {
        return json({ ok: false, error: e?.message || "Invalid payload" }, 400);
      }

      // D1 write (store raw points for replay)
      const stmts = points.map((p) =>
        env.DB.prepare(
          "INSERT OR REPLACE INTO track_points (raceId, boatId, t, lat, lon, sog, cog, name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ).bind(p.raceId, p.boatId, p.t, p.lat, p.lon, p.sog ?? null, p.cog ?? null, p.name ?? null)
      );
      await env.DB.batch(stmts);

      // Update RaceState Durable Object for live stream
      const id = env.RACE_STATE.idFromName(raceId);
      const stub = env.RACE_STATE.get(id);

      // DO expects seconds timestamp + 'lng' naming
      await Promise.all(
        points.map((p) =>
          stub.fetch("https://race-state/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              raceId: p.raceId,
              boatId: p.boatId,
              name: p.name,
              lat: p.lat,
              lng: p.lon,
              speed: p.sog,
              heading: p.cog,
              timestamp: Math.floor(p.t / 1000),
            }),
          })
        )
      );

      return json({ ok: true, n: points.length });
    }

    // keep the rest of your routes exactly as they were (replay, live, etc.)
    // If your current file contains /replay and /live handlers, leave them below unchanged.

    return new Response("Not found", { status: 404 });
  },
};

export { RaceState };
