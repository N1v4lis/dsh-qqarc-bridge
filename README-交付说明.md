# QQ Agent ⇄ DSH「开发指令」桥接 —— 交付说明与排查手册

> 这套东西让 QQ 群里的一句 `开发 xxxx` 变成真正的开发任务：需求被送进 DSH 的对话里
> 由 AI 动手做事，做完把结果渲染成一张竖长图，自动回复到**原来那个群 / 私聊**。

---

## 一、装了哪两个插件

| 半边 | 位置 | 形态 | 作用 |
|---|---|---|---|
| QQ 侧 | `E:\QQ Agent\resources\app\plugins\dev-coding\` | QQ Agent 插件（确定性型） | 监听 QQ 消息、鉴权、写任务、渲染长图、发回群 |
| DSH 侧 | `E:\QQ Agent Dev\dsh-dev-task-bridge\` | DSH Host 插件（Cordis bundle） | 把需求注入 DSH 会话、注册回传工具、收结果转交 QQ 侧 |

DSH 侧的注册方式（已经做好，重启后生效）：
- `C:\Users\Suli\.dsh\profiles\desktop\package.json` → `dependencies` 有 `dsh-dev-task-bridge: link:...`，`dsh.profile.bundles` 里有 `dsh-dev-task-bridge`
- 插件自带的 `cordis.patch.yml` 负责 insert 那一行（**不要在 profile 的 cordis.patch.yml 里再写一遍**，重复 insert 会让它变成 `unaddressable` 且永远无法管理 —— 这是踩过的坑）

---

## 二、数据流（谁写谁读）

```
QQ 群：管理员发「开发 加个签到功能」
   │
   ├─[1] QQ 侧 dev-coding 自己开 WebSocket 收到消息（不经过模型、不花 token）
   ├─[2] 鉴权：核心接入白名单 → 插件群白名单 → 群主/管理员/主人
   ├─[3] 写共享任务文件  E:\QQ Agent\data\dev-coding\tasks.json
   │        status=pending，并带上 instruction（含 taskId / sessionId）
   │        同时写上 sessionIdHint = 投递这一刻的定向会话（写死在任务里，之后不随默认会话漂）
   ├─[4] 回群里一句「收到啦～编号 #N」（可选）
   │
   ├─[5] DSH 侧 dsh-dev-task-bridge 轮询任务文件（或收到 HTTP 通知后立刻扫）
   │        目标会话 = sessionIdHint（若那个会话已不在 → 退回默认目标会话，不让任务卡死）
   │        用 agent.followup(message) 把 instruction 注入目标会话
   │        —— idle 会话也会被唤醒，直接开新一轮
   ├─[6] 该会话的 Agent 真的动手做事
   ├─[7] 做完调用 dev_task_result 工具回传
   │        （没调用也不要紧：一轮结束时自动用最终回复兜底）
   │
   ├─[8] DSH 侧 POST http://127.0.0.1:8765/dev/notify
   ├─[9] QQ 侧写回任务文件 status=done + markdown
   ├─[10] 用本机 Chrome/Edge 无头渲染成长图 → data\dev-coding\reports\<taskId>.png
   └─[11] 回到原群 / 原私聊：一句说明 + 一张长图
