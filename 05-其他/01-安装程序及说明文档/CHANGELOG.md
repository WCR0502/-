# CHANGELOG

## 2.0.0 · 2026-11-12 · 后端主导的 Agent Runtime

### 架构
- 从「档案 + 回答（consultations/answers）」升级为 **Case File + Agent Loop**：服务端持有唯一事实来源，前端只渲染 Case File 并收集输入。
- 新增 `server/agent/`：`turnService`（一轮 turn 的完整顺序）、`coordinator`（ASK / PLAN / HANDOFF / DONE）、`safetyEngine`（确定性规则）、`factExtractor`、`questionBank`、`planner`、`modelGateway`、`toolRegistry`。
- 唯一对话入口 `POST /api/cases/:id/turn`：最多 6 个追问、每轮最多 1 次模型调用、`clientTurnId` 幂等、急诊立即中止。
- 旧 `consultations` 接口与 `consultationService` 删除；旧表保留为 `legacy_reports` / `legacy_share_links`，历史数据不删。

### 数据库（002_agent_runtime.sql）
- 新增 `cases`、`case_facts`、`turns`、`reports`、`share_links`（含 audience / snapshot_json / case_id）、`care_kits`、`care_circle_members`、`care_circle_questions`、`teachback_sessions`；`llm_calls` 增加 `case_id`。
- 事实唯一索引 `(case_id, key)`；`turns.client_turn_id` 唯一（幂等）；索引按提示词第七节补齐。

### 安全
- Safety Engine：红旗命中即急诊；`finalUrgency = max(rule, model)`；65+ 不给 observe；妊娠出血/腹痛/头痛升级；抗凝药 + 头部外伤升级；关键信息缺失不给 observe；卒中记录「最后正常时间」；急诊措辞改为「不要自行用药，听从 120 调度员指导」。
- 红旗新增「大舌头」「半边发麻」「右手没力」「胸口被压住 + 冷汗」等表述，规则集扩到 30 条急诊测试句。
- 模型网关：熔断（连续 5 次失败停 60 秒）、严格 JSON、Zod 校验、科室白名单、禁忌词、失败回退规则版；prompt 带版本号；不记录原文。
- 日志脱敏新增 `message` / `text` / `instruction`；`llm_calls` 只记任务与状态。

### 5 个功能（服务端优先，全部有 feature flag）
- Care Kit 就医准备包、Communication Card 沟通卡、Care Circle 家属协同、Teach-back 2.0 诊后回授、Emergency Card 急诊卡。
- 每个功能都是 Tool Registry 里的服务端工具，再谈 UI；关闭 flag 后主流程不受影响（404/403 之外无副作用）。

### 前端
- `api.js` 改为 Case File 客户端（createCase / turn / report / share / trace / 5 功能），浏览器只存 caseId。
- `booking.js`：追问改为 `turn`（一轮一问），报告走 `/report`；修复 `finishAssessment` 依赖已删除 `window.LLM` 导致始终走本地规则的问题。
- 分享改为 `/share/:token`；新增 `tools.js` + `tools.css`：5 个功能的弹层承载、打印版式、离线缓存。
- 结果页新增「就医工具」卡片，不新增导航。

### 工程
- `tests/` 重写为 100 条：单元（红旗 30/否定 20、安全门控 20、事实抽取、题库、校验）+ 集成（Agent Loop、安全、边界、5 功能）。
- `scripts/smoke.js` 改为新链路（session → consent → case → turn → report → trace → share → carekit → revoke）。
- README 增补「后端就是 Agent Runtime」、新接口表与表说明；`.env.example` 增加 5 个 feature flag。

## 1.1.1 · 2026-11-12 · 状态诚实化 + 冒烟脚本

### 修复
- `/api/llm/status` 与 `/readyz` 之前只看“Key 配了没有”，配了一把失效的 Key 时仍报 `ready:true`，前端胶囊显示「AI 已就绪」而后台其实全走规则版。现在 `llm.health()` 会读最近一次真实调用：10 分钟内出现 `NO_KEY / RATE_LIMIT / TIMEOUT / NETWORK / UPSTREAM` 即判为降级，返回 `ready:false`、`error:<code>`、`degraded:true`、`mode:'rule'`。
- `/readyz` 增加 `llmReason` 字段，便于运维区分“没配 Key”和“Key 失效”。
- 前端跟着后端语义对齐：`initModel()` 缓存后端给的 `error` 码，胶囊与横幅按真实原因说话（“未配置”与“Key 失效”不再混为一谈）；清掉 `llmRetry` 和 `config.js` 注释里“检查 llm.config.json”的失效指引（该文件已删除，应看 `.env`）。

### 新增
- `scripts/smoke.js`：端到端冒烟脚本（`node scripts/smoke.js`），覆盖 session → consent → consultation → followups → answers → report → share → revoke → 撤销后 404 共 10 步，用于演示前自检。

## 1.1.0 · 2026-11-12 · 后端与安全改造

