/**
 * 一键把本仓库发布到 GitHub：建仓 → 推 main → 打 v1.0.0 tag → 建 Release。
 *
 * 凭据来源：Windows 凭据管理器里已有的 `git:https://github.com` 条目
 * （用 `git credential fill` 取，**绝不打印 token**，只打印用户名与掩码）。
 *
 * 用法：
 *   node tools/github-release.mjs            # 真发布
 *   node tools/github-release.mjs --dry-run  # 只看计划，不动远端
 *
 * 环境变量：
 *   GH_OWNER   指定 owner（默认取凭据里的用户名）
 *   GH_REPO    指定仓库名（默认 dsh-qqarc-bridge；GitHub 只允许 ASCII 名）
 *   GH_PRIVATE  =1 建私有仓（默认公开）
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry-run')
const TAG = 'v1.0.0'
const REPO = process.env.GH_REPO || 'dsh-qqarc-bridge'
const PRIVATE = process.env.GH_PRIVATE === '1'

const DESCRIPTION = 'DSH ⇄ QQ Agent 桥接插件：群里一句「开发 xxx」→ 注入 DSH 会话真的动手干 → 结果渲染成长图自动发回原群。'
  + '含会话区索引与按名/按 ID 选择、多 QQ 账号结果路由、输入框上方的「回传目标」栏、离线测试与冒烟。'

const RELEASE_BODY = `## DSH ⇄ QQ Agent 开发指令桥接 v1.0.0

群里发一句 \`开发 加个签到功能\`，DSH 会话真的动手做，做完把结果渲染成长图发回原群。

### 这一版有什么

- **会话区索引与选择**：\`GET /dev-task/sessions\` 列出全部会话（id / 名字 / 工作目录 / 最近活动 / 是否活着）。
  枚举走 Host 服务 \`sessionQuery\`（权威、含历史），磁盘投影缓存兜底，返回体标注数据来源。
- **按名 / 按短前缀选目标**：\`POST /dev-task\`、\`/dev-task/scan\` 接受 \`sessionName\`；
  重名返回 \`409 AMBIGUOUS_TITLE\` + 候选（会话名可空、可重名，实测两个会话同名），**绝不瞎挑**。
- **输入框上方的「回传目标」栏**（客户端半边）：显示/复制本会话 id、显示当前目标与是否活着、
  一键把本会话设为目标、打开会话区面板。
- **多 QQ（多账号）适配**：结果按任务来源账号回传（\`DEV_TASK_QQ_TARGETS=uin:port,...\`），
  扫描覆盖每个账号的任务文件，自动发现 \`8765/8865/8965/9065\` 实例，\`GET /dev-task/qq\` 一条命令诊断。
- **长图回传链路**：QQ 侧无头浏览器渲染竖长图（先量 \`body.scrollHeight\` 再加留白，避免裁底），
  失败三级回退到文字。仓库内附实测尺寸取证。
- **离线可验证**：\`npm test\`（16 条断言）+ \`npm run smoke\`（伪造 Cordis ctx 把 7 条路由真跑一遍，
  不需要重启 DSH）+ \`npm run sessions\`（命令行看会话区）。

### 安装（DSH Host 插件）

1. \`pnpm add <本仓库>\`（装进 \`<DSH_HOME>/profiles/<profile>\`）；
2. 把 \`dsh-dev-task-bridge\` 追加到 profile 的 \`dsh.profile.bundles\`；
3. **重启 DSH**（ESM 模块代次只能靠重启更新）；
4. 验证：\`curl.exe -s http://127.0.0.1:19387/dev-task/status\` 返回 JSON。

配套的 QQ 侧插件是 QQ Agent 的 \`dev-coding\`：见 \`docs/qq-side.md\`（端口、任务文件、HTTP 契约、诊断口，
以及 QQ 侧多账号的 8 条已知缺口）。

### 已知限制

- 注入仍要求目标会话**在 DSH 里活着**；历史会话可列出、可预先指定，但要等它被打开才能投递
  （接线 \`sessionController.prompt\` 可解除，见 CHANGELOG）。
- 客户端栏位用**零依赖 DOM 注入**（锚点靠 class 子串匹配）：若 DSH 改版导致类名变化，栏位可能不出现，
  **宿主半边不受影响**，功能仍可走 \`/dev-task/panel\`。
- QQ 侧目前只在单账号下成立（端口写死、单 WS、数据目录无账号上下文等，见 \`docs/qq-side.md\` §7）。
`

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
}

/** 取 GitHub 凭据（不打印 secret） */
function readCredential() {
  const input = 'protocol=https\nhost=github.com\n\n'
  const res = spawnSync('git', ['credential', 'fill'], {
    cwd: ROOT, input, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (res.status !== 0 || !res.stdout) return null
  const fields = {}
  for (const line of res.stdout.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1)
  }
  if (!fields.username || !fields.password) return null
  return { username: fields.username, token: fields.password }
}

async function api(url, { method = 'GET', body, token } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-dev-task-bridge-release',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

const out = []
const cred = readCredential()
if (!cred) {
  console.error('❌ 拿不到 GitHub 凭据（git credential fill 失败）。请先执行一次：')
  console.error('   git config --global credential.helper manager   # 然后任意一次 git push 会弹窗登录')
  process.exit(2)
}
out.push(`✅ 凭据：用户 ${cred.username} · token ${cred.token.slice(0, 4)}****（不打印全文）`)

const who = await api('https://api.github.com/user', { token: cred.token })
if (who.status !== 200) {
  console.error(`❌ token 无效或权限不足（HTTP ${who.status}）：${who.text.slice(0, 200)}`)
  process.exit(2)
}
const owner = process.env.GH_OWNER || who.json.login || cred.username
out.push(`✅ 身份：${who.json.login}（owner 用 ${owner}）`)

const full = `${owner}/${REPO}`
const exists = await api(`https://api.github.com/repos/${full}`, { token: cred.token })
out.push(exists.status === 200
  ? `ℹ️ 仓库已存在：${full}`
  : `ℹ️ 仓库不存在，将创建：${full}（${PRIVATE ? '私有' : '公开'}）`)

if (DRY) {
  out.push('—— dry-run：不动远端 ——')
  out.push(`  计划：建仓 → git remote add origin → push main → tag ${TAG} → push tag → 建 Release`)
  console.log(out.join('\n'))
  process.exit(0)
}

if (exists.status !== 200) {
  const created = await api('https://api.github.com/user/repos', {
    method: 'POST', token: cred.token,
    body: {
      name: REPO,
      description: DESCRIPTION,
      private: PRIVATE,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    },
  })
  if (created.status !== 201) {
    console.error(`❌ 建仓失败（HTTP ${created.status}）：${created.text.slice(0, 400)}`)
    process.exit(3)
  }
  out.push(`✅ 已建仓：${created.json.html_url}`)
} else {
  const patched = await api(`https://api.github.com/repos/${full}`, {
    method: 'PATCH', token: cred.token, body: { description: DESCRIPTION },
  })
  out.push(patched.status === 200 ? '✅ 已更新仓库简介' : `⚠️ 更新简介失败（HTTP ${patched.status}）`)
}

// 远端
const remotes = run('git', ['remote']).split(/\r?\n/).filter(Boolean)
if (!remotes.includes('origin')) run('git', ['remote', 'add', 'origin', `https://github.com/${full}.git`])
else run('git', ['remote', 'set-url', 'origin', `https://github.com/${full}.git`])
run('git', ['config', 'credential.helper', 'manager'])
out.push(`✅ remote origin → https://github.com/${full}.git`)

const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const push = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', env })
const p1 = push(['push', '-u', 'origin', 'main'])
out.push(p1.status === 0 ? '✅ 已推送 main' : `❌ 推送 main 失败：${(p1.stderr || '').slice(0, 300)}`)

// tag
const tags = run('git', ['tag']).split(/\r?\n/).filter(Boolean)
if (!tags.includes(TAG)) run('git', ['tag', '-a', TAG, '-m', `dsh-dev-task-bridge ${TAG}`])
const p2 = push(['push', 'origin', TAG])
out.push(p2.status === 0 ? `✅ 已推送 tag ${TAG}` : `❌ 推送 tag 失败：${(p2.stderr || '').slice(0, 300)}`)

// Release
const rel = await api(`https://api.github.com/repos/${full}/releases`, {
  method: 'POST', token: cred.token,
  body: { tag_name: TAG, name: `dsh-dev-task-bridge ${TAG}`, body: RELEASE_BODY, draft: false, prerelease: false },
})
if (rel.status === 201) out.push(`✅ 已发布 Release：${rel.json.html_url}`)
else if (rel.status === 422) out.push('ℹ️ Release 已存在（422），跳过')
else out.push(`❌ Release 失败（HTTP ${rel.status}）：${rel.text.slice(0, 300)}`)

console.log(out.join('\n'))
