import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH = process.env.DB_PATH
  || path.join(process.cwd(), 'data', 'signal-loop.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS series (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL,
  detector      TEXT NOT NULL,
  description   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_versions (
  id                TEXT PRIMARY KEY,
  version           INTEGER NOT NULL UNIQUE,
  label             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  notes             TEXT NOT NULL DEFAULT '',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  parent_version_id TEXT,
  activated_at      TEXT,
  backtest_id       TEXT,
  revision          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS config_rules (
  version_id            TEXT NOT NULL,
  series_id             TEXT NOT NULL,
  z_threshold           REAL NOT NULL,
  baseline_window_hours INTEGER NOT NULL,
  min_consecutive       INTEGER NOT NULL,
  excluded_windows      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (version_id, series_id),
  FOREIGN KEY (version_id) REFERENCES config_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS observations (
  id         TEXT PRIMARY KEY,
  series_id  TEXT NOT NULL,
  ts         TEXT NOT NULL,
  value      REAL NOT NULL,
  expected   REAL,
  z          REAL,
  injected   INTEGER NOT NULL DEFAULT 0,
  processed  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_obs_series_ts ON observations(series_id, ts);
CREATE INDEX IF NOT EXISTS idx_obs_pending ON observations(processed);

CREATE TABLE IF NOT EXISTS anomalies (
  id                    TEXT PRIMARY KEY,
  observation_id        TEXT NOT NULL UNIQUE,
  series_id             TEXT NOT NULL,
  ts                    TEXT NOT NULL,
  detector              TEXT NOT NULL,
  score                 REAL NOT NULL,
  value                 REAL NOT NULL,
  expected              REAL NOT NULL,
  severity              TEXT NOT NULL,
  config_version_id     TEXT NOT NULL,
  threshold_at_detection REAL NOT NULL,
  detected_at           TEXT NOT NULL,
  revision              INTEGER NOT NULL DEFAULT 0,
  current_verdict       TEXT,
  verdict_updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_anom_series ON anomalies(series_id);
CREATE INDEX IF NOT EXISTS idx_anom_version ON anomalies(config_version_id);
CREATE INDEX IF NOT EXISTS idx_anom_verdict ON anomalies(current_verdict);

CREATE TABLE IF NOT EXISTS feedback (
  id            TEXT PRIMARY KEY,
  anomaly_id    TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('true_positive', 'false_positive', 'data_issue')),
  evidence      TEXT NOT NULL,
  action        TEXT NOT NULL,
  note          TEXT,
  analyst       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  revoked_at    TEXT,
  revoked_by    TEXT,
  revoke_reason TEXT,
  request_id    TEXT UNIQUE,
  FOREIGN KEY (anomaly_id) REFERENCES anomalies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_feedback_anomaly ON feedback(anomaly_id, seq);
CREATE INDEX IF NOT EXISTS idx_feedback_verdict ON feedback(verdict);

CREATE TABLE IF NOT EXISTS version_feedback (
  version_id TEXT NOT NULL,
  feedback_id TEXT NOT NULL,
  reason     TEXT NOT NULL,
  PRIMARY KEY (version_id, feedback_id)
);

CREATE TABLE IF NOT EXISTS backtests (
  id                  TEXT PRIMARY KEY,
  version_id          TEXT NOT NULL,
  baseline_version_id TEXT NOT NULL,
  version_revision    INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  summary             TEXT NOT NULL,
  details             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backtests_version ON backtests(version_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`;

export function openDb(file = DEFAULT_DB_PATH) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function audit(db, { actor, action, entityType, entityId, detail = {} }) {
  db.prepare(
    `INSERT INTO audit_log (at, actor, action, entity_type, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(nowIso(), actor, action, entityType, entityId, JSON.stringify(detail));
}

export function count(db, sql, ...params) {
  return db.prepare(sql).get(...params)?.n ?? 0;
}
