/**
 * 纯函数测试：会话区索引、会话选择（含重名歧义）、多 QQ 目标解析、任务文件发现。
 *
 * 跑法：`npm test`（= node --test test/）—— **不需要 DSH、不需要 QQ Agent**，
 * 因为这些函数只依赖文件系统布局，而布局用临时目录伪造。
 *
 * 这些断言盯的是**实测踩过 / 极易写错**的点：
 *   · 会话名可空、可重名 → 按名选择必须报歧义，不能瞎挑一个
 *   · 工作目录以投影缓存为准（项目目录编码是有损的）
 *   · 多 QQ 端口必须能按账号解析（回传到来源账号）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  decodeProjectDir,
  listStoredSessions,
  filterRecentSessions,
  readProjection,
  resolveSession,
  parseQqTargets,
  listTaskFiles,
  collectPendingTasks,
  notifyTargetFor,
  BASE_QQ_PORT,
  QQ_PORT_STEP,
} from '../lib/sessions.js'

/** 造一个假的 ~/.dsh：两个项目、三个会话（其中两个同名）。 */
function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-test-'))
  const now = Date.now()
  const sessions = [
    { id: 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', project: '--E-QQ~0020Agent~0020Dev--', cwd: 'E:\\QQ Agent Dev', title: 'Coding回传', lastPromptAt: now - 1000, bytes: 2048 },
    { id: 'session-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', project: '--E-Deepseek~0020Harness--', cwd: 'E:\\Deepseek Harness', title: '连通性测试', lastPromptAt: now - 60_000, bytes: 512 },
    { id: 'session-cccccccc-3333-4333-8333-cccccccccccc', project: '--E-Deepseek~0020Harness--', cwd: 'E:\\Deepseek Harness', title: '连通性测试', lastPromptAt: now - 120_000, bytes: 256 },
    { id: 'session-dddddddd-4444-4444-8444-dddddddddddd', project: '--E-QQAF--', cwd: 'E:\\QQAF', title: '', lastPromptAt: null, bytes: 128 },
  ]
  for (const s of sessions) {
    const dir = path.join(home, 'sessions', s.project, s.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(s.bytes))
  }
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(cacheDir, { recursive: true })
  for (const s of sessions) {
    fs.writeFileSync(path.join(cacheDir, `${s.id}.json`), JSON.stringify({
      version: 4,
      record: {
        identity: { formatVersion: 4, createdAt: s.lastPromptAt || now, cwd: s.cwd },
        rows: {
          title: { ver: 1, seq: 10, val: s.title === '' ? null : s.title },
          sessionListMetadata: { ver: 1, seq: 10, val: { blank: false, lastPromptAt: s.lastPromptAt } },
        },
      },
    }), 'utf8')
  }
  return { home, sessions }
}

/** 造一个假的 QQ Agent 家目录：旧位置 + 两个账号，各带一份 tasks.json。 */
function makeQqFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-test-'))
  fs.mkdirSync(path.join(home, 'data', 'dev-coding'), { recursive: true })
  fs.writeFileSync(path.join(home, 'data', 'dev-coding', 'tasks.json'), JSON.stringify({
    tasks: { 'legacy-1': { status: 'done', markdown: '旧位置任务' } },
  }), 'utf8')
  fs.writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({
    active: '487271667',
    accounts: [{ uin: '158732453' }, { uin: '487271667' }],
  }), 'utf8')
  const botDir = path.join(home, 'accounts', '158732453', 'plugins', 'dev-coding')
  const mainDir = path.join(home, 'accounts', '487271667', 'plugins', 'dev-coding')
  fs.mkdirSync(botDir, { recursive: true })
  fs.mkdirSync(mainDir, { recursive: true })
  fs.writeFileSync(path.join(botDir, 'tasks.json'), JSON.stringify({
    tasks: {
      't-bot-1': { status: 'pending', instruction: 'bot 号的任务' },
      't-bot-2': { status: 'done', markdown: '已完成' },
    },
  }), 'utf8')
  fs.writeFileSync(path.join(mainDir, 'tasks.json'), JSON.stringify({
    tasks: { 't-main-1': { status: 'pending', instruction: '主号的任务', notifyPort: 8865 } },
  }), 'utf8')
  return home
}

test('decodeProjectDir：能还原空格与盘符（有损，仅作近似）', () => {
  assert.equal(decodeProjectDir('--E-QQ~0020Agent~0020Dev--'), 'E:\\QQ Agent Dev')
  assert.equal(decodeProjectDir('--E-Deepseek~0020Harness--'), 'E:\\Deepseek Harness')
  // 非标准输入原样返回
  assert.equal(decodeProjectDir('plain-name'), 'plain-name')
})

test('listStoredSessions：枚举全部会话，标题/工作目录来自投影缓存，按最近活动倒序', () => {
  const { home } = makeFixture()
  const list = listStoredSessions({ home })
  assert.equal(list.length, 4, '应看到 4 个会话（含历史）')
  assert.equal(list[0].id, 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '最近提问的排第一')
  const coding = list.find((s) => s.title === 'Coding回传')
  assert.ok(coding, '能读到会话名')
  assert.equal(coding.cwd, 'E:\\QQ Agent Dev', '工作目录取自投影缓存（权威）')
  const untitled = list.find((s) => s.id.startsWith('session-dddddddd'))
  assert.equal(untitled.title, '', '未命名会话的标题是空串，不是 null/undefined')
  const last = list[list.length - 1]
  assert.equal(last.id, untitled.id, '没有 lastPromptAt 的会话排最后')
})

