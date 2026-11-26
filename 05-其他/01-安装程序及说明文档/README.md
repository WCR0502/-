# 同频 MedEcho · 症状梳理与就医安排

一个面向**中老年、听障用户**的就医协作交互原型。打开后只需要写一句“哪里不舒服”，系统会用几轮大白话追问帮你整理，再告诉你该多快去医院、挂哪个科，并可以定位查看附近医院与演示号源。

## 界面结构（五页，一次只做一件事）

| 页 | 内容 | 怎么进 |
|---|---|---|
| 1 · 说症状 | 快捷点选（头疼/咳嗽/胸闷…），也可以直接说一句；首次进入先过知情同意与 4 条基本信息 | 打开即是 |
| 2 · 答问题 | 一次一问，**点选优先**：每题 3–4 个大按钮，不想点才自己写 | 点“开始” |
| 3 · 看结果 | 摘要 / 该多快去医院 / 挂哪个科 / 注意事项（急诊时压缩成一屏三步） | 问题答完自动进入 |
| 4 · 找医院 | 定位按钮、附近医院、可挂的号 | 结果页点“找附近的医院” |
| 5 · 就诊档案 | 行程状态条 + 我想问的 + 医生说的 + 医嘱（逐条确认）+ 取药核对 + 本次健康摘要 | 挂号后，或结果页点“看就诊档案” |

- 顶栏四个位置标签（首页 / 症状梳理 / 就医指南 / 健康档案）：当前页加粗、已过的加深，只做提示不可点击。
  其中「症状梳理」一个标签同时对应「02 补充细节」与「03 就医建议」两屏，所以两屏之间高亮不变。
- 地址栏同步 `#start / #ask / #result / #hospital / #record`。

**视觉与操作上的取舍**：浅绿渐变横幅 + 圆角白卡；正文 14px、卡片标题 15px、页面主标题 29–40px、主按钮高 46px；
颜色对比按 WCAG AA 收紧；一屏只放一件事；号源从 7 列表格改回一张卡片一个号；能点就不打字（全流程文字输入 ≤ 2 次：主诉 + 偶尔的补充）。

> 每屏的「设计稿元素 → 代码位置」对照见 `设计稿对照.md`。

## 三个"一句话讲清"的设计

1. **点选优先**（减少打字）：每道追问由模型附带 3–4 个短选项，点一下就作答；选项里永远有「说不清」，另留「都不是，我自己写」。听障用户打字负担最小，也少暴露 ASR 的出错面。
2. **一张就诊档案**（填平断层）：提问卡、医生的回答、医嘱落在同一张卡上——进门到回家看的是同一份东西。医嘱是**模型草稿 + 患者逐条确认**，未确认的会一直显示「待确认 N 条」。
3. **就诊像打车**（状态可见）：已挂号 → 候诊中 → 问诊中 → 取药 → 完成 的状态条，演示时可手动推进；「发给家属」由服务端生成一次性 `?share=<token>` 只读链接（24 小时有效、可撤销），家属看到同一份档案与同一进度。

**取药时回授**：状态推进到「取药」，自动出现 3 道点选复述题（一天几次 / 饭前饭后 / 多久复诊），选错会提示回看医嘱。把复述校验放在等药的时间，不占医生一分钟。

**打印**：就诊档案可输出 **A4 单页就诊卡**（`window.print()`）——一张纸放齐「就诊日期 / 科室医生 / 就诊进度 / 症状与咨询计划 / 就诊准备 / 健康摘要」，给不会用智能手机的患者带走。版式源文件为 `assets/css/visit-card-print.css` + `assets/js/visit-card.js`；`?card=1` 可先在屏幕上按原尺寸预览这张纸。

## 启动

```bash
npm install          # 只有第一次需要；装的是后端依赖
node server.js       # 或双击 启动.bat
```

浏览器访问 `http://localhost:5173`。**不装依赖也能跑**：数据库用 Node 22 内置的 `node:sqlite`，没有原生编译步骤。

首次启动会自动建库并执行迁移（`data/medecho.db`），也可以单独跑 `npm run migrate`。

## 当前流程

