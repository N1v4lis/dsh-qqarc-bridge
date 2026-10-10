# 会话区、命名、多 QQ：实现依据与设计决策

本文回答三个在建这个桥接时最容易被问住的问题，**所有结论都来自本机实测**（DSH Desktop 0.2.0-rc.2，
Windows，2026-10-10），不是推测。每条都给出可复核的路径/命令。

---

## 一、DSH 的「会话区」到底在哪、怎么读

### 1.1 两个目录，各管一半

| 目录 | 内容 | 谁写 |
|---|---|---|
| `~/.dsh/sessions/<项目目录编码>/session-<uuid>/session.v4.jsonl.zstd` | **会话本体**：zstd **分帧**的 JSONL 事件日志 | DSH |
| `~/.dsh/storages/session_projcache/sessions/session-<uuid>.json` | **投影缓存**：标题、工作目录、最近提问时间等 | DSH |

投影缓存的实际结构（实测）：

```jsonc
{
  "version": 1,
  "record": {
    "identity": { "formatVersion": 4, "createdAt": 1791…, "cwd": "E:\\QQ Agent Dev" },
    "rows": {
      "title":  { "ver": 1, "seq": 10344, "val": "Coding回传" },   // ← GUI 显示的名字，可为 null
      "titleInput": { "ver": 3, "seq": 10344, "val": { "first": {…}, "count": 101, "lastSeq": 10253 } },
      "sessionListMetadata": { "ver": 1, "seq": 10344, "val": { "blank": false, "lastPromptAt": 1791631783520 } },
      "goal": {…}, "todos": {…}, "tokenUsage": {…}, "subagent": {…}
    }
  }
}
```

**为什么不用扫日志拿标题**：日志是 zstd **分帧**的，普通解压只拿到第一帧（踩过）；
而投影缓存就是给"列表/标题"用的现成结构，读它最稳、也最快。

### 1.2 枚举实现（`lib/sessions.js`）

```
readdir ~/.dsh/sessions/*/session-*/        → 得到全部会话（含历史）
读 storages/session_projcache/sessions/<id>.json → 补上 名字 / cwd / lastPromptAt
排序：有 lastPromptAt 的按时间倒序在前，没有的按日志 mtime 倒序垫底
```

排序那条规则是**踩出来的**：早先用 `max(lastPromptAt, mtime)` 混排，结果"从没被提问过、
但日志刚被 touch 过"的会话会挤到第一位，把真正的最近会话顶下去（离线测试里有断言盯着）。

### 1.3 「项目目录编码」是有损的 —— 别拿它当工作目录