```

**唯一写者原则**：`tasks.json` 只由 QQ 侧写。DSH 侧一律通过 HTTP 回传，避免两个进程
"读—改—写"互相覆盖（跨进程这种写法必然丢数据）。

---

## 三、日常使用

在群里（或私聊里）由管理员发送：

```
开发 给机器人加一个每天 9 点提醒交作业的功能
```

- 关键词后**必须有分隔符**（空格、`：`、`，`、`.` 等）。`开发加个签到` 不触发 ——
  这是故意的，否则「开发者大会要开始了」会被当成指令。
- 触发后立刻收到一句编号回执；做完收到一张结果长图。
- 失败、超时（默认 30 分钟）都会在群里说明原因。

---

## 四、出问题时怎么查

### 0. 插件自己的诊断日志（最有用）

```
E:\QQ Agent\data\dev-coding-diag\dev-coding.log
```

QQ 侧插件会把自己看到的一切写在这里（关键词命中、权限判定、入队、回执、长图、
连接状态）。**不要只依赖 QQ Agent 的 data/logs**：实测打包版里插件通过 `api.log`
写的内容不会落进那个日志文件，所以这份自建日志才是排查主场。

> ⚠️ 这份日志**绝不能**改到 `data\dev-coding\` 里面去。踩过的坑：日志写在插件数据
> 目录里时，"写日志"本身会触发插件热重载 → 重扫 → 新实例又写日志 → 自激成每秒一次
> 的重载风暴（连接被反复替换、日志疯长）。诊断输出必须待在被监听范围之外。

### 1. QQ 侧状态（最快）

```powershell
curl.exe -s http://127.0.0.1:8765/dev/status
```

看三个字段：
- `wsConnected: true` → 监听连上了；`false` → 检查协议端令牌
- `targetSessionId` → 空 = 还没绑定 DSH 会话（任务会被礼貌拒收）
- `bridgeFiles[].exists` → 握手文件有没有出现

### 2. DSH 侧状态

```powershell
curl.exe -s http://127.0.0.1:19387/dev-task/status
```

返回 404/405 = 插件没加载；返回 JSON 就是活的。里面几个字段各有用途：

| 字段 | 看什么 |
|---|---|
| `revision` | **进程里跑的是哪一版代码**。改完插件代码后这个值没变 = 还是旧模块（见下面第 3 条） |
| `defaultSession` | 当前默认注入目标 |
| `agents` | DSH 里活着的会话列表（空 = 没有任何会话开着，任务投不进去） |
| `tasks` | 本插件记得的任务及其目标会话、是否已回传 |

### 3. 改完插件代码要重启 DSH（HMR 换不掉已加载的模块代次）

实测：改完 `dsh-dev-task-bridge/lib/index.js`，再用 `plugin_manager` 把插件关了再开
（返回 `application: applied`），`/dev-task/status` 里**依旧没有 `revision` 字段** ——
说明 `apply()` 被重跑了，但模块还是缓存里那一代。原因：ESM 按解析后的 URL 缓存，
`link:` 装的包文件改了、URL 没变，Node 不会重新求值；DSH 文档里也写明
"replacing an installed package requires restart to load a fresh JavaScript module generation"。

所以流程是：**改代码 → 关掉 DSH 重开 → 看 `revision` 变了才算生效**。

### 4. 一键验收（改完代码 / 换过会话之后）

```powershell
node "E:\QQ Agent Dev\_devcoding\post-restart-check.mjs"
```

它把三处状态一次对齐：DSH 侧 `revision`、DSH 侧定向、QQ 侧 `targetSessionId`、
握手文件、以及那条联调任务现在到哪一步了。有任何一项不对会列在最后。

### 5. 加载失败原因（DSH 只说 "failed to import" 时）

```powershell
Get-Content "$env:USERPROFILE\.dsh\dev-task-bridge.error.log"
```

**重要**：如果这个文件根本不存在，说明错误发生在本插件代码执行之前 ——
最常见的就是 entry 里出现了**顶层 await**（`ERR_REQUIRE_ASYNC_MODULE`）。
本插件的依赖因此改成在 `init()` 里动态 import，不要再改回顶层 await。

### 6. 长截图没出来

- 日志里搜「长截图失败」；连续失败 3 次后本次运行会退回直接发文字
- 需要本机有 Chrome 或 Edge（`C:\Program Files\...\chrome.exe` / `msedge.exe`）
- 想看看图长什么样：`data\dev-coding\reports\<taskId>.png`，同目录还有 `.html` 源

### 7. 想从命令行手工投一次任务

```powershell
curl.exe -s -X POST http://127.0.0.1:19387/dev-task `
  -H "Content-Type: application/json" `
  -d "{\"sessionId\":\"session-xxxx\",\"text\":\"测试：说一句你好\"}"
```