1. 第 1 页直接输入症状描述，不需要从列表里选疾病。
2. **危险红线**：先判断是否存在急症信号（意识改变、呼吸困难、大量出血、疑似卒中/心梗、剧烈头痛、抽搐）。命中就跳过追问，直接给急诊结论。
3. **追问**：模型每轮出 2–3 个问题、逐条提问，最多 2 轮（4–6 问）；信息够了会提前收尾。未接入模型时改用内置规则，按「位置 / 时间 / 性质 / 伴随 / 背景」逐项补齐。
4. **结论**：给出摘要、就医紧迫度（立即急诊 / 1–3 天内门诊 / 近期门诊 / 可先观察）、建议科室与三条注意事项。
5. **医院与号源**：定位后按半径搜索周边医院，号源只取自本次定位到的医院。

## 号源来源规则

- 号源由「本次定位 + 当前搜索半径」返回的医院 POI 生成，只保留最近的 10 家；列表、医院下拉、地图高亮共用同一份数据。
- 同一家医院的门诊楼、住院部、各院区等子 POI 会归并为一条，避免一院多条重复占位。
- 每条号源带 `hospitalId`，医生由 `医院 + 科室` 派生，医生与医院强绑定，不存在跨院复用。
- 切换医院筛选、点击地图标记、点击医院列表，都走同一个选择入口，任何位置都不会回退展示其他医院的号源。
- 未定位、范围内无医院、或建议优先急诊时，号源列表为空并给出对应说明，不做兜底填充。

## 接入大模型（可选）

追问与结论默认由**内置规则**生成；配置好模型后自动切换为 AI，规则退化为兜底。

`llm.config.json` 已经删除，Key 只从环境变量读：

1. 复制 `.env.example` 为 `.env`（`.env` 不会进仓库，也不会被静态服务暴露）。
2. 填三项：

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` | 服务商接口地址，OpenAI 兼容，末尾形如 `https://api.xxx.com/v1` |
| `LLM_MODEL` | 模型名，如 `deepseek-chat`、`gpt-4o-mini` |
| `LLM_API_KEY` | 只在服务端持有，**不会下发到浏览器** |

3. 重启服务生效。页面右上角显示「AI 已就绪」即接上；显示「规则版」说明没配 Key 或模型不可用，**主流程照常能走完**。

> 包里最初那份旧 Key 已作废（上游返回 401），当前 `.env` 已换成可用的 DeepSeek Key。若页面仍显示「规则版」，重启服务并刷新即可。
> 旧 Key 曾以明文形式随包分发，**必须视为已泄露并作废**。

当前配置为 `deepseek-chat @ api.deepseek.com/v1`，实测单轮追问约 0.8–1.5 秒。备选：`deepseek-reasoner` 属思考型模型，思维链会吃满 `max_tokens`，本项目不使用；换模型只改 `.env` 的 `LLM_MODEL`，不要改提示词。

运行机制：

- 每轮由模型出 2–3 个问题，逐条追问，最多 2 轮（共 4–6 问）；信息足够时模型会提前收尾。
- 追问与摘要都要求模型返回严格 JSON；服务端会校验字段，**不合格直接丢弃并报错，不会把脏数据放进页面**。
- 任何失败（无 Key、断网、超时、上游报错、格式不对）都会自动退回内置规则，并在页面上写明原因，同时提供「重试 AI」按钮；规则版结论照常可用。
- 本地红旗规则始终优先：命中急症信号时跳过追问，且模型给出的优先级不允许被下调为普通门诊。
- 模型调用全部在服务端（`server/services/llmService.js`）完成，前端只调业务接口，拿不到 Key，也无法自行拼 prompt。

## 创新点落地情况

| 维度 | 已做进 demo | 仍是蓝图 |
|---|---|---|
| S · 替代 | 追问点选优先；医嘱「模型草稿 + 逐条确认」 | 高德 POI → 医院官方号源池接口（需授权，演示中已明确标注“演示数据”） |
| C · 合并 | **就诊档案**：提问卡 + 医生回答 + 医嘱同卡；家属只读视图 | 家属代填、家属端独立 App |
| A · 借用 | **网约车式行程状态条**，家属同步可见 | 与医院叫号系统对接，状态自动流转 |
| M · 放大/缩小 | 急诊模式一屏三步；A4 单页就诊卡打印 | 自助机打印取号、语音双通道核对 |
| R · 反转 | **取药等候时做回授核对**（3 道点选） | 医生端反向推送“必答三问” |
| E · 删减 | 去掉价格滑块/密集表格/营销文案；文字输入 ≤ 2 次 | 微信静默登录（需公众号资质） |
| P · 他用 | — | 慢病日常提醒、方言重口音人群复用 |

