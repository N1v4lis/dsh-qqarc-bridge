# Changelog

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