---

## 五、常用设置（QQ Agent → 插件页 → 开发指令）

| 设置 | 说明 |
|---|---|
| 触发关键词 | 默认「开发」，支持 `开发\|写代码` 多个 |
| 额外管理员 QQ 号 | 除群主/管理员外，额外允许谁用 |
| 机器人主人 QQ 号 | 填了之后在私聊和任何群里都能用 |
| 生效群号白名单 | 留空 = 所有群（仍要求发送者是群主/管理员） |
| 同时遵守机器人的接入白名单 | 推荐开启：与「设置 → 白名单」同口径 |
| 目标会话 ID | 留空 = 自动采用 DSH 侧写的那个；多开 DSH 会话时可手填精确指定 |
| 本机回传端口 | 默认 8765，两边一致即可 |
| 单任务超时 | 默认 30 分钟 |
| 长截图宽度 / 压缩质量 | 图太大时自动转 JPEG 并降质 |

---

## 六、已知限制

1. **默认只服务一个 DSH 会话**（`targetSessionId` / 握手文件里的 `sessionId`）。
   多开 DSH 会话时想换目标（比如旧会话废了、改到新会话），见第八节。
   每条任务还会把自己投递时的目标写进 `sessionIdHint`；那个会话要是已经不在，
   DSH 侧会退回默认目标会话，不会把任务卡在"等会话打开"里。
2. **同名插件只有一份**：QQ 侧和 DSH 侧必须同时在跑，缺一半时：
   - 缺 DSH 侧 → 群里会收到「本机开发对话还没绑定好」的说明（不会静默吞掉）
   - 缺 QQ 侧 → DSH 侧把结果直接写回任务文件，QQ 侧下次起来能补发（重启恢复已实现）
3. **任务文件只保留最近 60 条**，正在等的任务永远保留。
4. 长图内容是**结果报告的渲染**（标题/元信息/需求原文/Markdown 正文），
   不是 DSH 界面截图 —— 这样不会把你的其他对话内容发到群里。

---

## 七、改这个插件的代码前必读（热重载的四个坑，都是实测踩出来的）

改 QQ 侧插件时，下面四条任何一条踩中，表现都是"看起来加载成功了但其实不对"：

1. **不能有顶层 `await`**（DSH 侧插件尤其致命）
   DSH 加载 entry 时遇到含顶层 await 的 ESM 图会抛 `ERR_REQUIRE_ASYNC_MODULE`，
   而且**错误发生在模块体执行之前** —— 连"把错误写进文件"的兜底都来不及跑，
   界面上只有一句 `failed to import`。所以 DSH 插件的依赖统一在 `init()` 里动态
   import，由 `apply()` 去 await。

2. **DSH 侧不能裸 `import '@deepseek-ai/dsh-tools'`**
   插件是用 `link:` 装进 profile 的（junction），Node 解析说明符时走**真实路径**，
   不会去 profile 的 node_modules 找，直接 `ERR_MODULE_NOT_FOUND`。
   必须用 `createRequire` 锚在 `~/.dsh/profiles/desktop/node_modules` 上显式解析。

3. **交给 DSH 的 entry 不能有顶层 await**、**不能在 profile 里重复 insert**
   插件的 `package.json` 已经声明自己是 bundle（`dsh.bundle.patch`），
   profile 的 `cordis.patch.yml` 里**再写一遍 insert** 会产生两行同 id 的 entry，
   该行会永久变成 `unaddressable`（既激活不了、也没法用界面开关管理）。

