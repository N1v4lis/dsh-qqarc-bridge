# 开发这个插件前必读（六个坑，全是实测踩出来的）

DSH 插件跑在**宿主进程**里，加载失败/热重载的表现往往是"看起来装上了，其实不对"。
下面六条任何一条踩中，症状都不是报错，而是**行为静默地不对**。

---

## 1. 顶层 `await` 是致命的（而且不给你排查机会）

DSH 的加载器加载 entry 时，遇到含顶层 await 的 ESM 图会抛：

```
ERR_REQUIRE_ASYNC_MODULE: require() cannot be used on an ESM graph with top-level await.
```

关键在于**错误发生在模块体执行之前** —— 文件里的任何 `try/catch`、任何"把错误写进文件"的兜底
都来不及跑，界面上只有一句 `failed to import`。

所以本插件的 `@deepseek-ai/dsh-tools` / `dsh-llm` 一律在 `init()` 里**动态 import**，
由 `apply()` 去 await。`test/sessions.test.mjs` 里有一条契约断言：`lib/index.js` 必须能被裸 import。

## 2. 不能裸 import `@deepseek-ai/dsh-*`

插件是用 `link:` 装进 profile 的（桌面版 profile 只能这么装），`node_modules` 里那条是 **junction**，
而 Node 解析说明符走**真实路径** —— 于是它不会去 profile 的 `node_modules` 找，直接 `ERR_MODULE_NOT_FOUND`。

本插件用 `createRequire` 锚在 `<profile>/node_modules` 上显式解析（`resolveDshModule`），
锚点顺序：`DSH_PROFILE_DIR` → `DSH_HOME/profiles/desktop` → `~/.dsh/profiles/desktop` → `cwd`。

## 3. 不要在 profile 的 `cordis.patch.yml` 里重复 insert

本插件的 `package.json` 已声明自己是 bundle（`dsh.bundle.patch`），profile 里再写一行同 id 的 insert，
会产生**两行同 id 的 entry**，那一行永久变成 `unaddressable`（既激活不了、也无法用界面开关管理）。

正确做法：包进 `dsh.profile.bundles`（按 `dependencies` 键序），patch 由 bundle 自带。

## 4. 热重载会留下"活着的旧实例"，必须防它复活

热重载不保证调用 `deactivate()`。旧实例的 WebSocket/HTTP 监听被新实例关掉后，它的 close 回调
会安排重连，重连上来又把新实例踢掉 —— 两个实例每秒互相踢一次（日志满屏"已关闭 1 条遗留连接"）。

三处一起防才行：

- 关旧连接**前**先给它打记号（`__devCodingEvicted`），被替换过的连接不再重连；
- 重连定时器到点时**再确认一次**"现在是否已有活连接"（定时器可能是替换前排下的）；
- 连接/HTTP 监听放进 `globalThis` 的跨实例槽位，**最新实例才说了算**。

## 5. 客户端对象的 `selfId` / `selfNickname` 可能只有 getter

写得像"拿到登录信息后写回客户端"的代码，可能撞上：

```
TypeError: Cannot set property selfId of #<OneBotClient> which has only a getter
```

这类属性由客户端自己维护，**只读**。要展示就读取；要"纠正"它，只能改数据源（令牌/端点），
不能赋值 —— 否则表现为"日志里一直有一条无害告警"，掩盖真正的问题。

## 6. 改行为必须同时改 `REVISION`

重启助手用两个信号判断"要不要重启 DSH"：`/dev-task/status` 里的 `revision`，
以及**插件源码 mtime 是否晚于 DSH 进程启动时间**。

踩过的坑：加了新功能却忘改 `REVISION`，助手看 status 说"已经是新代码"直接退出 ——
新代码一直没生效，而现象是"明明改了代码，长图上却没有新字段"。

---

## 顺手记：改这个仓库的验证口径

```bash
npm test        # 纯函数：会话索引/名字歧义/多 QQ 端口/任务文件/契约（12 条）
npm run smoke   # 伪造 ctx 把 6 条路由真跑一遍（不需要重启 DSH，不会掐掉正在对话的会话）
node --check lib/index.js
```

**先 `--check` 再重启** —— 本项目在 `routes.js` 上翻过两次车（补丁把语法改坏、应用起不来），
所以所有补丁脚本都写成"锚点必须命中 + 语法不过就回滚"。