## 检查前心里有数（检查说明卡）

就医建议页底部与「我的档案」页各有一个入口，打开同一个说明弹层，讲**常见检查的一般流程**，用来减少患者对流程和费用的不确定，不参与分诊结论。

- 每个检查一张卡：一句话说明 → 怎么做（步骤）→ 要准备什么 → 大概要多久 → 检查之后 → 费用。
- 6 项常见检查：血常规、尿常规、腹部超声（B超）、心电图、胸部 X 光（胸片）、胃镜（上消化道内镜）。
- **必查 / 按需 标注**：每张卡在标题旁标一个定位——`常规必查`（血常规、尿常规、心电图）、`按需做`（腹部超声、胸片）、`一般不常规做`（胃镜），点开还有一句「为什么这样标」。弹层顶部可按这三个档位筛选，只描述门诊的一般配备情况，不代表对某个人的开单建议。
- 「问医生的话」给 4 句可复制的询问句（目的 / 必要性 / 费用与报销 / 准备），支持整段复制或单项复制；浏览器拦截剪贴板时，会自动把文字选中放进输入框，让用户自己 Ctrl+C 或长按复制。
- **不根据症状推荐或开具检查**：弹层里没有任何分诊结论、也没有「你应该做 XX」的表述，只说明「要不要做由医生面诊决定」。

**费用接入（/api/exam-fees）**：价格由服务端统一取数，浏览器只负责展示。

| 状态 | 触发条件 | 页面表现 |
|---|---|---|
| `live` | `llm.config.json` 配了 `hospital.feeApi.url`，且接口返回可用价格 | 绿色提示 + 每项显示「¥金额 / 次 + 价格来源 + 更新时间 + 项目编码」 |
| `demo` | 没配接口（当前演示环境） | 琥珀色「演示数据，非真实报价」+ 内置价目（`data/exam-fees.demo.json`），字段与真实接口一致 |
| `unavailable` | 配了接口但超时 / 返回空 / 非 JSON | 统一显示「暂未取得本院准确价格」，不估算金额，可点「重新读取价格」重试 |

- 对接方式：`GET {feeApi.url}`，`apiKey` 通过 `authHeader` + `authScheme` 放在请求头，**Key 只在服务端**；兼容 `items / data` 数组与 `code|item_code|chargeCode`、`price|unit_price|amount` 等常见字段，`5 分钟` 内复用缓存。
- 只展示项目价格，不含挂号、麻醉、病理加收，也不估算报销比例或报销金额；页面固定写明「以缴费单或医保结算单为准」。

## 急诊状态：不再出现任何挂号信息

红旗规则或模型判定为 `emergency` 后，`<body>` 会带上 `.is-emergency`，并一直保留到重新描述症状：

- 结果页只留「打 120 / 别吃药 / 到急诊说这一句」三步，把「查找附近医院」改成「查找附近急诊」，隐藏「看就诊档案」。
- 机构页隐藏整块「可以挂的号」（含筛选、号源统计 `个号`），改成红色提示「这个页面只用来找最近的医院」，地图与机构列表保留。
- `openRecord()` 与 `openBooking()` 各加一道代码级拦截：急诊状态下进入档案会直接跳回急救指引页，预约弹窗也不会打开。

## 健康档案收尾：本次健康摘要

档案页最后一张卡把本次流程里出现过的信息汇总成 4 块，方便一次看全、也方便念给家属听：

1. **症状与描述**——主诉 + 每一轮补充问答（按「位置 / 时间 / 性质 / 伴随 / 背景」标注）；
2. **整理方向（非诊断）**——相关人体系统与科室，明确写「不是疾病判断」；
3. **用药与医嘱（演示草稿）**——记录 / 用药 / 复诊 / 饮食，外加过敏史、既往病史两行，固定提示「必须由医生确认，不要照摘要自行买药或改剂量」；
4. **还需要补充**——在吃的药、检查资料、急诊信号，以及档案里还没确认的医嘱条数。

缺项一律写「本次未记录」，不替用户补写；摘要只读，不参与打印以外的任何判定。



## 数据和能力边界