test('filterRecentSessions：按天数过滤', () => {
  const { home } = makeFixture()
  const list = listStoredSessions({ home })
  const recent = filterRecentSessions(list, 1)
  assert.ok(recent.length >= 3, '一天内的会话都应保留')
  assert.equal(filterRecentSessions(list, 0).length, list.length, '0 = 不过滤')
})

test('resolveSession：id / id 前缀 / 名字 都能解析', () => {
  const { home } = makeFixture()
  const sessions = listStoredSessions({ home })

  const byId = resolveSession('session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', { sessions })
  assert.equal(byId.ok, true)
  assert.equal(byId.strategy, 'id')

  const byShortPrefix = resolveSession('aaaaaaaa', { sessions })
  assert.equal(byShortPrefix.ok, true)
  assert.equal(byShortPrefix.id, 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '短前缀应能定位（用户看不到完整 id 时最实用）')

  const byTitle = resolveSession('Coding回传', { sessions })
  assert.equal(byTitle.ok, true)
  assert.equal(byTitle.strategy, 'title')
  assert.equal(byTitle.id, 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
})

test('resolveSession：重名必须报歧义（实测两个会话都叫「连通性测试」）', () => {
  const { home } = makeFixture()
  const sessions = listStoredSessions({ home })
  const r = resolveSession('连通性测试', { sessions })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'AMBIGUOUS_TITLE')
  assert.equal(r.candidates.length, 2, '两个候选都要给出来，让用户改用 id')
  assert.match(r.error, /会话名可以重复/)
})

test('resolveSession：找不到 / 空值 有明确错误码', () => {
  const { home } = makeFixture()
  const sessions = listStoredSessions({ home })
  assert.equal(resolveSession('不存在的会话', { sessions }).code, 'NOT_FOUND')
  assert.equal(resolveSession('', { sessions }).code, 'EMPTY')
  assert.equal(resolveSession(undefined, { sessions }).code, 'EMPTY')
})

test('parseQqTargets：三种写法 + 账号→端口推算', () => {
  assert.deepEqual(parseQqTargets('8765'), [{ uin: '', port: 8765 }])
  assert.deepEqual(parseQqTargets('8765,8865'), [{ uin: '', port: 8765 }, { uin: '', port: 8865 }])
  assert.deepEqual(
    parseQqTargets('158732453:8765,487271667:8865'),
    [{ uin: '158732453', port: 8765 }, { uin: '487271667', port: 8865 }],
  )
  assert.deepEqual(
    parseQqTargets('158732453,487271667'),
    [{ uin: '158732453', port: BASE_QQ_PORT }, { uin: '487271667', port: BASE_QQ_PORT + QQ_PORT_STEP }],
  )
  assert.deepEqual(parseQqTargets('   '), [], '空值 = 没配置')
  assert.equal(parseQqTargets('8765,8765').length, 1, '同端口去重')
})

test('listTaskFiles：旧位置 + 每个账号一份（多 QQ 的关键）', () => {
  const home = makeQqFixture()
  const files = listTaskFiles({ home })
  assert.equal(files.length, 3, '旧位置 + 2 个账号')
  assert.ok(files.every((f) => f.exists), '三份都存在')
  const bot = files.find((f) => f.uin === '158732453')
  const main = files.find((f) => f.uin === '487271667')
  assert.equal(bot.port, 8765)
  assert.equal(main.port, 8865, '第二个账号端口 +100（QQ Agent 的 portOffset 约定）')
  assert.match(bot.path, /accounts\\158732453\\plugins\\dev-coding\\tasks\.json$/)
})

test('collectPendingTasks：跨账号汇总待投递任务，并带上来源账号', () => {
  const home = makeQqFixture()
  const pending = collectPendingTasks(listTaskFiles({ home }))
  assert.equal(pending.length, 2, '只收 pending/queued')
  const botTask = pending.find((t) => t.taskId === 't-bot-1')
  const mainTask = pending.find((t) => t.taskId === 't-main-1')
  assert.equal(botTask.account, '158732453')
  assert.equal(mainTask.account, '487271667', '每个任务都知道自己来自哪个账号')
})

test('notifyTargetFor：结果按来源账号回传（任务里写死 > 账号映射 > 唯一目标 > 兜底）', () => {
  const targets = parseQqTargets('158732453:8765,487271667:8865')
  assert.equal(notifyTargetFor({ account: '487271667' }, targets), 8865, '按账号回传')
  assert.equal(notifyTargetFor({ account: '158732453' }, targets), 8765)
  assert.equal(notifyTargetFor({ account: '487271667', payload: { notifyPort: 9999 } }, targets), 9999, '任务里写死的最优先')
  assert.equal(notifyTargetFor({ account: 'unknown' }, [{ uin: '', port: 8765 }]), 8765, '唯一目标直接用')
  assert.equal(notifyTargetFor({}, []), BASE_QQ_PORT, '都没配就兜底 8765')
})

test('readProjection：缺文件/坏文件都不抛异常', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-empty-'))
  assert.equal(readProjection(home, 'session-nope'), null)
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session-broken.json'), '{ not json', 'utf8')
  assert.equal(readProjection(home, 'session-broken'), null)
})

test('契约：lib/index.js 可被裸 import（无顶层 await）且导出清单齐全', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dev-task-bridge')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('agents'), 'inject 必须声明 agents 服务')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.deliverToSession, 'function')
  assert.equal(typeof mod.hostFence, 'function')
})