实测：`E:\QQ Agent Dev` → `--E-QQ~0020Agent~0020Dev--`（空格 → `~0020`，`:` 去掉，`\` → `-`），
但 `E:\DSH-WechatWork` → `--E-DSH-WechatWork--` —— **字面连字符与路径分隔符都是 `-`**，
所以"反解"只能得到近似值。工作目录的**权威来源**是投影缓存里的 `record.identity.cwd`。

---

## 二、选哪个会话？命名会影响吗？

### 2.1 会话身份 = `session-<uuid>`，名字只是显示用

- 名字**不在会话目录里**（会话目录只有 `session.v4.jsonl.zstd` 一个文件），
  它躺在投影缓存里 —— 所以**重命名在结构上就不可能改身份**。
- 名字**可以为空**：`title.val === null` 的会话在本机是常态（新建但没起标题）。
- 名字**可以重名**：实测 `--E-Deepseek~0020Harness--` 下两个不同会话的标题都叫「连通性测试」。

结论：**选择目标会话的主力必须是 id**。名字只做"给人用的入口"。

### 2.2 于是解析规则长这样（`resolveSession`）

| 优先级 | 写法 | 说明 |
|---|---|---|
| 1 | `session-1406fdfe-5b90-4273-b9a9-c68f582e981e` | 完整 id |
| 2 | `1406fdfe` / `session-1406` | **id 短前缀**（DSH 界面不显示 id，这条最实用） |
| 3 | `Coding回传` | 名字**完全匹配**；命中多个 → `AMBIGUOUS_TITLE` + 候选 |
| 4 | `Coding` | 名字**子串匹配**；命中多个 → `AMBIGUOUS_TITLE` + 候选 |

命中多个时**绝不静默挑一个** —— 那是"任务投到了另一个会话里"这种最难查的故障。
接口直接返回候选列表（id + 名字 + 工作目录），让人改用 id。

### 2.3 一个硬约束：注入要求会话**活着**

`agent.followup()` 需要一个活着的 agent。所以：

- 历史会话可以**列出**、可以**预先指定**（写进握手文件），但要等它在 DSH 里被打开才能真正投递；
- 任务里带 `sessionIdHint`（投递那一刻的定向）—— 如果那个会话已经不在，插件会**退回默认目标**
  并告警，而不是把任务卡在"等会话打开"里直到超时。

### 2.4 怎么看到 id（DSH 界面不显示）

```bash
node tools/list-sessions.mjs                  # 人看的表
node tools/list-sessions.mjs --resolve "Coding回传"
curl.exe -s "http://127.0.0.1:19387/dev-task/sessions?limit=20"
```

---

## 三、多 QQ（QQ Agent 多账号）怎么适配

### 3.1 QQ 侧的形态

- 每个 QQ 号一份插件实例，端口 = **`8765 + portOffset()`**（`portOffset = (PROFILE_ID-1) * 100`，
  第二个号 8865，第三个 8965 …）。
- 任务文件按账号分开：
  - 旧/主账号：`<QQ_AGENT_HOME>/data/dev-coding/tasks.json`
  - 多账号：`<QQ_AGENT_HOME>/accounts/<uin>/plugins/dev-coding/tasks.json`
- QQ 侧的 `GET /dev/status` 会回报 `tasksFile / targetSessionId / wsConnected / keywords / reports`
  —— 这就是自动发现的依据。

### 3.2 DSH 侧的三件事

1. **回传按来源账号**（`notifyTargetFor`）：
   任务里写死的 `notifyPort` > 账号→端口映射（`DEV_TASK_QQ_TARGETS`）> 唯一目标 > 兜底 `8765`。
   结果失败的端口不再重试，会**依次尝试其它已配置端口**，并把尝试过程写进返回值（`tried`）。
2. **扫描覆盖全部账号**：`scanOnce` 扫旧位置 + 注册表推断的每个账号 + 发现到的 `tasksFile`；
   任务被记住时带上 `accountUin / notifyPort / sourceFile`，回写兜底时写回**来源那一份**文件。
3. **自动发现**（`discoverQqInstances`）：探 `8765 / 8865 / 8965 / 9065`，
   从 `GET /dev/status` 读出实例信息，缓存 60 秒（扫描每 4 秒一次，不能每次都探）。

```bash
curl.exe -s http://127.0.0.1:19387/dev-task/qq
```

```jsonc
{
  "configuredTargets": [],                     // 没配 DEV_TASK_QQ_TARGETS 就空着
  "probes": [
    { "port": 8765, "ok": true,  "wsConnected": true,  "targetSessionId": "session-…", "declared": false },
    { "port": 8865, "ok": false, "note": "端口没人监听（这个 QQ 号没开，或插件未启用）" }
  ],
  "taskFiles": [ { "kind": "legacy", "path": "…tasks.json", "exists": true } ]
}
```

### 3.3 单账号时不会退化

`QQ_TARGETS` 默认解析成 `[{ uin: '', port: 8765 }]`：只有一个目标时"依次尝试"就一次，
握手与回传行为跟旧版**逐字节一致**（这条有离线断言）。

---

## 四、为什么用图片回传，以及图片怎么才不被裁

- **用图片**：群里读长结论最舒服，也是用户明确要的形态。渲染在 **QQ 侧**做（无头 Chrome/Edge），
  DSH 侧只负责把 markdown 交出去 —— 这样 DSH 不必依赖浏览器，QQ 侧失败还能退化成发文字。
- **不裁底部**（两次踩坑的结论）：
  1. `--screenshot` 只截**视口高度**，不能按字符数猜视口 —— 报告 HTML 会把真实
     `body.scrollHeight` 写进 `<html data-content-height>`，渲染前用 `--dump-dom` 量一次，加 60px 留白再截；
  2. 量高度只能用 `document.body`：`documentElement.scrollHeight` **至少等于视口高度**，
     内容比视口矮时会把图撑出一大片空白（实测 1574px 的卡片被量成 2365px）。
     配套做法：量高那趟把视口调矮（`--window-size=<width>,800`），取
     `body.scrollHeight` 与 `body.getBoundingClientRect().height` 的较大者。

### 4.1 链路已确认（实测取证）

本机 QQ 侧 `data/dev-coding/reports/` 里的历史结果图，直接读 PNG 头拿真实尺寸：

| 文件 | 尺寸 | 体积 |
|---|---|---|
| `dvt-muqwqoyw-9808be.png` | **720 × 1905** | 156 KB |
| `dvt-muqwplml-9163f2.png` | **720 × 1696** | 144 KB |
| `dvt-mun0lc05-d0d443.png` | **720 × 2521** | 213 KB |

即：宽度固定 720（`shotWidth`），高度随内容 1.7k–2.5k 像素 —— **竖长图形态成立**，
且不是"固定高度 + 底部留白"那种（高度与内容量相关）。回发顺序是先文字后图，
带三级回退（图片两条路都失败 → 正文当文字发；截图失败 → 只发文字；连续 3 次失败本轮不再出图）。

---

## 五、两边怎么"连上"（握手与降级）

| 方向 | 通道 | 说明 |
|---|---|---|
| DSH → QQ | `POST http://127.0.0.1:<port>/dev/notify` | 回环 + 可选 `x-dev-task-token` |
| QQ → DSH | `POST http://127.0.0.1:19387/dev-task` | 也可只写任务文件，由 DSH 轮询 |
| 双向共享 | `~/.dsh/dev-task-bridge.json` | `sessionId / notifyPort / tasksFile / targets / bridgeReady` |

握手文件的四条保证（都是踩坑后加的）：

