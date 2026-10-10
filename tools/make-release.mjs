/**
 * 给指定 tag 建 Release（凭据走 Windows 凭据管理器的 git:https://github.com，只打印掩码）。
 *
 * 与 tools/github-release.mjs 的区别：那个是"从零建仓+首发"，这个是"日常发版"，
 * tag 与说明从参数/环境变量来。
 *
 * 用法：
 *   node tools/make-release.mjs v1.0.3 notes.md
 *   GH_TAG=v1.0.3 GH_NOTES=notes.md node tools/make-release.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAG = process.argv[2] || process.env.GH_TAG || ''
const NOTES_FILE = process.argv[3] || process.env.GH_NOTES || ''
if (!TAG) { console.error('用法：node tools/make-release.mjs <tag> <notes文件>'); process.exit(2) }

const out = []
function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts })
}

// 凭据
const cred = spawnSync('git', ['credential', 'fill'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  input: 'protocol=https\nhost=github.com\n\n',
})
const fields = {}
for (const line of (cred.stdout || '').split(/\r?\n/)) {
  const i = line.indexOf('=')
  if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1)
}
if (!fields.password) { console.error('❌ 拿不到 GitHub 凭据'); process.exit(2) }
out.push(`✅ 凭据：${fields.username} · token ${fields.password.slice(0, 4)}****`)

const remote = (git(['remote', 'get-url', 'origin']).stdout || '').trim()
const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(remote)
if (!m) { console.error('❌ 解析不出 owner/repo：' + remote); process.exit(2) }
const [owner, repo] = [m[1], m[2]]
out.push(`✅ 仓库：${owner}/${repo}`)

// tag（本地没有就建）
const tags = (git(['tag']).stdout || '').split(/\r?\n/).filter(Boolean)
if (!tags.includes(TAG)) {
  const r = git(['tag', '-a', TAG, '-m', `dsh-dev-task-bridge ${TAG}`])
  out.push(r.status === 0 ? `✅ 已建 tag ${TAG}` : `❌ 建 tag 失败：${(r.stderr || '').slice(0, 200)}`)
} else out.push(`（tag ${TAG} 已存在）`)

// 推 tag（代理已在本仓库配置）
const push = git(['push', 'origin', TAG])
out.push(push.status === 0 ? `✅ 已推送 tag ${TAG}` : `❌ 推 tag 失败：${(push.stderr || '').slice(0, 200)}`)

const body = NOTES_FILE && fs.existsSync(NOTES_FILE)
  ? fs.readFileSync(NOTES_FILE, 'utf8')
  : `dsh-dev-task-bridge ${TAG}`

const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
  method: 'POST',
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-dev-task-bridge-release',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${fields.password}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ tag_name: TAG, name: `dsh-dev-task-bridge ${TAG}`, body, draft: false, prerelease: false }),
  signal: AbortSignal.timeout(30000),
})
const text = await res.text()
if (res.status === 201) {
  const json = JSON.parse(text)
  out.push(`✅ Release 已发布：${json.html_url}`)
} else if (res.status === 422) out.push('ℹ️ Release 已存在（422）')
else out.push(`❌ Release 失败（HTTP ${res.status}）：${text.slice(0, 300)}`)

console.log(out.join('\n'))
