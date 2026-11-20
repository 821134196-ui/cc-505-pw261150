# Signal Loop · 异常检测反馈闭环

分析人员对异常给出判断（真实 / 误报 / 数据问题），附证据与处理动作；反馈汇总成**新版本**的检测规则，
经**回测**验证后由人显式启用。历史告警永远保留原判断与产生它的版本。

## 快速开始

```bash
npm install
npm run seed          # 生成演示数据（含 v2 草案与回测）
npm run build         # 构建前端
npm start             # http://localhost:8787
```

开发模式（前端热更新 + API 代理）：

```bash
npm run dev           # 前端 :5173，API :8787
```

其它命令：

```bash
npm test              # 后端单元 + API 集成测试（node:test，26 项）
npm run test:e2e      # Playwright 端到端测试（10 项）
npm run seed -- --reset   # 清空并重建演示数据
```

环境变量（见 `.env.example`）：`PORT`、`DB_PATH`。
运行时需要 Node ≥ 22.5（使用内置 `node:sqlite`，无需原生依赖）。

演示账号可在左下角切换（陈晓 / 李明 / 王芳 / 周涛），请求通过 `x-analyst` 头携带身份；
生产环境应替换为真实会话鉴权。

## 数据模型

| 表 | 作用 |
|---|---|
| `series` / `observations` | 监控序列与原始观测点 |
| `config_versions` / `config_rules` | 版本化检测规则（草稿 / 生效 / 已退役） |
| `anomalies` | 告警；固定记录 `config_version_id` 与检测时的阈值 |
| `feedback` | 反馈明细；**不可变**，撤销只写 `revoked_at` 等字段 |
| `version_feedback` | 版本采纳了哪些反馈、为什么（可追溯） |
| `backtests` | 每次派生时的回测摘要与分序列明细 |
| `audit_log` | 标注、撤销、版本操作的审计轨迹 |

## 关键设计

### 1. 反馈可合并、可撤销

- 同一异常可以有多条反馈。**有效反馈**按提交顺序（`seq`）合并：
  结论取最新一条，证据去重后拼接，动作取并集，并标记 `contributors` 与 `conflicted`。
- 撤销是软删除：记录保留在时间线中，`revoked_at / revoked_by / revoke_reason` 必须填写原因并进入审计日志。
- 撤销后立即重算该异常的当前判断；若撤的是最后一条，异常回到「未复核」。

### 2. 冲突不静默覆盖

若新反馈与现有结论不同，服务端返回 `409 VERDICT_CONFLICT`；调用方必须显式传
`supersedeConflicts: true` 才会追加。双方记录都保留，异常标记为「结论冲突」，UI 与筛选器均可看到。

### 3. 并发安全

- 每个异常带 `revision` 乐观锁。提交时必须带上读取到的 `expectedRevision`，不匹配则
  `409 REVISION_CONFLICT` 并返回当前 revision，避免丢失更新。
- 撤销使用条件更新 `WHERE revoked_at IS NULL`，并发撤销只有一个真正落库，其余幂等返回同一结果。
- 支持 `requestId` 幂等键：网络重试不会产生重复反馈。
- 所有写操作在 `BEGIN IMMEDIATE` 事务内完成；SQLite 开启 WAL 与 `busy_timeout`。

「并发验证」页可在浏览器里一键复现：5 个并发标记 → 恰好 1 个成功、4 个 `REVISION_CONFLICT`；
再 5 个并发撤销 → 只有一次落库。

### 4. 反馈如何影响规则（且只在新版本生效）

派生新版本时**只读取未撤销的反馈**，折算方式：

| 反馈 | 规则变化 |
|---|---|
| 误报 + 复核阈值 / 静音 | 提高该序列 `z_threshold`，至少越过该误报点的 \|z\|，单步不超过 1.5 倍，绝对上限 6 |
| 数据问题 / 静音 / 修正基线 / 修复采集 | 排除该时刻前后 1 小时的窗口：既不告警、也不参与基线估计 |
| ≥2 条数据问题 | 基线窗口加倍（上限 336 小时），稀释被污染的基线 |
| 真实异常 | 不改变规则（作为回测标签使用） |

版本状态机：`draft → active → retired`。启用需要显式确认；启用时**只切换规则**，
不回写 `anomalies.config_version_id`，因此历史告警的版本归属与判断保持不变。
新告警由扫描用生效版本产生，天然带上新版本号。

### 5. 回测

在同一段历史观测上分别重放父版本与候选版本，用有效反馈作为标签计算：

- 精确率 = TP / (TP + FP)，召回率 = TP / (TP + 漏报的已标注真实异常)，F1；
- 告警数、误报数、数据问题数，以及分序列的新增 / 消除告警。

演示数据上，v2 相对 v1：精确率 60% → 100%，告警 13 → 8，误报 2 → 0，召回率保持 100%。

## 页面

| 路径 | 内容 |
|---|---|
| `/` | 反馈构成、最新待复核、生效版本与待启用草案 |
| `/anomalies` | 异常队列（搜索 / 序列 / 级别 / 复核状态筛选）、详情抽屉、反馈时间线、提交与撤销 |
| `/versions` | 版本链、规则差异、回测指标与分序列明细、启用流程 |
| `/concurrency` | 并发标记与并发撤销的现场验证 |
| `/audit` | 审计日志 |

图表遵循 dataviz 规范：单序列不设图例、2px 线、直接标注、十字准线 tooltip、可切换数据表；
调色板已用 `validate_palette.js` 在明暗两种模式下校验通过。

## 目录结构

```
server/
  index.js          HTTP 层与错误映射
  seed.js           确定性演示数据（seedWithDraft 供测试复用）
  lib/db.js         模式、事务、审计
  lib/engine.js     纯函数：重放检测、规则派生、版本差异、回测
  lib/service.js    业务服务：反馈聚合/撤销、版本、扫描、指标
  test/             node:test 单元与 API 集成测试
web/src/            React 前端（页面、组件、图表、数据层）
e2e/                Playwright 测试与独立测试服务器
```

## 已知边界

- 演示用 SQLite 单写者；生产可替换为 Postgres 并把 `revision` 乐观锁、条件更新原样迁移。
- 身份来自请求头，未做鉴权与角色控制。
- 扫描是手动触发的批处理（`POST /api/scan`），演示中未接入定时调度。
