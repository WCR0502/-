-- 001_init.sql · 同频 MedEcho 初始表结构
-- 所有时间统一 ISO 8601 字符串（UTC），便于比较与迁移。

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  ip_hash       TEXT
);

CREATE TABLE IF NOT EXISTS consents (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  version     TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  ip_hash     TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS consultations (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  chief         TEXT NOT NULL,
  age_band      TEXT NOT NULL,
  sex           TEXT NOT NULL,
  pregnant      TEXT NOT NULL,
  anticoagulant TEXT NOT NULL,
  status        TEXT NOT NULL,
  rule_urgency  TEXT NOT NULL DEFAULT 'routine',
  final_urgency TEXT NOT NULL DEFAULT 'routine',
  red_flags_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS answers (
  id              TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL,
  ordinal         INTEGER NOT NULL,
  label           TEXT NOT NULL,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
  id              TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL,
  summary         TEXT NOT NULL,
  depts_json      TEXT NOT NULL,
  systems_json    TEXT NOT NULL,
  priority        TEXT NOT NULL,
  booking_advice  TEXT NOT NULL,
  home_advice     TEXT NOT NULL,
  red_flags_json  TEXT NOT NULL,
  model           TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS share_links (
  id              TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id               TEXT PRIMARY KEY,
  session_id       TEXT,
  consultation_id  TEXT,
  task             TEXT NOT NULL,
  model            TEXT,
  latency_ms       INTEGER,
  status           TEXT NOT NULL,
  error_code       TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  session_hash TEXT,
  event        TEXT NOT NULL,
  meta_json    TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  rating      INTEGER NOT NULL,
  comment     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consultations_session ON consultations(session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_answers_consultation   ON answers(consultation_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_reports_consultation   ON reports(consultation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_share_token            ON share_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_llm_calls_consultation ON llm_calls(consultation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_session      ON llm_calls(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created          ON audit_log(created_at);
