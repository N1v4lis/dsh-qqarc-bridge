# dsh-dev-task-bridge

> **在 QQ 里说一句「开发 加个签到功能」，DSH 里真的动手做，做完把结果渲染成长图发回原群。**
>
> DSH（DeepSeek Harness）侧的 Host 插件（Cordis bundle）。它与配套的 QQ Agent 插件
> [`dev-coding`](docs/qq-side.md) 组成一条闭环：QQ 消息 → DSH 会话 → 干活 → 长图回传。

```
QQ 群：管理员发「开发 加个签到功能」
   │
   ├─[1] QQ 侧 dev-coding 自开 WebSocket 收到消息（不经过模型、不花 token）
   ├─[2] 鉴权：接入白名单 → 插件群白名单 → 群主/管理员/主人
   ├─[3] 写共享任务文件 tasks.json（status=pending；带 taskId / instruction / sessionIdHint）
   ├─[4] 回群里一句「收到啦～编号 #N」
   │
   ├─[5] DSH 侧本插件轮询任务文件（或收到 HTTP 通知后立刻扫）
   │        目标会话 = 任务里的 sessionIdHint（那个会话不在 → 退回默认目标，不让任务卡死）
   │        agent.followup(message) 注入 —— idle 会话也会被唤醒，直接开新一轮
   ├─[6] 该会话的 Agent 真的动手做事
   ├─[7] 做完调用 dev_task_result 工具回传（没调用也有"轮次结束兜底"）
   │
   ├─[8] 本插件 POST http://127.0.0.1:<端口>/dev/notify
   ├─[9] QQ 侧写回任务文件 status=done + markdown
   ├─[10] 无头 Chrome/Edge 渲染成长图 → data/dev-coding/reports/<taskId>.png
   └─[11] 回到原群 / 原私聊：一句说明 + 一张长图
```

---

## 为什么值得单独做一个插件

- **不花 token 的入口**：QQ 侧自己开 WebSocket 判定指令与鉴权，模型完全不参与。
- **两个进程各自只写自己那份数据**：任务文件只有 QQ 侧写，结果只有 DSH 侧通过 HTTP 回传 ——
  跨进程"读—改—写"同一个 JSON 必然丢数据，这条约定是设计底线。
- **注入用 `agent.followup()` 而不是 `inject()`**：`inject()` 只塞上下文、**不唤醒**驱动，
  表现为"消息进去了但机器人不动"；`followup()` 会入 next-turn 队列并唤醒 idle 会话。
- **能自己诊断**：`/dev-task/status`、`/dev-task/metrics`、`/dev-task/sessions`、`/dev-task/qq`
  四条只读路由，把"为什么没投进去 / 长图右上角为什么是 — / 会话到底叫什么 id / 结果发给了哪个号"摊开给人看。

---

## 安装（DSH Host 插件）

本插件是一个 **Cordis bundle**：`package.json` 里声明 `dsh.bundle.patch`，
`cordis.patch.yml` 负责把 loader entry insert 进 profile。

1. 把包装进 profile（`<DSH_HOME>/profiles/<profile>`）：
   ```bash
   pnpm add <本地路径 | git+https://github.com/<you>/dsh-dev-task-bridge.git>
   ```
2. 在 profile 的 `package.json` 里，把 `dsh-dev-task-bridge` 追加到
   **`dsh.profile.bundles`**（按 `dependencies` 的键序）。
3. **重启 DSH**。入口模块是 ESM，改了插件代码必须重启才会换模块代次。
4. 验证：
   ```bash
   curl.exe -s http://127.0.0.1:19387/dev-task/status
   ```
   返回 JSON 即已加载；`revision` 告诉你跑的是哪一代代码。

> ⚠️ **不要在 profile 的 `cordis.patch.yml` 里重复 insert 本插件** —— 会产生两行同 id 的 entry，
> 那一行会永久变成 `unaddressable`（既激活不了、也无法用界面开关管理）。bundle 自带的 patch 已经负责 insert。