### 架构
- 从「静态文件服务 + /api/llm 代理」改为 **Fastify 5 + SQLite（node:sqlite）+ Zod** 的真后端；`node server.js` 启动方式保留。
- 静态根从项目根目录收敛到 `public/`；`llm.config.json` 删除，Key 只从 `.env` / 环境变量读。
- 前后端拆层：`server/routes`、`server/services`、`server/safety`、`server/middleware`；前端新增 `assets/js/api.js` 作为唯一接口层。
- `assets/assets` 重复目录、`probability.js`、`llm.js` 删除。

### 数据库
- 新增迁移 `server/db/migrations/001_init.sql`：`sessions`、`consents`、`consultations`、`answers`、`reports`、`share_links`、`llm_calls`、`audit_log`、`feedback` + 索引。
- 开启 WAL、`foreign_keys=ON`、`busy_timeout=5000`；启动自动迁移，另有 `npm run migrate`。
- better-sqlite3 在 Windows 需要 MSVC，装不上会卡住演示，改用 Node 22 内置 `node:sqlite`（无原生编译），SQL 与接口不变。

### 新接口
- 会话/同意：`POST/GET /api/session`、`POST/GET /api/consent`
- 档案：`POST/GET /api/consultations`、`GET/PATCH /api/consultations/:id`、`/answers`、`/followups`、`/report`、`/share`
- 分享：`GET/DELETE /api/share/:token`
- 其他：`GET /api/hospitals`、`GET /api/exam-fees`、`POST /api/feedback`、`GET /healthz`、`GET /readyz`
- 保留兼容：`/api/geo/regeo`、`/api/geo/around`、`/api/geo/status`、`/api/llm/status`、`/__medecho`

### 安全
- 只静态服务 `public/`；`path.relative` 校验，拒绝 `..`、绝对路径、点文件、`server/`、`tests/`、`data/`、`node_modules/`；`.json/.md/.env/.db` 一律不可取。
- 匿名会话（32 字节随机，HttpOnly + SameSite=Lax，生产 Secure）+ CSRF（HMAC 绑定会话）+ Origin 白名单。
- 限流：IP 60 次/分钟（429），每会话模型调用 20/小时、100/天；请求体 32KB。
- 安全头：CSP、X-Content-Type-Options、Referrer-Policy、Permissions-Policy、HSTS（反代层）。
- 统一错误结构，不回堆栈、SQL、路径；日志脱敏 chief / answer / cookie / token；`llm_calls` 不记原文。
- 越权读取一律 404，不泄露「存在但无权限」。

### 医疗安全
- 删除「疾病概率」卡片、接口与 `probability.js`；结果页改为「可能涉及的系统与就诊方向」+「需要医生优先排除的急症」。
- 删除演示模板里的药名、mg、每日次数，统一「请以医生处方为准」；取药核对只保留流程信息（几次 / 饭前饭后 / 何时复诊）。
- 服务端红旗规则引擎（11 类）+ 否定句处理（按小句、排除「无诱因」），命中即 emergency。
- `finalUrgency = max(ruleUrgency, modelUrgency)`；65 岁以上与孕妇不给 observe；未知科室回退全科医学科；报告含禁词整条丢弃并回退规则版。
- 报告校验：字段长度、枚举、科室白名单、输出护栏。
- 知情同意（版本 + 时间 + IP hash）；急诊页加 `tel:120`、卒中「最后正常时间」提示、措辞改为「不要自行用药，听从 120 调度员指导」。
- 新增人口学字段：年龄区间 / 性别 / 怀孕 / 抗凝药（65 岁门控与妊娠门控依赖它们）。

### 前端
- 新增 `api.js`（会话、CSRF、档案、分享）、`share.js`（只读视图）、`a11y.js` + `a11y.css`（大字 / 高对比 / 弹层 / 只读 / 打印字号）。
- 分享从 `?share=1` 改为 `?share=<token>`：服务端快照，24 小时有效，可撤销。
- 刷新可恢复最近一份档案与报告；回答逐条落库。
- 顶栏新增 AI 状态胶囊（AI 已就绪 / 规则版 / AI 超时已降级），替换原先不存在的 `#aiChip` 引用。
- 删除写死的 86% / 80% / 0-5 步进度，改为按真实字段计算。
- 清理 `symptomForm` / `symptomInput` / `charCount` 等空引用。

### 工程
- 新增 `tests/`（node:test，58 条：单元 + 集成）、`Dockerfile`、`docker-compose.yml`、`nginx.conf.example`、`.env.example`、`.gitignore`、`scripts/migrate.js`。
- README 重写：目录结构、接口、安全边界、部署、数据边界。

### 已知问题
- 随包分发的旧模型 Key 已失效（上游 401），当前默认走规则版；在 `.env` 填入自己的 Key 即可恢复 AI。
- 前端 `assets/js/config.js` 仍带高德 JS API Key —— Web 端 JS API 的 Key 必须下发到浏览器，这是该服务的设计；如需收紧，请在高德控制台配置域名白名单。
- E2E（Playwright）未纳入 `npm test`：本机没有可用浏览器，改用 `app.inject` 覆盖接口全链路。
