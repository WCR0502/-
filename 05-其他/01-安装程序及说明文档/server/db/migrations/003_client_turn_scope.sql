-- 003_client_turn_scope.sql
-- 幂等键的作用域应当是「同一份 Case File」，
-- 不同档案之间允许复用同一个 clientTurnId（前端会话可能跨档案复用计数器）。

DROP INDEX IF EXISTS uq_turns_client;

CREATE UNIQUE INDEX IF NOT EXISTS uq_turns_client
  ON turns(case_id, client_turn_id)
  WHERE client_turn_id IS NOT NULL;
