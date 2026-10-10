# QQ 侧对接：`dev-coding` 插件（QQ Agent 插件）

DSH 侧的本插件只负责"把需求注入会话、把结果回传"，**QQ 那一半在 QQ Agent 里**。
本文写清两边必须对齐的契约 —— 换一台机器部署时照着核对即可。

---

## 一、QQ 侧做什么

| 步骤 | 行为 |
|---|---|
| 1 | **自己开 WebSocket** 监听 QQ 消息（不经过模型、不花 token） |
| 2 | 鉴权链：核心接入白名单 → 插件群白名单 → 群主/管理员/主人 |
| 3 | 关键词命中且**后面有分隔符**（空格 / `：` / `，` / `.`）才算指令 |
| 4 | 写共享任务文件：`status=pending` + `instruction` + `taskId` + `sessionIdHint` |
| 5 | 回群里一句编号回执（可选） |
| 6 | 等 DSH 侧回传（HTTP `/dev/notify`，或自己轮询任务文件补捞） |
| 7 | 无头 Chrome/Edge 把 markdown 渲染成**竖长图** → `data/dev-coding/reports/<taskId>.png` |
| 8 | 回到**原群 / 原私聊**：一句说明 + 一张长图（渲染连续失败则退化成发文字） |

插件设置里可配：触发关键词、额外管理员、机器人主人、生效群白名单、目标会话 ID、
回传端口、单任务超时、长图宽度/质量。

---

## 二、端口与多账号

```
端口 = 8765 + portOffset()        portOffset = (PROFILE_ID - 1) * 100
  第 1 个号 → 8765   第 2 个 → 8865   第 3 个 → 8965 …
```

> ⚠️ **注意"默认值"与"生效值"的区别**：`portOffset` 只在设置了环境变量 `QQ_AGENT_PROFILE`
> 时才非零；而插件设置里的 `port` 是**显式值，会覆盖默认值** —— 本机实测两份配置
> （`data/config.json` 与 `accounts/<uin>/config.json`）都写着 `"port": 8765`，
> 所以进程里实际只有一个回传口。**真正的多账号部署必须给每个账号配不同的 `port`**
> （否则第二个实例 `EADDRINUSE`，日志里只有一条告警，然后通知口静默失效、只剩文件轮询）。

任务文件（**每个账号一份**）：

| 形态 | 路径 |
|---|---|
| 旧 / 主账号 | `<QQ_AGENT_HOME>/data/dev-coding/tasks.json` |
| 多账号隔离 | `<QQ_AGENT_HOME>/accounts/<uin>/plugins/dev-coding/tasks.json` |

DSH 侧会：扫**全部**这些文件、按任务来源账号决定回传端口、并自动探
`8765 / 8865 / 8965 / 9065` 发现实例（`GET /dev-task/qq` 可以看结果）。

---

## 三、两边共享的握手文件

路径（两处都读，任取其一）：`%DSH_HOME%\dev-task-bridge.json` 与 `%USERPROFILE%\.dsh\dev-task-bridge.json`

```jsonc
{
  "sessionId": "session-1406fdfe-...",   // 当前定向的 DSH 会话（权威）
  "notifyPort": 8765,                    // DSH → QQ 的回传端口
  "tasksFile": "E:\\QQ Agent\\data\\dev-coding\\tasks.json",
  "targets": [ { "uin": "158732453", "port": 8765 } ],   // 多 QQ（v6 起）
  "bridgeReady": true,
  "updatedAt": 1791…
}
```

**约定（踩坑后定的）**：

- DSH 侧**只在没有记录时**才改写 `sessionId`；有记录就**连文件都不碰**
  （"永久绑定"靠这条活着，启动瞬间 GUI 还没挂上会话时的"瞎猜"不会冲掉人工定向）。
- 卸载时**不删**文件，只写 `bridgeReady:false` + `stoppedAt`。
- 写入是**合并**：文件里人工加的字段（`pinnedBy` / `pinnedAt`）不会被冲掉。

---

## 四、HTTP 契约（两边必须一致）

### DSH → QQ

```
POST http://127.0.0.1:<notifyPort>/dev/notify
Content-Type: application/json
x-dev-task-token: <可选，与 DEV_TASK_TOKEN 一致时必需>

{
  "taskId": "…", "status": "done|failed", "ok": true,
  "markdown": "…",            // 结果正文（渲染长图用）
  "title": "…", "files": 3, "reason": "",
  "finishedAt": 1791…,
  "durationMs": 12345, "usage": { "inputTokens": …, "outputTokens": …, "cacheReadTokens": …, "steps": … },
  "notifyPort": 8765          // DSH 侧回填：本条是从哪个端口发出去的（便于排查多账号路由）
}
```

握手事件也走这个口：`{ "event": "bridge-ready", "sessionId": "…", "targets": [...] }`。

### QQ → DSH

```
POST http://127.0.0.1:19387/dev-task
{ "sessionId": "session-…" | "sessionName": "Coding回传",
  "text": "完整的 instruction 文本",
  "taskId": "…", "requestId": "…",
  "accountUin": "158732453", "notifyPort": 8765 }   // 多账号：带上来源，结果才会回到提问的号
```

> 也可以**不调 HTTP**：只写任务文件，DSH 侧每 4 秒扫一次（`DEV_TASK_POLL_MS`）。
> 任务文件是**唯一真相来源**，HTTP 只是"加速口"。

### 自检口（两边各一个，排查时最先看这两个）

```powershell
curl.exe -s http://127.0.0.1:8765/dev/status          # QQ 侧：wsConnected / targetSessionId / tasksFile / keywords
curl.exe -s http://127.0.0.1:19387/dev-task/status    # DSH 侧：revision / defaultSession / agents / qqTargets
```