- 地图定位和附近医院 POI 由高德地图 JS API 返回；POI 结果会过滤掉药店、医疗器械、医美、体检等非医疗机构，地点信息不能代表该院提供了某一科室、医生或号源。
- 医院名称和距离来自高德定位搜索到的周边 POI；医生姓名、职称、号源余量、就诊时段和挂号费为**虚构演示数据**，并非真实医生信息或实时号源。
- 检查价格：当前演示环境没有配置医院收费系统接口，展示的是 `data/exam-fees.demo.json` 的**演示价目**（已标注「演示数据，非真实报价」），不是任何一家医院的真实收费；配置 `hospital.feeApi.url` 后才会显示 `live` 价格。无论哪种状态，都不估算报销金额。
- 「常规必查 / 按需做 / 一般不常规做」描述的是门诊一般配备情况，用于帮助患者理解，不代表该患者需要或不需要某项检查。
- 「本次健康摘要」是对本次输入的归并展示，不是病历，也不构成诊断；缺项会明确标注未记录。
- “预约此号源”用于演示信息核对，不会向医院提交挂号。真实预约需要接入医院或合规预约平台的接口和授权。
- 就医紧急程度由关键词规则提示（红旗筛查 + 恶化/轻微信号），不能排除或确诊疾病。严重呼吸困难、意识异常、大量出血等危急情况请立即拨打 120。
- 页面给出的可能原因、科室与优先级仅用于就诊沟通，不构成诊断、处方或“是否住院”的判断。最终安排以医生评估和医院官方平台为准。

## 目录结构

```
server.js                 入口：建应用、端口探测、自动开浏览器（保留 node server.js）
server/
  app.js                  Fastify 实例：插件、路由注册、静态服务、统一错误
  config.js               环境变量读取与校验（.env 只做兜底）
  db/index.js             node:sqlite 连接、WAL、迁移执行
  db/migrations/001_init.sql   会话 / 同意 / 旧档案（legacy，保留历史数据）
  db/migrations/002_agent_runtime.sql  cases / case_facts / turns / reports / share_links / 5 个功能表
  agent/                  服务端 Agent Runtime
    turnService.js        Agent Loop：一轮 turn 的完整顺序
    coordinator.js        决策：ASK_ONE_QUESTION / BUILD_PLAN / HANDOFF / DONE
    safetyEngine.js       确定性安全引擎（红旗 + 高龄/妊娠/抗凝门控）
    factExtractor.js      事实抽取、未知项、越界标记
    questionBank.js       规则版追问题库（每个维度只问一次）
    planner.js            计划与交接摘要（规则版永远可用）
    modelGateway.js       模型网关：熔断 + 严格 JSON + Zod + 白名单校验
    toolRegistry.js       动作空间：9 个工具，带 feature flag 与权限
  routes/                 session / cases / share / hospitals / fees / feedback / health
  services/               case / share / report / hospital / fee / llm / session / audit
  services/features/      careKit / commCard / careCircle / teachBack / emergencyCard
  safety/                 redFlags（红旗规则）、reportValidator、outputGuard、departments（科室白名单）
  middleware/auth.js      匿名会话、CSRF、Origin 校验
public/                   唯一可被静态访问的目录
  index.html
  assets/css|js
data/                     exam-fees.demo.json（演示价目）、medecho.db（运行时生成）
tests/unit|integration    node:test，100 条用例
scripts/migrate.js        npm run migrate
Dockerfile / docker-compose.yml / nginx.conf.example
.env.example              只放占位符
```

- `public/assets/css/a11y.css`：AI 状态胶囊、大字/高对比、知情同意弹层、只读视图、打印字号下限。
- `public/assets/js/api.js`：前端唯一的接口层（会话、CSRF、档案、报告、分享），不再直接调模型。
- `public/assets/js/booking.js`：分页路由 `go()`、追问流程、结论渲染、档案与分享。
- `public/assets/js/share.js`：`?share=<token>` 只读视图渲染。
- `public/assets/css/visit-card-print.css` / `public/assets/js/visit-card.js`：A4 单页就诊卡。

## 后端就是 Agent Runtime

后端不是给前端配的数据库，后端就是 Agent 本身。

