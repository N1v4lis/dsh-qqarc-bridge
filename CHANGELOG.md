# Changelog

## [1.0.6] — 2026-10-10

### 修复（可见性）

- 控件配色改用 DSH **官方主题令牌**（`--dsw-alias-label-primary/-secondary`、`--dsw-alias-bg-layer-1/-2`、
  `--dsw-alias-border-l2`、`--dsw-alias-brand-primary`、`--dsw-alias-state-success/-warn-primary`），
  每个都带兜底色：令牌缺失也不会掉回低对比度。
  此前写死 `#e6e6e6` 文字 + 半透明灰底，在浅色主题下按钮文字几乎看不见。
- 按钮/代码块加粗（`font-weight:600`）、加边框、加悬停态；主按钮用品牌色。

## [1.0.4] — 2026-10-10

### 修复

- **控件不出现的真正原因：取 slots 的方式错了。** 客户端自报给了决定性证据：
  `{ event: "apply", registered: false, detail: "ctx.get(\"slots\") 拿不到 slots 服务", hasCtx: true }`
  —— 模块加载了、apply 也执行了，只是 `ctx.get('slots')` 返回 undefined。
  先例 dsh-memory-evolve 用的是**属性访问** `ctx.slots.inject(…)`（其 lib/client.js:18220）。
  现改为 `ctx.slots` 优先、`ctx.get('slots')` 兜底。
- 自报通道保留（`/dev-task/client-report`）：以后这类问题一条命令就能定位。

## [1.0.3] — 2026-10-10

### 变更（按用户要求换位置 + 修切会话不跟手）

- **座位换到 `conversation.session.header.actions`**（会话头部右侧那一排，与 dsh-memory-evolve 的
  「复制会话 id」按钮同一个座位）—— 1.0.2 放在输入框上方，位置不对。
- **改为 React 渲染**：控件由座位交给 React，`props.sessionId` 随会话切换变化 → 自动跟着更新；
  之前用"自己插 DOM + 单例节点"，导致 id 停在首次捕获的会话（切换不跟手）。
- **删除 DOM 兜底注入**：它会和座位渲染重复；现在座位失败就只是控件不显示，功能仍可走 `/dev-task/panel`。
- 控件内容：本会话 id（截断显示、悬停看全文、一键复制）+ 当前回传目标与是否活着 + 「设为目标」+ 会话区入口。

## [1.0.2] — 2026-10-10

### 修复

- **客户端半边按正确形态重写并重新启用**。逆向 `dsh-memory-evolve/lib/client.js` 得到契约：
  客户端入口是一段脚本，必须调用 `window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })`，
  所有代码待在 factory 内（这样重复求值才有独立作用域）。
  三次事故的证据链：`export` → 语法错误；顶层 `const` → 重复声明；自己包 IIFE 但不调 `__ModuleLoader__` → `import failed`。
- 栏位注册到座位 `conversation.input.dock`（输入框上方），组件从 props 取 `sessionId`；
  拿不到座位/React 时自动退回 DOM 注入，两条路都失败也只是栏位不出现（不影响 boot）。
- 测试新增"加载契约"：伪造 `window.__ModuleLoader__` 真加载一次，断言 `id` 正确、`factory` 返回 `apply`/`inject`、
  且**连续求值两次不抛错**。

## [1.0.1] — 2026-10-10

### 修复（界面可用性优先）

- **停用客户端半边**（`dsh.client` / `exports["./client"]` 从 package.json 移除）。
  它连续两次让 DSH 的 web boot 失败：
  1. ESM 形态 → `Uncaught SyntaxError: Unexpected token 'export'`（加载器按普通脚本执行它）；
  2. 顶层 `const` → `Identifier 'BAR_ID' has already been declared`（加载器会在同一作用域重新求值）；
  改成 IIFE + CommonJS 后语法错误消失，但加载器**仍然**报 `import failed`（不打印更细的原因）。
  两个已装先例发布的都是**预构建产物**，推测加载器要的就是那种形态 —— 搞清楚之前不再动用户界面。
- 宿主半边（7 条路由 + `dev_task_result` 工具 + 多 QQ 路由 + 会话区索引）不受影响，功能照旧；
  会话区依然可以通过 `GET /dev-task/sessions`、`GET /dev-task/panel` 与 `npm run sessions` 使用。

### 保留

- `lib/client.js`（IIFE 形态）与 `tools/fix-client-iife.mjs`、`test/client-half.test.mjs` 都留在仓库里，
  等改成预构建产物后再启用。

本项目从「本机自用的一次性桥接」整理为可发布的 v1.0.0。
版本号语义：`MAJOR.MINOR.PATCH`；插件内部另有 `REVISION`（形如 `v6-multiqq-sessions`），
用于判断 **DSH 进程里跑的是哪一代代码**（改完插件必须重启 DSH 才会换模块代次）。

## [1.0.0] — 2026-10-10

首个公开发布版本。相对内部迭代版（v5）的变化：

### 新增

- **会话区索引与按名字选择**（`lib/sessions.js`）
  - `GET /dev-task/sessions`：列出全部会话（`id / 名字 / 工作目录 / 最近活动 / 日志大小 / 是否活着`），
    支持 `?days=7&limit=50&q=关键词`。
  - `POST /dev-task/scan` 与 `POST /dev-task` 都接受 `sessionName`：**按名字投递/改指向**，
    重名时返回 `409 AMBIGUOUS_TITLE` 与候选列表（不瞎挑）。
  - 支持 **id 短前缀**（`1406fdfe` → `session-1406fdfe-…`），因为 DSH 界面不显示完整 id。
- **多 QQ（QQ Agent 多账号）适配**
  - `DEV_TASK_QQ_TARGETS=158732453:8765,487271667:8865`；结果**按任务来源账号**回传到对应端口，
    失败时依次尝试其它已配置端口（单端口时行为与从前完全一致）。
  - 自动发现：探 `8765 / 8865 / 8965 / 9065`，从各实例的 `GET /dev/status` 读出
    `tasksFile / targetSessionId / wsConnected`（缓存 60 秒）。
  - `scanOnce` 现在会扫**多份任务文件**（旧位置 + `accounts/<uin>/plugins/dev-coding/tasks.json` + 发现到的）。
- **`GET /dev-task/qq`**：多 QQ 连通性诊断（每个目标端口的探活结果与账号提示）。
- **离线可测**：`npm test`（12 条纯函数断言）+ `npm run smoke`（伪造 ctx 把 6 条路由真跑一遍，
  不需要重启 DSH）+ `npm run sessions`（命令行看会话区）。

### 变更

- `REVISION`：`v5-pinned-session` → `v6-multiqq-sessions`。
- `GET /dev-task/status` 增加 `qqTargets` 与 `sessionsIndexed`。
- 握手文件增加 `targets` 字段（QQ 侧可用于多账号路由）。
- `package.json` 可发布化（去掉 `private`，补 `exports/keywords/engines/scripts/files`）。

### 修复

- 会话排序：不再用 `max(lastPromptAt, mtime)` 混排 —— 那样"从没被提问过但日志刚被 touch"的
  会话会挤到第一位，把真正的最近会话顶下去。
- 结果回写任务文件时**写回来源账号那一份**，不再一律写进默认路径（多账号下会把结果发错号）。

### 已知限制

- 注入（`agent.followup`）要求目标会话**在 DSH 里开着**（有存活 agent）；
  历史会话可以列出、可以预先指定，但要等它被打开才能真正投递。
- 会话标题由 DSH 自动生成，可能为空、可能重名 —— 所以选择目标请优先用 id 或 id 短前缀。