> ⚠️ **桌面版 DSH（Electron）** 的 profile 由应用独占管理，CLI 的 `dsh plugin --profile desktop add`
> 会被拒绝；请用应用自带的 pnpm 在 profile 目录里 `add`，再改 `dsh.profile.bundles`，最后重启应用。

---

## 使用

### 从 QQ 投递（主路径）

在群里（或私聊里）由管理员发送，关键词后**必须有分隔符**（空格、`：`、`，`、`.` 等）：

```
开发 给机器人加一个每天 9 点提醒交作业的功能
```

`开发加个签到` 不触发 —— 这是故意的，否则「开发者大会要开始了」会被当成指令。

### 从命令行投递（调试用）

```bash
# 用会话 id
curl.exe -s -X POST http://127.0.0.1:19387/dev-task \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"session-1406fdfe-...\",\"text\":\"测试：说一句你好\"}"

# 或者用**会话名**（重名会返回 409 + 候选列表，不会瞎挑）
curl.exe -s -X POST http://127.0.0.1:19387/dev-task \
  -H "Content-Type: application/json" \
  -d "{\"sessionName\":\"Coding回传\",\"text\":\"测试\"}"
```

### 看看有哪些会话（DSH 界面不显示 session-id，所以有这条命令）

```bash
node tools/list-sessions.mjs                     # 列出会话：id / 名字 / 工作目录 / 最近活动
node tools/list-sessions.mjs --resolve "Coding回传"   # 名字 → id（重名会列出候选）
node tools/list-sessions.mjs --q "QQ Agent" --days 7
```

---

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEV_TASK_QQ_TARGETS` | — | 多 QQ 回传目标。`158732453:8765,487271667:8865`（带账号 = 按来源账号回传）或 `8765,8865`。不配则自动发现 `8765/8865/8965/9065` |
| `DEV_TASK_QQ_PORT` | `8765` | 单端口时的回传口（兼容旧配置） |
| `DEV_TASK_TASKS_FILE` | `<QQ_AGENT_HOME>/data/dev-coding/tasks.json` | 指定单个任务文件（多账号时不用它） |
| `QQ_AGENT_HOME` | `E:\QQ Agent` | QQ Agent 家目录（多账号的 `accounts/<uin>/…` 挂在它下面） |
| `DEV_TASK_SESSION` | — | 兜底目标会话（**只在没有握手记录时**生效；握手文件是权威） |
| `DEV_TASK_POLL_MS` | `4000` | 任务文件轮询间隔 |
| `DEV_TASK_TOKEN` | — | 可选共享密钥：设置了则请求必须带 `x-dev-task-token` |
| `DSH_HOME` | `~/.dsh` | DSH 家目录（会话区与握手文件都在它下面） |

---

## HTTP 接口（本机回环，带轻量信任栅栏）

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/dev-task` | 投递需求：`{ sessionId \| sessionName, text, taskId?, accountUin?, notifyPort? }` |
| `GET` | `/dev-task/status` | 插件自检：`revision` / `defaultSession` / `agents` / `qqTargets` / `sessionsIndexed` |
| `GET` | `/dev-task/sessions` | **会话区清单**（`?days=&limit=&q=`） |
| `GET` | `/dev-task/qq` | **多 QQ 诊断**：各回传端口探活 + 任务文件清单 |
| `GET` | `/dev-task/metrics?taskId=` | 长图右上角 token/时长的取值过程（查"为什么是 —"） |
| `POST` | `/dev-task/scan` | 立刻扫一次任务文件；带 `sessionId`/`sessionName` 可顺手改指向 |

信任模型：只放行**回环 Host**、同源 `Origin`、非 `cross-site`；可选共享密钥。
这些路由是给本机脚本与 QQ 侧插件用的，因此**不套 DSH 的 cookie 鉴权**。

---