| 后端组件 | Agent 角色 | 落地位置 |
|---|---|---|
| Session | 身份与连续性 | `sessions` + HttpOnly Cookie + CSRF |
| Case Store | 工作记忆 | `cases` / `case_facts` / `unknowns` |
| Turn Service | 对话循环 | `POST /api/cases/:id/turn` |
| Safety Engine | 安全守门员 | `agent/safetyEngine.js` + `safety/redFlags.js` |
| Tool Registry | 动作空间 | `agent/toolRegistry.js`（9 个工具） |
| Model Gateway | 推理与表达 | `agent/modelGateway.js` |
| Report Service | 计划生成 | `agent/planner.js` |
| Share Service | 交接 | `services/shareService.js` |
| Trace / Audit | 可观测与反思 | `turns(role=trace)` + `audit_log` |
| Rate Limit | 资源边界 | IP 60/min，模型 20/时、100/天 |

一轮 turn 的顺序（与实现一一对应）：

1. 校验 session 与 case 所有权 → 2. 读 Case File → 3. 追加用户 turn（`clientTurnId` 幂等）
→ 4. 抽取事实，抽不出的写 unknowns → 5. Safety Engine（确定性规则优先）
→ 6. 命中急诊立即返回，停止追问 → 7. Coordinator 决策
→ 8. 必要时调模型（每轮最多 1 次）→ 9. 校验输出（Zod + 科室白名单 + 禁忌词）
→ 10. 写回 Case File / turn / trace → 11. 返回动作与更新后的 Case File。

硬预算：最多 6 个追问、每轮 1 次模型调用、1 个工具调用、P95 ≤ 2.5 秒、模型失败走规则版、不允许空转。

## 接口

所有接口以 `/api` 开头，统一返回 `{ ok, data }` 或 `{ ok:false, code, message, requestId }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/session` | 建匿名会话，下发 HttpOnly Cookie，返回 csrfToken |
| GET | `/api/session` | 当前会话、同意状态；无会话 401 |
| POST | `/api/consent` | 记录知情同意（版本 + 时间 + IP hash） |
| POST | `/api/cases` | 建 Case File：主诉 + 年龄区间 + 性别 + 怀孕 + 抗凝药 |
| GET | `/api/cases` | 自己的 Case File 列表（刷新恢复只读 caseId） |
| GET | `/api/cases/:id` | 读 Case File（facts / unknowns / urgency / plan / handoff），只能读自己的 |
| PATCH | `/api/cases/:id` | 只改人口学字段与 chief；报告生成后 chief 锁定 |
| POST | `/api/cases/:id/turn` | **唯一对话入口**：一轮 = 追问 / 急诊 / 计划，带 `clientTurnId` 幂等 |
| POST | `/api/cases/:id/report` | 服务端读 Case File → 调模型 → 校验 → 落库 → 返回计划 |
| GET | `/api/cases/:id/trace` | 可展示的 trace（step / agent / action / ms），不含 prompt、Key |
| POST | `/api/cases/:id/share` | 生成 32 字节 token；存 hash + 脱敏快照；24h 过期 |
| POST | `/api/cases/:id/carekit` | 12.1 就医准备包（8–12 项，勾选落库） |
| POST | `/api/cases/:id/commcard` | 12.2 沟通卡（医生版 / 家属版，可离线） |
| POST | `/api/cases/:id/carecircle/invite` | 12.3 邀请家属（viewer / contributor，24h） |
| POST | `/api/carecircle/join` / `comment` | 家属用 token 只读加入 / contributor 加问题 |
| DELETE | `/api/carecircle/member/:id` | 撤销成员 |
| POST | `/api/cases/:id/teachback` | 12.4 诊后回授：医生原话 → 3–5 道点选题 |
| POST | `/api/teachback/:id/answer` | 核对复述，答错两次建议问医生 / 药师 |
| POST | `/api/cases/:id/emergencycard` | 12.5 急诊卡（过敏 / 用药 / 基础病 / 最后正常时间） |
| GET | `/api/features` | 9 个工具与 feature flag 状态 |
| GET | `/api/share/:token` | 脱敏快照；过期 410，撤销/不存在 404 |
| DELETE | `/api/share/:token` | 撤销分享 |
| GET | `/api/hospitals` / `/api/geo/*` | 附近医院（高德），无 Key 时降级 |
| GET | `/api/exam-fees` | 检查价目：live / demo / unavailable |
| POST | `/api/feedback` | 评分 1–5 + 备注 |
| GET | `/healthz` / `/readyz` | 存活 / 就绪（数据库探活） |

## 安全与医疗边界

