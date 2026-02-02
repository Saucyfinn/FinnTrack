CREATE TABLE IF NOT EXISTS vessels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  vessel_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,
  share_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (vessel_id) REFERENCES vessels(id)
);

CREATE INDEX IF NOT EXISTS idx_trips_vessel_started
  ON trips(vessel_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_trips_share_code
  ON trips(share_code);

CREATE TABLE IF NOT EXISTS track_points (
  point_id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  acc REAL,
  speed REAL,
  heading REAL,
  battery REAL,
  source_device_id TEXT,
  uploaded_at INTEGER NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE INDEX IF NOT EXISTS idx_points_trip_ts
  ON track_points(trip_id, ts);

CREATE TABLE IF NOT EXISTS trip_latest (
  trip_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  acc REAL,
  speed REAL,
  heading REAL,
  battery REAL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE INDEX IF NOT EXISTS idx_latest_ts
  ON trip_latest(ts DESC);

