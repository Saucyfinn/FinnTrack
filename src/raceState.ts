// src/raceState.ts - FinnTrack Durable Object
// Manages race state, boat roster, telemetry, and WebSocket broadcasts

import type { Env } from "./index";

// ============================================================
// Type Definitions
// ============================================================

type BoatRosterEntry = {
  boatId: string;
  boatName: string;
  nation?: string;
  joinedAt: number;    // epoch ms
  lastSeen?: number;   // epoch ms (last telemetry)
};

type Telemetry = {
  boatId: string;
  lat: number;
  lon: number;
  t: number;           // epoch ms
  sog?: number;        // speed over ground (knots)
  cog?: number;        // course over ground (degrees)
  heading?: number;    // compass heading (degrees)
  heel?: number;       // heel angle (degrees)
};

// View format sent to frontend
type BoatView = {
  boatId: string;
  boatName: string;
  nation?: string;
  joinedAt: number;
  live: boolean;
  lastSeen?: number;
  lat?: number;
  lng?: number;
  speed?: number;
  heading?: number;
  timestamp?: number;
};

const STORAGE_KEY = "state";
const LIVE_MS = 120_000; // 2 minutes - boat considered "live" if update within this window

// ============================================================
// Utility Functions
// ============================================================

function nowMs(): number {
  return Date.now();
}

function safeNum(v: any): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function mustHaveTelemetryFields(body: any): { ok: true } | { ok: false; msg: string } {
  const boatId = String(body?.boatId || "");
  const lat = safeNum(body?.lat);
  const lon = safeNum(body?.lon);

  if (!boatId) return { ok: false, msg: "Missing boatId" };
  if (lat === undefined) return { ok: false, msg: "Missing lat" };
  if (lon === undefined) return { ok: false, msg: "Missing lon" };
  return { ok: true };
}

// ============================================================
// RaceState Durable Object Class
// ============================================================