**静态服务**：只服务 `public/`；用 `path.relative` 校验，拒绝 `..`、绝对路径、点文件、`server`、`tests`、`data`、`node_modules`；`.env`、`.json`、`.md`、`.db` 一律 404。`GET /llm.config.json` → 404，`/..%2f..%2fpackage.json` → 403。

**会话与越权**：32 字节随机 sessionId 放 HttpOnly + SameSite=Lax Cookie（生产加 Secure）；所有读写带 `session_id`，读别人的档案返回 404（不泄露存在性）。

**CSRF**：写请求要求 `x-csrf-token`（HMAC 绑定会话），并校验 Origin 白名单。

**限流与体量**：每 IP 60 次/分钟；每会话模型调用 20 次/小时、100 次/天；请求体 32KB；模型超时 25 秒、网络错误重试 1 次。

**日志**：pino 结构化日志脱敏 `authorization`、`cookie`、`x-csrf-token`、`chief`、`answer`；`llm_calls` 只记任务、耗时、状态，不记原文。

**医疗安全**：
1. 不再展示「疾病概率」，也不再提供概率接口；结果页改为「可能涉及的系统与就诊方向 + 需要医生优先排除的急症」。
2. 删除所有具体药名与剂量，药品相关表述统一为「请以医生处方为准」。
3. 服务端红旗规则（11 类：呼吸困难、意识改变、大量出血、疑似卒中、疑似心梗、剧烈头痛、抽搐、严重过敏、孕晚期出血、摔倒后头痛呕吐、自伤风险）优先级最高：`finalUrgency = max(ruleUrgency, modelUrgency)`，模型只能升级不能降级。
4. 否定句只作用于同一个小句（「没有胸痛，但是呼吸困难」仍判急诊）；「无诱因胸痛」不算否定。
5. 65 岁以上与孕妇不给 observe；未知科室回退「全科医学科」；报告出现「确诊 / 你得了 / 处方 / 剂量 / xx mg」整条丢弃并回退规则版。
6. 急诊页有 `tel:120` 一键拨号，卒中场景提示记录「最后正常时间」，医嘱措辞改为「不要自行用药，听从 120 调度员指导」。
7. 首次进入必须勾选知情同意（数据会发给模型服务与高德、非诊断、急症拨 120），记录在 `consents` 表。

**分享**：服务端快照 + 随机 token，URL 里没有姓名/症状/手机号；库里只存 SHA-256；24 小时过期；可撤销；过期 410、撤销 404。

## 测试

```bash
npm test            # 100 条：单元 + 集成
npm run test:unit
npm run test:integration
npm run smoke       # 端到端冒烟（需先启动服务）
```

覆盖：红旗 30 条急诊 / 20 条否定不误判、高龄 10 例 / 妊娠 5 例 / 抗凝 5 例不做 observe、事实抽取与未知项、追问不重复且最多 6 个、Agent Loop 急诊中止、幂等、刷新恢复、trace、优先级单调、科室白名单、输出护栏、会话与 CSRF、越权、分享过期 410 / 撤销 404、路径穿越 403、限流 429、日志不含主诉、5 个功能与 feature flag。

## 部署

```bash
cp .env.example .env      # 填 SESSION_SECRET / LLM_* / AMAP_WEB_KEY
docker compose up -d --build
curl http://localhost:5173/readyz
```

- 镜像基于 `node:22-slim`，非 root 运行，启动前自动迁移，`HEALTHCHECK` 指向 `/healthz`。
- SQLite 落在 `./data`（compose 里是卷），单机够用；要多副本就换 Postgres 并复用同一套 services。
- 反代示例见 `nginx.conf.example`：只暴露 443、开启 HSTS、转发 `X-Forwarded-For`。
- 上线前必须：换 `SESSION_SECRET`、换模型 Key、把 `APP_ORIGIN` 设成真实域名、开 `NODE_ENV=production`（Cookie 自动加 Secure）。

## 数据边界

- 主诉、回答、报告保存在本机 SQLite；会话 30 天过期，分享 24 小时过期。
- 模型只收到「主诉 + 回答 + 人口学字段」，不含 Cookie、IP、设备信息；IP 只以 SHA-256 前缀形式存在 `sessions/consents`。
- 高德只收到坐标（查附近医院时），不收到症状。
- 分享页只返回主诉、回答、报告、优先级，不含 sessionId、内部 id、模型名、prompt。
- 医生姓名、号源余量、挂号费仍是虚构演示数据；医院名称与距离来自高德真实 POI。