1. **卸载时不删**，只写 `bridgeReady:false` + `stoppedAt`（删了等于丢掉"永久绑定"）；
2. **永远不写空值**（启动瞬间 GUI 还没挂上会话时，写空会把记录冲掉）；
3. **每次扫描自动补绑**：钉住的会话还活着就一直用它；真没了才重新挑并写回；
4. **写入是合并**，不冲掉人工加的字段（`pinnedBy` / `pinnedAt`）。

降级链：HTTP 回传失败 → 直接写任务文件（QQ 侧下次轮询/重启会补发）→ 仍失败则告警。

---

## 六、权威入口修正：能用服务就别读磁盘

上面 §1 的磁盘布局是**兜底方案**。真正的权威是 Host 服务（只读调研 + 契约实取得到）：

### 6.1 `sessionQuery`（`@deepseek-ai/dsh-session-query`）—— 唯一"全部会话（含历史）"入口

```
listSessions(signal?): Promise<SessionRecord[]>            // complete logical corpus, newest-first
readTitleSnapshots(ids, signal?): Promise<Observation[]>   // 批量、保序、单条失败隔离
readSession(sessionId): Promise<{session, events}>         // 全量事件（算 token 用这个）
listEvents(sessionId)                                      // 轻量，**不含 data** → 算不了 token
```

- `SessionRecord = { header, live, persisted }` —— **只有 header，没有名字**；名字要再用
  `readTitleSnapshots(ids)` 折一次（`SessionTitleSnapshot = { title, messageSeqs, source, eventSeq, updatedAt }`）。
- **必须自己过滤 subagent 会话**：`header.parentSession != null` 或 `header.origin === 'subagent'`。
  本机 34 个会话里有 16 个是 subagent（它们在磁盘上用**裸 uuid** 目录名，没有 `session-` 前缀）。
- **归档 ≠ 不存在**：`listSessions()` 是完整语料，包含归档会话；要与 GUI 一致，
  得再用 `workspaceRegistry.archivedSessionIds` 剔除。
- 它是**可选依赖**：必须 `ctx.get('sessionQuery')` 判空（本插件就是这么做的，
  并且把结果来源写在接口返回里：`source: 'sessionQuery' | 'disk'`）。

### 6.2 标题是**事件**，不是元数据

```json
{"type":"session/title","seq":14,"time":1791631827997,"data":{"title":"Coding回传","messageSeqs":[9],"source":{"kind":"fallback"}}}
```

`foldSessionTitle` 用 `findLast` —— **最后一条胜出**；`source.kind ∈ fallback | provider | user`
（`user` = 用户手动重命名）。会话 header 里**没有名字字段**，所以"改名"根本不触及身份。

### 6.3 磁盘日志是 **zstd 分帧**容器（解析时最容易踩的坑）

`session.v4.jsonl.zstd` 是"多个可独立解码的 zstd 帧拼接"，**第 1 帧恰好只有 header 一行**。

- ✅ 正确：扫 magic `0x28 B5 2F FD` 逐帧解（首帧 = header），或用 `zlib.createZstdDecompress()` 流式解；
- ❌ 错误：`zstdDecompressSync(整个文件)` —— **只解第一帧、不报错、静默丢掉后面全部事件**
  （实测 160KB 的日志有 62 帧，首帧 269B，其余 160KB 全丢）。

### 6.4 投递到"冷"（历史）会话的正路

`sessionController.prompt`（`@deepseek-ai/dsh-api-session-controller`）：

```js
await ctx.get('sessionController').prompt({
  requestId: crypto.randomUUID(),          // 重复 requestId 幂等
  sessionId,
  mode: 'queue',                           // 'steer' 是插队；'queue' 排下一轮
  content: [{ type: 'text', text }],
})
```

它内部会 `resolveAgent` → `ctx.agents.resume({ resumeSessionId, … })` → `followup`，
即**自动唤醒历史会话**。手搓 `agents.resume` 要自己提供 `setup`（agent preset 组合），细节多，
所以优先用 `prompt`。

> **本版（1.0.0）的状态**：枚举已走"服务优先 + 磁盘兜底"；**冷会话投递尚未接线** ——
> 目前注入仍要求目标会话在 DSH 里活着（有存活 agent），否则任务会被记为"暂时投不进去"并重试。
> 接线 `sessionController.prompt` 是下一步（见 CHANGELOG 已知限制）。

### 6.5 用户怎么看到会话 ID（GUI 不显示）

| 途径 | 说明 |
|---|---|
| `node tools/list-sessions.mjs` | 本插件提供：列出 id ↔ 名字 ↔ 工作目录 |
| `GET /dev-task/sessions` | 同上，HTTP 版（QQ 侧与脚本都能调） |
| **GUI 的 `/export` 命令** | 把会话日志导出成 ZIP，**首行 header 就带 id** |
| 磁盘 | `~/.dsh/sessions/<项目>/<session-…>` 目录名；`storages/session_projcache/sessions/<id>.json` 文件名 |

（实测：GUI 只显示标题、没有"复制会话 ID"入口、URL 也不带 id —— 所以上面这几条是仅有的途径。）