export class RaceState implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  // In-memory state
  private roster: Map<string, BoatRosterEntry> = new Map();
  private latest: Map<string, Telemetry> = new Map();
  private sockets: Set<WebSocket> = new Set();
  private loaded = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // ----------------------------------------------------------
  // Storage Operations
  // ----------------------------------------------------------

  private async loadOnce(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.state.storage.get<any>(STORAGE_KEY);
    if (saved?.roster) {
      this.roster = new Map(saved.roster);
    }
    if (saved?.latest) {
      this.latest = new Map(saved.latest);
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const payload = {
      roster: Array.from(this.roster.entries()),
      latest: Array.from(this.latest.entries()),
    };
    await this.state.storage.put(STORAGE_KEY, payload);
  }

  // ----------------------------------------------------------
  // WebSocket Broadcasting
  // ----------------------------------------------------------

  private broadcast(event: any): void {
    const msg = JSON.stringify(event);
    for (const ws of this.sockets) {
      try {
        ws.send(msg);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  // ----------------------------------------------------------
  // Boat View Generation (for frontend)
  // ----------------------------------------------------------

  private boatsView(): Record<string, BoatView> {
    const t = nowMs();
    const out: Record<string, BoatView> = {};

    for (const [boatId, entry] of this.roster.entries()) {
      const telem = this.latest.get(boatId);
      const lastSeen = entry.lastSeen ?? telem?.t;
      const live = lastSeen ? (t - lastSeen) <= LIVE_MS : false;

      out[boatId] = {
        boatId,
        boatName: entry.boatName,
        nation: entry.nation,
        joinedAt: entry.joinedAt,
        live,
        lastSeen,
        lat: telem?.lat,
        lng: telem?.lon,
        speed: telem?.sog,
        heading: telem?.heading ?? telem?.cog,
        timestamp: telem?.t,
      };
    }

    return out;
  }

  // Alternative: array format for some endpoints
  private boatsViewArray(): BoatView[] {
    const boatsObj = this.boatsView();
    const arr = Object.values(boatsObj);
    // Sort: live first, then by boatName
    arr.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return a.boatName.localeCompare(b.boatName);
    });
    return arr;
  }

  // ----------------------------------------------------------
  // Race Index Update (for /races endpoint)
  // ----------------------------------------------------------

  private async updateRacesIndex(raceId: string): Promise<void> {
    try {
      const key = "races:index";
      const raw = await this.env.HISTORY.get(key);
      const arr: string[] = raw ? (JSON.parse(raw) as string[]) : [];
      if (!arr.includes(raceId)) {
        arr.push(raceId);
        await this.env.HISTORY.put(key, JSON.stringify(arr));
      }
    } catch {
      // Ignore errors - this is non-critical
    }
  }

  // ----------------------------------------------------------
  // Main Request Handler
  // ----------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    await this.loadOnce();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // --------------------------------------------------------
    // WebSocket Spectator Endpoint
    // --------------------------------------------------------
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

      // Send initial snapshot using "full" type (frontend expects this)
      const boats = this.boatsView();
      server.send(JSON.stringify({
        type: "full",
        now: nowMs(),
        boats: boats,
      }));

      server.addEventListener("close", () => {
        this.sockets.delete(server);
      });

      server.addEventListener("error", () => {
        this.sockets.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // --------------------------------------------------------
    // List Boats for this Race
    // --------------------------------------------------------
    if (method === "GET" && path === "/boats") {
      return new Response(
        JSON.stringify({
          ok: true,
          now: nowMs(),
          boats: this.boatsViewArray(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    // --------------------------------------------------------
    // Join/Register Boat (no telemetry required)
    // --------------------------------------------------------
    if (method === "POST" && path === "/join") {
      const bodyText = await request.text();
      let body: any;
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      const raceId = String(body?.raceId || "");
      const boatId = String(body?.boatId || "");
      const boatName = String(body?.boatName || boatId || "");
      const nation = body?.nation ? String(body.nation) : undefined;

      if (!raceId) return new Response("Missing raceId", { status: 400 });
      if (!boatId) return new Response("Missing boatId", { status: 400 });

      await this.updateRacesIndex(raceId);

      const existing = this.roster.get(boatId);
      const joinedAt = existing?.joinedAt ?? nowMs();

      this.roster.set(boatId, {
        boatId,
        boatName,
        nation,
        joinedAt,
        lastSeen: existing?.lastSeen,
      });

      await this.persist();

      // Broadcast roster update using "full" type
      const boats = this.boatsView();
      this.broadcast({ type: "full", now: nowMs(), boats });

      return new Response(
        JSON.stringify({ ok: true, boatId, boatsCount: this.roster.size }),
        {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    // --------------------------------------------------------
    // Telemetry Update
    // --------------------------------------------------------
    if (method === "POST" && path === "/update") {
      const bodyText = await request.text();
      let body: any;
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      const raceId = String(body?.raceId || "");
      if (!raceId) return new Response("Missing raceId", { status: 400 });

      const check = mustHaveTelemetryFields(body);
      if (!check.ok) return new Response(check.msg, { status: 400 });

      const boatId = String(body.boatId);
      const lat = Number(body.lat);
      const lon = Number(body.lon);
      const t = safeNum(body.t) ?? nowMs();

      await this.updateRacesIndex(raceId);

      // Auto-create roster entry if update arrives before join
      if (!this.roster.has(boatId)) {
        this.roster.set(boatId, {
          boatId,
          boatName: String(body?.boatName || boatId),
          nation: body?.nation ? String(body.nation) : undefined,
          joinedAt: nowMs(),
        });
      }

      const telem: Telemetry = {
        boatId,
        lat,
        lon,
        t,
        sog: safeNum(body.sog) ?? safeNum(body.speed),
        cog: safeNum(body.cog) ?? safeNum(body.course),
        heading: safeNum(body.heading),
        heel: safeNum(body.heel),
      };

      this.latest.set(boatId, telem);

      const entry = this.roster.get(boatId)!;
      entry.lastSeen = t;
      this.roster.set(boatId, entry);

      await this.persist();

      // Build boat view for this boat
      const boatView: BoatView = {
        boatId,
        boatName: entry.boatName,
        nation: entry.nation,
        joinedAt: entry.joinedAt,
        live: true,
        lastSeen: t,
        lat: telem.lat,
        lng: telem.lon,
        speed: telem.sog,
        heading: telem.heading ?? telem.cog,
        timestamp: telem.t,
      };

      // Broadcast individual update (frontend handles "update" type)
      this.broadcast({
        type: "update",
        now: nowMs(),
        boat: boatId,
        data: boatView,
      });

      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }
}