4. **热重载会留下"活着的旧实例"，必须防它复活**
   重载不保证调用 `deactivate()`。旧实例的 WebSocket 被新实例关掉后，它的 close
   回调会安排重连，重连上来又把新实例踢掉 —— 两个实例每秒互相踢一次（日志里满屏
   "已关闭 1 条遗留连接"）。三处一起防才行：
   - 关旧连接**前**先给它打 `__devCodingEvicted` 记号，被替换过的连接不再重连；
   - 重连定时器到点时**再确认一次**"现在是否已有活连接"（定时器可能是替换前排下的）；
   - 连接/HTTP 监听放在 `globalThis` 的跨实例槽位里，最新实例才说了算。

---

## 八、换定向（把回传目标从旧会话改到另一个 DSH 会话）

"定向"只有一个落点：握手文件 `C:\Users\Suli\.dsh\dev-task-bridge.json` 里的 `sessionId`。
DSH 侧和 QQ 侧都读它。改的方法（**顺序不能反**，否则会被启动时的一次"瞎猜"冲掉）：

1. 先确认目标会话在 DSH 里开着（`/dev-task/status` 的 `agents` 里能看到它的 id）；
2. 改握手文件（或直接跑下面的脚本）；
3. 重启 DSH（让插件重新读文件；重启后 `pickDefaultSession` 会**优先采用文件里的会话**，
   不再按"最后打开的会话"乱猜；文件里那个会话还活着时启动流程也不会覆盖它）。

```powershell
# 一键重定向（顺带把卡住的联调任务改投新会话）
node "E:\QQ Agent Dev\_devcoding\rearm-live-task.mjs" <新会话ID> [结果收件人QQ]
```

只想手填也行：QQ Agent 插件设置里的「目标会话 ID」优先级最高（留空才用握手文件）。

### 八·补：让定向"永久"生效（2026-10-02 修）

**为什么会丢**：旧版桥接在**卸载时把握手文件删掉**（DSH 一退出就删）。于是每次启动都从
"没有记录"开始，只好按"最后注册的会话"猜 —— 启动瞬间 GUI 还没挂上任何会话时甚至猜出空值，
而旧代码**照样把空值写回文件**，记录就此被冲成空的，之后每次启动继续从零开始猜。
实测症状：开机后 `dev-task-bridge.json` 里 `sessionId` 是 `""`，回传投到一个不相关的会话。

**现在的四条保证**（`REVISION = v5-pinned-session`）：

1. **握手文件不再被删**：卸载改成写入 `bridgeReady:false` + `stoppedAt`，定向留着；
2. **永远不写空值**：启动时挑不到会话就只告警，不覆盖已有记录；
3. **每次扫描自动补绑**（`ensureBinding()`，跟着 4 秒的轮询走）：钉住的会话还活着就一直用它；
   真没了才重新挑，并把新目标**写回文件**，不会每次扫描重新猜；
4. **写入改成合并**：文件里人工加的字段（`pinnedBy` / `pinnedAt` 之类）不会被冲掉。

再加一道跨重启保险：用户级环境变量 `DEV_TASK_SESSION=<会话ID>` —— 只在"没有记录"时兜底
（记录仍是权威，人工改指向不会被它顶掉）。设置方法：

```powershell
setx DEV_TASK_SESSION session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**改指向的正确姿势**（现在不用重启 DSH 了，运行中的桥接会立刻改）：

```powershell
# sessionId 传进去即可：改内存目标 + 写握手文件
Invoke-RestMethod -Uri http://127.0.0.1:19387/dev-task/scan -Method POST `
  -ContentType application/json -Body '{"sessionId":"session-xxxxxxxx-…"}'