---

## 五、任务文件的字段（QQ 侧写、DSH 侧读）

```jsonc
{
  "tasks": {
    "t-1791…": {
      "taskId": "t-1791…",
      "status": "pending | done | failed",
      "seq": 12,                       // 回执里显示的编号
      "task": "给机器人加一个每天 9 点提醒交作业的功能",   // 需求原文
      "instruction": "【开发任务 #12】…",                 // 注入会话的完整文本
      "sessionIdHint": "session-…",    // 投递那一刻的定向（会话不在 → DSH 侧退回默认目标）
      "from": "123456", "fromName": "群友", "kind": "group", "chatId": "987654",
      "chatLabel": "群 987654",
      "notifyPort": 8765,              // 多账号：结果回这个端口
      "createdAt": 1791…,
      "status_meta": { "markdown": "…", "title": "…", "finishedAt": 1791…, "usage": {…} }
    }
  }
}
```

**唯一写者原则**：`tasks.json` 只有 QQ 侧写；DSH 侧一律通过 HTTP 回传
（跨进程"读—改—写"同一个 JSON 必然丢数据）。DSH 侧仅在自己 HTTP 回传失败时，
才**退化成写回来源账号那一份文件**，并记日志。

---

## 六、部署时的检查清单

1. QQ 侧插件已启用，`GET http://127.0.0.1:<port>/dev/status` 返回 JSON；
2. DSH 侧插件已加载，`GET http://127.0.0.1:19387/dev-task/status` 返回 JSON 且 `revision` 是当前版本；
3. 握手文件存在，且 `sessionId` 指向一个**你会在 DSH 里开着的**会话；
4. `GET /dev-task/qq` 里对应端口的 `ok:true`；
5. 在群里发一条 `开发 说一句你好` → 群里应收到编号回执 → 完成后收到长图。

---

## 七、QQ 侧多账号的真实缺口（审计结论，部署前必读）

下面是**逐行读 `dev-coding/index.js` 得到的**风险清单。结论：**QQ 侧目前只在"单账号"下成立**；
想在同一进程里真跑两个 QQ 号，必须逐条处理（本插件 DSH 侧已经就绪，等这一半）。

| # | 缺口 | 位置 / 表现 |
|---|---|---|
| 1 | **端口写死** | 配置里显式 `"port": 8765`（覆盖 `8765 + portOffset()`）；`DEFAULTS.port` 本身是**进程级常量**，无法按账号取值 → 第二个账号必然 `EADDRINUSE`，只打一条告警后**静默退化为仅文件轮询** |
| 2 | **单一 WS 连接** | `let socket` 是模块级单例，`connection()` 只解析"当前 ALS/active 账号"的配置；模块加载即 `start()`（无 ALS）→ 只连一个号，另一个号的群消息永远收不到；多实例并存会互相踢连接 |
| 3 | **回发客户端单例** | `onebot` 在首条消息时按"当时的账号配置"构造并永久缓存 → 后续 `sendText/sendImage` 可能用**另一个号的端点与令牌** |
| 4 | **数据目录按账号解析失效** | `__qqaPluginDir()` 依赖 ALS，但轮询定时器 / `restoreInflight` / `notifyBridge` / HTTP 回调**都在没有 ALS 的裸回调里** → 恒回落 `data/dev-coding`（实测 `accounts/<uin>/plugins/dev-coding` 从未生成）。`traceDir()` 更是完全没有账号维度 |
| 5 | **模块级状态不分片** | `inflight / seen / finished / roleCache / handledCommands / suppressArm / shotFails / chromePathCache / adoptedSessionId / traceFile / onebot / socket / server` 全是进程级；taskId 撞表时去重闸会把 A 号的回执"让给"B 号（图直接丢） |
| 6 | **握手/定向是进程级单值** | `adoptedSessionId`、`bridgeFileMtimes`、`bridgeConfigFiles()` 都没有账号维度 → 两个号的需求会投进**同一个 DSH 会话**，结果图只发给"最后写握手文件的那个号" |
| 7 | **热重载会重置模块状态** | `booted` 是模块内变量；重载后新模块直接 `start()`，首句 `disconnect()` 会按**无 ALS 时的配置**（active 账号）重连，期间所有内存状态清空 |
| 8 | **资源互抢** | `chrome-profile` 共用同一 `user-data-dir`（两个号同时出图会抢 profile 锁）；`shotFails` 单例 → 一个号渲染失败会连带另一个号在 3 次后彻底停用长图 |

**建议的修法（QQ 侧）**：把"账号"提升为一等参数 —— 端口/WS 连接/onebot 客户端/数据目录/握手槽位
全部按 `uin` 分片（进程内一张 `Map<uin, …>`），定时器与 HTTP 回调显式带上账号上下文
（而不是依赖 ALS），并给每个账号独立的 `chrome-profile`。

---

## 八、当前（本机）实况快照：QQ 侧收不到消息

```text
data/dev-coding-diag/dev-coding.log 尾部：
  开发指令监听未连上（连接关闭），30s 后重试第 1850 次        （2026-10-10 19:29）

data/dev-coding/tasks.json：19 条，全部 done，最后一条 2026-10-02 19:56
```

即：**自建 WS 长期连不上 → 群里发指令不会被接收**（此时只有 HTTP 通知口与文件轮询还活着，
所以"DSH 侧主动投递"仍可用）。排查顺序：先看 `GET /dev/status` 的 `wsConnected`，
再确认协议端（SnowLuma/QQ）在跑、令牌与端口对得上。
