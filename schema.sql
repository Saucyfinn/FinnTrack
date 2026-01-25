CREATE TABLE IF NOT EXISTS track_points (
  raceId TEXT NOT NULL,
  boatId TEXT NOT NULL,
  t INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  sog REAL,
  cog REAL,
  name TEXT,
  PRIMARY KEY (raceId, boatId, t)
);

CREATE INDEX IF NOT EXISTS idx_track_race_time ON track_points (raceId, t);
CREATE INDEX IF NOT EXISTS idx_track_race_boat_time ON track_points (raceId, boatId, t);
