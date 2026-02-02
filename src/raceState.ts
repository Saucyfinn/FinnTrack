import type { Env } from "./index";

type BoatRosterEntry = {
  boatId: string;
  boatName: string;
  nation?: string;
  joinedAt: number;
  lastSeen?: number;
};

type Telemetry = {
  boatId: string;
  lat: number;
  lon: number;
  t: number;
  sog?: number;
  cog?: number;
  heading?: number;
  heel?: number;
};

type BoatView = {
  boatId: string;
  boatName: string;
  nation?: string;
  joinedAt: number;
  live: boolean;
  lastSeen?: number;
  telemetry?: Telemetry;
};

const STORAGE_KEY = "state";
const LIVE_MS = 30_000;

const nowMs = () => Date.now();

function num(v: any): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export class RaceState implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  private roster: Map<string, BoatRosterEntry> = new Map();
  private latest: Map<string, Telemetry> = new Map();
  private sockets: Set<WebSocket> = new Set();
  private loaded = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async loadOnce() {
    if (this.loaded) return;
    const saved = await this.state.storage.get<any>(STORAGE_KEY);
    if (saved?.roster) this.roster = new Map(saved.roster);
    if (saved?.latest) this.latest = new Map(saved.latest);
    this.loaded = true;
  }

  private async persist() {
    await this.state.storage.put(STORAGE_KEY, {
      roster: Array.from(this.roster.entries()),
      latest: Array.from(this.latest.entries()),
    });
  }

  private broadcast(event: any) {
    const msg = JSON.stringify(event);
    for (const ws of this.sockets) {
      try { ws.send(msg); } catch {}
    }
  }

  private boatsView(): BoatView[] {
    const t = nowMs();
    const out: BoatView[] = [];
    for (const [boatId, entry] of this.roster.entries()) {
      const telem = this.latest.get(boatId);
      const lastSeen = entry.lastSeen ?? telem?.t;
      const live = lastSeen ? (t - lastSeen) <= LIVE_MS : false;
      out.push({
        boatId,
        boatName: entry.boatName,
        nation: entry.nation,
        joinedAt: entry.joinedAt,
        live,
        lastSeen,
        telemetry: telem,
      });
    }
    out.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return a.boatName.localeCompare(b.boatName);
    });
    return out;
  }

  private async updateRacesIndex(raceId: string) {
    const key = "races:index";
    const raw = await this.env.HISTORY.get(key);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    if (!arr.includes(raceId)) {
      arr.push(raceId);
      await this.env.HISTORY.put(key, JSON.stringify(arr));
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.loadOnce();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/ws/live") {
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sockets.add(server);

      server.send(JSON.stringify({ type: "snapshot", boats: this.boatsView() }));

      server.addEventListener("close", () => this.sockets.delete(server));
      server.addEventListener("error", () => this.sockets.delete(server));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (method === "GET" && path === "/boats") {
      return new Response(JSON.stringify({ ok: true, now: nowMs(), boats: this.boatsView() }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (method === "POST" && path === "/join") {
      const body = await request.json<any>().catch(() => null);
      if (!body) return new Response("Bad JSON", { status: 400 });

      const raceId = String(body?.raceId || "");
      const boatId = String(body?.boatId || "");
      const boatName = String(body?.boatName || boatId || "");
      const nation = body?.nation ? String(body.nation) : undefined;

      if (!raceId) return new Response("Missing raceId", { status: 400 });
      if (!boatId) return new Response("Missing boatId", { status: 400 });

      await this.updateRacesIndex(raceId);

      const existing = this.roster.get(boatId);
      this.roster.set(boatId, {
        boatId,
        boatName,
        nation,
        joinedAt: existing?.joinedAt ?? nowMs(),
        lastSeen: existing?.lastSeen,
      });

      await this.persist();
      this.broadcast({ type: "roster", boats: this.boatsView() });

      return new Response(JSON.stringify({ ok: true, boatsCount: this.roster.size }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (method === "POST" && path === "/update") {
      const body = await request.json<any>().catch(() => null);
      if (!body) return new Response("Bad JSON", { status: 400 });

      const raceId = String(body?.raceId || "");
      const boatId = String(body?.boatId || "");
      const lat = num(body?.lat);
      const lon = num(body?.lon);

      if (!raceId) return new Response("Missing raceId", { status: 400 });
      if (!boatId) return new Response("Missing boatId", { status: 400 });
      if (lat === undefined) return new Response("Missing lat", { status: 400 });
      if (lon === undefined) return new Response("Missing lon", { status: 400 });

      await this.updateRacesIndex(raceId);

      if (!this.roster.has(boatId)) {
        this.roster.set(boatId, {
          boatId,
          boatName: String(body?.boatName || boatId),
          nation: body?.nation ? String(body.nation) : undefined,
          joinedAt: nowMs(),
        });
      }

      const t = num(body?.t) ?? nowMs();

      const telem: Telemetry = {
        boatId,
        lat,
        lon,
        t,
        sog: num(body?.sog),
        cog: num(body?.cog),
        heading: num(body?.heading),
        heel: num(body?.heel),
      };

      this.latest.set(boatId, telem);

      const entry = this.roster.get(boatId)!;
      entry.lastSeen = t;
      this.roster.set(boatId, entry);

      await this.persist();

      this.broadcast({ type: "telemetry", boatId, telemetry: telem });
      this.broadcast({ type: "roster", boats: this.boatsView() });

      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }
}