## 三个高频问题（详见 [docs/sessions-and-multiqq.md](docs/sessions-and-multiqq.md)）

**1. DSH 的「会话区」在哪？怎么按名字选？命名会影响吗？**

- 会话本体：`~/.dsh/sessions/<项目目录编码>/session-<uuid>/session.v4.jsonl.zstd`（zstd 分帧 JSONL）。
- 名字与元数据：`~/.dsh/storages/session_projcache/sessions/session-<uuid>.json`
  → `record.rows.title.val`（GUI 显示的名字）、`record.identity.cwd`（工作目录）、
  `record.rows.sessionListMetadata.val.lastPromptAt`（最近提问时间）。
- **会话身份是 `session-<uuid>`，名字只是显示用**：改名字不会改身份（名字根本不在会话目录里）；
  名字**可以为空**、**可以重名**（实测本机两个会话都叫「连通性测试」）。
  所以按名字选择时命中多个会返回 `AMBIGUOUS_TITLE` + 候选，**不瞎挑**；DSH 界面不显示 id，
  可以用 `node tools/list-sessions.mjs` 或 `GET /dev-task/sessions` 看。

**2. 多 QQ 怎么适配？**

- 每个 QQ 号一份 QQ Agent 插件实例，端口 = `8765 + (序号-1)*100`；
  任务文件也按账号分开（`accounts/<uin>/plugins/dev-coding/tasks.json`）。
- 本插件：结果**按任务来源账号**回传（`DEV_TASK_QQ_TARGETS` 带账号，或自动发现后按端口推断）；
  扫描会覆盖**全部账号**的任务文件；`GET /dev-task/qq` 一条命令看清每个号是否在线、定向到哪个会话。
- 单账号时行为与旧版**完全一致**（只有一个端口，不会多打请求）。

**3. 用图片回传吗？怎么连 QQA？**

- **用图片**：结果由 QQ 侧的无头 Chrome/Edge 渲染成竖长图发回原会话（长图底部不会被裁：
  报告 HTML 会把真实 `body.scrollHeight` 写进 `data-content-height`，渲染前先量高度再加留白）；
  连续失败会退回直接发文字。
- **连接方式**：DSH 侧 → QQ 侧走 `POST http://127.0.0.1:<port>/dev/notify`（回环、可选共享密钥）；
  QQ 侧 → DSH 侧走 `POST http://127.0.0.1:19387/dev-task`（或直接写任务文件由 DSH 轮询）。
  两边共享一个**握手文件** `~/.dsh/dev-task-bridge.json`（`sessionId` / `notifyPort` / `tasksFile` / `targets`），
  谁先起谁后起都能对上。

---

## 开发与验证

```bash
npm test        # 12 条纯函数断言：会话索引、名字歧义、多 QQ 端口解析、任务文件发现、契约
npm run smoke   # 伪造 Cordis ctx，把 6 条路由真跑一遍（不需要重启 DSH）
npm run sessions -- --limit 10
```

`npm run smoke` 是这套代码的"防自欺"装置：插件跑在 DSH 进程里，改完要重启 DSH 才生效，
而重启会掐掉正在对话的会话 —— 冒烟台让**改完立刻能验证**（真依赖、真注册、真调用）。

改这个插件前请读 [docs/development.md](docs/development.md) 里的六个坑（顶层 await、
裸 import `@deepseek-ai/*`、重复 insert、热重载留下旧实例、`writable` 只读属性、
改代码要同时改 `REVISION`）。

---

## 目录结构

```
lib/index.js      插件主体（Cordis apply：路由、工具、扫描、握手、兜底）
lib/sessions.js   会话区索引与选择、多 QQ 目标解析（纯函数，可离线测）
tools/            补丁脚本、离线冒烟、会话清单 CLI
test/             纯函数测试（node --test）
docs/             设计说明、开发坑、QQ 侧对接
cordis.patch.yml  bundle 的 loader entry（insert 由它负责）
```

## License

[MIT](LICENSE)
