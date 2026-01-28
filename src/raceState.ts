// src/raceState.ts
export type BoatState = {
  boatId: string;
  name?: string;
  lat: number;
  lon: number;
  sog?: number;
  cog?: number;
  t: number; // unix ms
};

type StoredState = {
  boats: Record<string, BoatState>;
};

const STORAGE_KEY = "state";
const ACTIVE_MS = 120_000; // 2 minutes

export class RaceState {
  private state: DurableObjectState;
  private env: any;

  private boats = new Map<string, BoatState>();
  private sockets = new Set<WebSocket>();
  private loaded = false;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Load persisted state once
    if (!this.loaded) {
      await this.loadFromStorage();
      this.loaded = true;
    }

    // WebSocket live
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

      server.addEventListener("close", () => {
        this.sockets.delete(server);
      });
      server.addEventListener("error", () => {
        this.sockets.delete(server);
      });

      // Immediately send snapshot
      server.send(
        JSON.stringify({
          type: "snapshot",
          now: Date.now(),
          boats: this.getActiveBoats(),
        })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    // Read active boats
    if (request.method === "GET" && path === "/boats") {
      return Response.json({
        ok: true,
        now: Date.now(),
        boats: this.getActiveBoats(),
      });
    }

    // Update (from OwnTracks or app)
    if (request.method === "POST" && path === "/update") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      const boatId = String(body?.boatId || "").trim();
      const lat = Number(body?.lat);
      const lon = Number(body?.lon);
      const t = Number(body?.t);

      if (!boatId || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) {
        return new Response("Missing boatId/lat/lon/t", { status: 400 });
      }

      const next: BoatState = {
        boatId,
        name: body?.name ? String(body.name) : undefined,
        lat,
        lon,
        t, // ms
        ...(Number.isFinite(Number(body?.sog)) ? { sog: Number(body.sog) } : {}),
        ...(Number.isFinite(Number(body?.cog)) ? { cog: Number(body.cog) } : {}),
      };

      this.boats.set(boatId, next);

      // Persist (throttled-ish): write through on each update for now (simple & reliable)
      // You can optimize later.
      await this.saveToStorage();

      // Broadcast to watchers
      this.broadcast({
        type: "update",
        now: Date.now(),
        boat: next,
        boats: this.getActiveBoats(),
      });

      return Response.json({ ok: true, boatId });
    }

    return new Response("Not found", { status: 404 });
  }

  private getActiveBoats(now = Date.now()): BoatState[] {
    const out: BoatState[] = [];
    for (const b of this.boats.values()) {
      if (now - b.t <= ACTIVE_MS) out.push(b);
    }
    // Stable sort for UI
    out.sort((a, b) => a.boatId.localeCompare(b.boatId));
    return out;
  }

  private broadcast(msg: any) {
    const data = JSON.stringify(msg);
    for (const ws of [...this.sockets]) {
      try {
        ws.send(data);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  private async loadFromStorage() {
    const stored = await this.state.storage.get<StoredState>(STORAGE_KEY);
    if (stored?.boats) {
      for (const [id, b] of Object.entries(stored.boats)) {
        if (b && typeof b === "object") {
          this.boats.set(id, b as BoatState);
        }
      }
    }
  }

  private async saveToStorage() {
    const obj: Record<string, BoatState> = {};
    for (const [id, b] of this.boats.entries()) obj[id] = b;
    await this.state.storage.put(STORAGE_KEY, { boats: obj } satisfies StoredState);
  }
}