```

**核对**（两侧都要对）：

```powershell
(Invoke-RestMethod http://127.0.0.1:19387/dev-task/status).defaultSession   # DSH 侧
(Invoke-RestMethod http://127.0.0.1:8765/dev/status).targetSessionId       # QQ 侧
```

---

## 九、最贵的那个坑：注入消息的 `source.kind` 不能是 `'plugin'`

**症状**：某个 DSH 会话突然"本轮运行失败 format v4 message requires a producer-owned
source kind"，之后**每一轮都失败**，界面用不了了 —— 而不是"这条消息没发出去"。

**原因**：会话格式 v4 在写日志时校验消息来源，要求是"生产者自有"的 kind；
`'plugin'` 是 V3 时代的旧写法，v4 明确拒收（`dsh-session-format-v3-to-v4/lib/index.js:126`，
原生落盘校验在同一处逻辑里）。本插件早期注入用的是
`source: { kind: 'plugin', plugin: name, form: 'notice' }`，就是踩了这个。

**现在的写法**：`source: { kind: 'user' }`（注入的本来是一条用户消息）。
`_devcoding/test-dsh-bridge.mjs` 里有一条回归断言，会直接调 DSH 官方的
`assertV4RowAdmission` 去验这条注入消息，改坏了会立刻红。

**出了事怎么查会话有没有被写坏**（zstd 是**分帧**的，普通解压只能拿到第一帧）：

```powershell
node "E:\QQ Agent Dev\_devcoding\read-session-log.mjs" <会话ID> plugin
```

末行会告诉你"含已废弃 `source.kind='plugin'` 的事件：N 条"。

**能不能救**：如果那条坏消息**从没落盘**（校验失败 → 没写进去），会话日志其实是干净的，
**重启 DSH 即可恢复，历史一条不丢**（本次 session-979c444f 就是这种情况：2069 条事件完好，
坏消息只活在当时的进程内存里）。如果已经落盘，就得先备份日志、把那条事件的 source 改写成
合法 kind 再让 DSH 读。

---

## 十、另外两个"一声不响就废掉"的坑（都是实测）

1. **触发关键词前面多了个 `*`**
   设置里被写成 `*开发` 时，匹配用的是 `text.startsWith(keyword)`，于是消息必须字面以
   `*开发` 开头 —— 群里正常发「开发 xxx」永远不触发，而且**没有任何报错**。
   现在 `keywordList()` 会把开头的 `*`／`＊` 当装饰吃掉，笔误最多只是"少个星号"。
   查现场：`curl.exe -s http://127.0.0.1:8765/dev/status` 看 `keywords`。
   注意**改 `config.json` 不等于生效**：运行中的 QQ Agent 用的是内存里的配置，
   要等它重新加载（改设置页 / 重启 QQ Agent）才读盘。

2. **同一张长图被发两遍**
   同一个结果有两条路会触发回执：DSH 侧 `POST /dev/notify`，以及本插件自己的轮询补捞。
   两条路几乎同时跑时，落盘的 `ackAt` 闸来不及写，于是渲染两次、发两次
   （日志里连着两条「正在补发」+ 两次「长截图已生成」）。
   现在 `deliverResult()` 前面加了一道内存在途闸 `delivering`（同一 taskId 串行化），
   `ackAt` 只负责跨重启去重。彩排里有一条并发断言盯着它（两遍 `pollOnce()` 同时跑，
   只允许发 1 张图 + 1 条文字）。

3. **长图底部被裁（"图片显示不完整"）**
   `--screenshot` 只截**视口那么高**，Chrome 不会自动截满整页；老代码按字符数猜视口高度
   （`760 + 字符数×0.55`），报告里标题/表格多、字少时严重低估 —— 实测 800 字的回传被猜成
   1198px，真实内容 1453px，底部 236px（表格末行到"结论"）被切掉。
   现在报告 HTML 会把自己真实的 `scrollHeight` 写进 `<html data-content-height>`，
   渲染前用 `--dump-dom` 读一次真实高度，加 60px 留白后再截图；量不到才退回估算
   （估算公式也改成偏保守，宁可留白不裁）。日志里有一行
   `长图视口高度：Npx（实测内容 Mpx）` 可以核对。
   复核历史图：`node _devcoding/reshoot-report.mjs <taskId>`（重出图，不发送）。
   彩排里有一条断言盯着这件事（造"字少表格多"的报告，必须截出 ≥1600px）。

   **补充（第二次踩到，同一个坑的另一半）**：量高度只能用 `document.body`。
   `documentElement.scrollHeight` **至少等于视口高度** —— 内容比视口矮时它会把高度撑到视口那么大，
   截出来的图底部就是一大片空白（实测：1574px 的卡片被量成 2365px）。配套做法：量高那趟的
   视口故意调矮（`--window-size=${width},800`），并且只取 `body.scrollHeight` 与
   `body.getBoundingClientRect().height` 的较大者。三个出图的地方（dev-coding / status-card /
   style-learning）现已统一成这个写法。

4. **别用 PowerShell 的 `Get-Content`/`Set-Content` 改这些文件**
   Windows PowerShell 5.1 的这两个 cmdlet 默认按 **ANSI(936)** 读写，于是把 UTF-8 文件
   读成乱码、再以乱码写回 —— 一次 `-replace` 就能把整个文件的中文和换行搅坏，而且
   **有损不可逆**（实测把 `test-dsh-bridge.mjs` 整成了乱码）。改文件用编辑工具，
   或者用 node（读写都显式指定 utf8）。真搅坏了也不是没救：
   `node _devcoding/replay-file-from-log.mjs <文件> <会话日志…>`
   —— 工具的每一次 write/edit 都完整记在会话日志里，按顺序回放即可精确还原。

5. **改了桥接代码，记得同时改 `REVISION`**
   重启助手（`_devcoding/restart-dsh.ps1`）用两个信号判断"要不要重启"：`/dev-task/status`
   里的 `revision`，以及**插件源码文件的修改时间是否晚于 DSH 进程启动时间**。
   踩过的坑：加了新功能却忘了改 `REVISION`，助手看 status 说"已经是新代码"直接退出，
   新代码一直没生效（症状：明明改了代码，长图上却没有新字段）。
   现在两道闸一起看，源码时间那条能兜住这种疏忽。

6. **重启助手必须由计划任务托管，不能是 DSH 的子进程**
   DSH 把工具子进程放在同一个 **Job 对象**里。助手刚 `Stop-Process` 掉 DSH，自己也跟着被
   回收 —— 结果是"只杀掉一部分进程、新实例根本没起来、桥接继续跑旧代码"，而日志正好断在
   "强制结束"那一行（症状：改了代码、卡片上却没有新字段，查半天以为代码没生效）。
   现在助手通过 `schtasks /run` 拉起（不属于 DSH 进程树），并且：
   - 用 `taskkill /F /T` 树杀，杀完**等进程真的消失**（最多 20 秒）再启动新实例；
   - 没杀干净就报失败、**不启动**（否则新实例会被单实例锁挡掉，等于白重启一次）；
   - 期望的修订号从插件源码里现读，任务跑完自删。

7. **一行求值里塞多个候选访问，会被其中一个异常炸掉**
   取会话时写成 `const candidates = [agent.session, agent.state?.session, agent.ctx?.session]`
   —— 只要任意一项访问抛异常，整个数组构造失败，被外层 `catch` 吞掉后表现成
   "会话没取到"，长图上 token 永远是 `—`，而外面**完全看不出是哪一项坏的**。
   现在每个候选各自 `try/catch`，并把每一项的探测结果写进
   `GET /dev-task/metrics?taskId=…`（`sessionProbe` 字段），一条命令就能定位。

8. **"token / 开发时长"数据的来路**
   DSH 把每一步的用量记在会话事件的 `assistant/message.data.usage`
   （`{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`）。
   桥接按**任务的注入时刻**筛一遍求和 = 本次开发的 token 消耗；时长 = 注入 → 完成。
   注意总量被 `cacheReadTokens` 主导（上下文每步都要重读缓存），所以长图上
   总量看着很大 —— 元信息表里给了「入 / 出 / 缓存读 / 步数」的明细，别被总量吓到。

---

## 十一、重启 QQ Agent（机器人本体）的正确姿势

从 Agent 的工具调用里重启机器人，有三个坑连在一起，任何一个都会让"重启"变成"关掉起不来"：

1. **必须清掉 `ELECTRON_RUN_AS_NODE`**
   工具进程的环境里有 `ELECTRON_RUN_AS_NODE=1`（DSH 自己也是 Electron）。带着它启动任何
   Electron 程序，对方会以"纯 Node"模式跑：主进程逻辑一行不执行、**立刻退出且没有任何输出**。
   ```powershell
   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
   ```
2. **清掉残留的 `data\qq-agent.lock`**
   强杀之后锁文件里还留着旧 PID，新实例一看"已经有一个在跑"就直接退出（`boot-diag.log` 里
   会有 `单实例锁获取失败，准备退出`）。
3. **协议端（SnowLuma）是它的子进程，会跟着一起没**
   `resources\app\snowluma\` 里有自己的 `node.exe` 和 `index.mjs`（端口 3000/3001）。
   机器人重启后协议端不会自动回来，必须手动拉起，否则日志里一直是
   `连接未连上（连接已断开）`：
   ```powershell
   Start-Process -FilePath 'E:\QQ Agent\resources\app\snowluma\node.exe' `
     -ArgumentList '.\index.mjs' -WorkingDirectory 'E:\QQ Agent\resources\app\snowluma' -WindowStyle Hidden
   ```
   成功的标志：机器人日志出现 `[onebot] 连接成功`，各插件监听陆续显示"已连接"。

**另外——只在万不得已时才重启机器人**：热重载失败时应用会保留旧实例继续跑
（stale-but-working），这些旧实例跑的是**旧代码**，新加的去重/单实例保护对它们无效，
表现就是"改了半天还是老毛病"。判断有没有旧实例：看插件自己的日志路径有没有两处在写、
或者 `liveSockets` 这类计数是不是明显大于 1。

---

## 十二、QQ 侧插件清单（自己加的）

| 插件 | 干什么 | 自检口 |
| --- | --- | --- |
| `dev-coding` | 「开发 xxx」→ 转 DSH 干活 → 长图回传 | 通知口 8765 |
| `status-card` | `/status` → 运行状态 + 全量扩展清单长图 | 8768：`/status-card/status`、`/match?text=…&user=…&group=…`、`/preview` |
| `meme-reply` | 认梗自动接一句（确定性、不花 token） | 8770：`/meme/status`、`/meme/rules`、`/meme/test?text=…`、`/meme/fire?chat=private:<qq>&text=…` |
| `skills/style-learning` | 学某人说话风格 + 出人设 | 8769：`/style/status`、`/style/mine`、`/style/preview?stage=1\|2`、`/style/run`、`/style/persona` |

**接梗插件的规则写法**（设置 → 接梗 → 梗库，一行一条）：

```
触发词 => 回复1 | 回复2 | 回复3
根本没有这样的 => 你只是怕了
re:^急(了|啥|什么)$ => 我没急 | 你才急
```

- 触发词默认**包含即命中且忽略大小写**（`AI/ai`、`V我50/v我50` 都能中）；`re:` 开头是正则
- 回复用 `|` 分候选：随机挑，且**不会和上一条重复**；用 `+` 连接 = 拆成多条消息发
- 三道防刷屏：单条规则冷却（默认 90s）+ 每会话每小时上限（默认 8 次）+ 会话最小间隔（默认 0.8s）
- 接梗时那一轮的人设回复会被压掉（三道闸），不会出现"接一句再补一段"
- 新增规则两种方式：设置里改梗库，或直接跟机器人说「记住：有人说 X 你就回 Y」（走 `meme_add` 工具，写 `data/meme-reply/rules.json`，**不用重启**）



