-- 002_agent_runtime.sql · Case File + Agent Runtime
-- 目标：把“consultation + answers”升级为“Case File + turns”，
-- 并补齐 share / 5 个功能 / trace 需要的表。
-- 旧表改名保留（legacy_*），不删除历史数据。

ALTER TABLE reports RENAME TO legacy_reports;
ALTER TABLE share_links RENAME TO legacy_share_links;
ALTER TABLE llm_calls ADD COLUMN case_id TEXT;

-- 唯一事实来源：Case File
CREATE TABLE IF NOT EXISTS cases (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'intake',
  chief         TEXT NOT NULL,
  age_band      TEXT NOT NULL DEFAULT 'unknown',
  sex           TEXT NOT NULL DEFAULT 'unknown',
  pregnant      TEXT NOT NULL DEFAULT 'unknown',
  anticoagulant TEXT NOT NULL DEFAULT 'unknown',
  rule_urgency  TEXT NOT NULL DEFAULT 'routine',
  model_urgency TEXT NOT NULL DEFAULT 'routine',
  final_urgency TEXT NOT NULL DEFAULT 'routine',
  red_flags_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- 结构化事实：每个事实都有 source / confidence / updatedAt
CREATE TABLE IF NOT EXISTS case_facts (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  source      TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
);

-- 对话循环：用户 turn、助手问题、工具结果、trace 都落这里
CREATE TABLE IF NOT EXISTS turns (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  action          TEXT,
  question        TEXT,
  answer          TEXT,
  tool_name       TEXT,
  tool_result_json TEXT,
  latency_ms      INTEGER,
  client_turn_id  TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
);

-- 计划（报告）：服务端生成，前端只渲染
CREATE TABLE IF NOT EXISTS reports (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL,
  summary        TEXT NOT NULL,
  depts_json     TEXT NOT NULL,
  systems_json   TEXT NOT NULL,
  priority       TEXT NOT NULL,
  booking_advice TEXT NOT NULL,
  home_advice    TEXT NOT NULL,
  red_flags_json TEXT NOT NULL,
  model          TEXT,
  source         TEXT NOT NULL DEFAULT 'rule',
  created_at     TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
);

-- 分享：token hash + 脱敏快照，与 Case File 解耦
CREATE TABLE IF NOT EXISTS share_links (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  audience      TEXT NOT NULL DEFAULT 'family',
  snapshot_json TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
);

-- 12.1 Care Kit 就医准备包
CREATE TABLE IF NOT EXISTS care_kits (
  id           TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL,
  items_json   TEXT NOT NULL,
  checked_json TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
);

-- 12.3 Care Circle 家属协同
CREATE TABLE IF NOT EXISTS care_circle_members (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS care_circle_questions (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  text        TEXT NOT NULL,
  selected    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY(member_id) REFERENCES care_circle_members(id) ON DELETE CASCADE
);

-- 12.4 Teach-back 2.0 诊后回授
CREATE TABLE IF NOT EXISTS teachback_sessions (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL,
  instruction_json TEXT NOT NULL,
  answers_json    TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cases_session      ON cases(session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_case_facts_case    ON case_facts(case_id, key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_facts   ON case_facts(case_id, key);
CREATE INDEX IF NOT EXISTS idx_turns_case         ON turns(case_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_turns_client ON turns(case_id, client_turn_id) WHERE client_turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_case_reports       ON reports(case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_case_share_token   ON share_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_circle_case        ON care_circle_members(case_id, role);
CREATE INDEX IF NOT EXISTS idx_circle_questions   ON care_circle_questions(case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_case           ON llm_calls(case_id, created_at);
