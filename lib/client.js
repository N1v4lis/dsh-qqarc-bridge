/**
 * 客户端半边：在**聊天输入框上方**挂一条「回传目标」栏。
 *
 * ── 为什么是 DOM 注入，而不是 slots.register ────────────────────────────────
 * DSH 确实有现成座位 `conversation.input.dock`（"Full-width entries above the
 * composer card"，session 作用域，组件 props 里能拿到 sessionId），已装的两个先例
 * （dsh-memory-evolve / dsh-theme-tarkov）也都在用它。但它们的 `lib/client.js`
 * 都是**打包产物**（CJS 包装 + require('react')），说明客户端半边要经过构建；
 * 而本插件要保持"改完就能用、零构建"。
 *
 * 所以这里用**零依赖 DOM 注入**：不 import 任何东西（连 React 都不用），
 * 只做三件事 —— 找锚点、插一个 div、定期对齐。已装的 dsh-theme-tarkov 用同样的
 * 手法注入右下角 BGM 挂件并稳定工作，是本仓库选这条路的直接依据。
 *
 * 代价与防护：
 *   · 锚点是 class 子串匹配（DSH 的样式类名带 hash 前缀，只能模糊匹配），
 *     所以按"候选选择器列表 + 逐个尝试 + 找不到就下一轮"来做，绝不写死一个选择器；
 *   · 任何异常都被吞掉并只在控制台留一行 —— **客户端半边绝不能影响宿主半边**；
 *   · 卸载/热重载时自清（effect 返回清理函数 + 去掉自己插入的节点）。
 *
 * 它显示/操作的东西全部来自宿主插件注册的 HTTP 路由（同源 fetch，走 hostFence 回环校验，
 * 不需要登录 cookie）：
 *   GET  /dev-task/status   → 当前回传目标
 *   POST /dev-task/scan     → 把本会话设为回传目标
 *   GET  /dev-task/panel    → 完整会话区面板（新窗口打开）
 */

const BAR_ID = 'dev-task-bridge-bar'
const STYLE_ID = 'dev-task-bridge-bar-style'
const POLL_MS = 1500

/** 候选锚点：插在它**上面**（都是"输入框所在块"的特征，按可靠性排序）。 */
const ANCHOR_SELECTORS = [
  '[class*="_composerCard"]',
  '[class*="_composer"]',
  '[class*="_composerBar"]',
  '[class*="_inputDock"]',
]

const CSS = `
#${BAR_ID}{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  font:12px/1.5 system-ui,"Segoe UI",sans-serif;color:#9aa4b2;
  padding:5px 10px;margin:0 0 6px;border:1px solid rgba(127,127,127,.22);border-radius:8px;
  background:rgba(127,127,127,.06)}
#${BAR_ID} b{color:#e6e6e6;font-weight:600}
#${BAR_ID} code{background:rgba(127,127,127,.16);padding:1px 5px;border-radius:4px;font-size:11px}
#${BAR_ID} button{font:inherit;color:#fff;background:#2563eb;border:0;border-radius:6px;
  padding:2px 8px;cursor:pointer}
#${BAR_ID} button.ghost{background:transparent;color:#6ea8fe;border:1px solid rgba(110,168,254,.5)}
#${BAR_ID} .ok{color:#3fb950}
#${BAR_ID} .warn{color:#d29922}
#${BAR_ID} a{color:#6ea8fe;text-decoration:none}
`

/** 小工具：建元素 */
function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'style') node.setAttribute('style', v)
    else node.setAttribute(k, v)
  }
  if (text) node.textContent = text
  return node
}

/** 同源 GET JSON（失败一律返回 null，绝不抛到外面） */
async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(6000),
    })
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

/** 当前会话 id：优先用运行时给的（props.sessionId），拿不到就找 URL 里的痕迹，最后留空 */
function currentSessionIdFromDom() {
  try {
    const node = document.querySelector('[data-session-id]')
    const attr = node && node.getAttribute('data-session-id')
    if (attr) return String(attr)
  } catch { /* 忽略 */ }
  return ''
}

export const inject = ['slots']

/**
 * 客户端半边的 apply。**故意不用 ctx.slots**（见文件头注释）：
 * 只借 ctx.effect 做生命周期绑定，其余全走 DOM。
 */
export function apply(ctx) {
  /** 状态缓存：当前会话 id 由宿主插件反查（栏位自己不认识会话） */
  let sessionId = currentSessionIdFromDom()
  let target = ''
  let targetLive = false
  let total = 0
  let timer = null
  let observer = null
  let bar = null

  const render = () => {
    if (!bar) return
    bar.textContent = ''
    bar.appendChild(el('span', {}, 'DSH 回传目标'))
    bar.appendChild(el('code', {}, sessionId ? sessionId : '(未知本会话)'))
    if (sessionId) {
      const copy = el('button', { class: 'ghost', type: 'button' }, '复制')
      copy.addEventListener('click', () => {
        try {
          void navigator.clipboard?.writeText(sessionId)
          copy.textContent = '已复制'
          setTimeout(() => { copy.textContent = '复制' }, 1200)
        } catch { /* 忽略 */ }
      })
      bar.appendChild(copy)
    }
    bar.appendChild(el('span', {}, '→ 当前目标：'))
    bar.appendChild(el('code', { class: target ? '' : 'warn' }, target || '(未绑定)'))
    bar.appendChild(el('span', { class: targetLive ? 'ok' : 'warn' }, targetLive ? '活着' : '未打开'))

    const setSelf = el('button', { type: 'button' }, '把本会话设为目标')
    setSelf.addEventListener('click', async () => {
      if (!sessionId) { setSelf.textContent = '拿不到本会话 id'; return }
      setSelf.disabled = true
      const r = await postJson('/dev-task/scan', { sessionId })
      setSelf.disabled = false
      setSelf.textContent = r && r.ok ? '已设为目标 ✓' : '设置失败'
      void refresh()
    })
    bar.appendChild(setSelf)

    const panel = el('a', { href: '/dev-task/panel', target: '_blank', rel: 'noreferrer' }, `会话区面板（${total}）`)
    bar.appendChild(panel)
  }

  const refresh = async () => {
    const st = await getJson('/dev-task/status')
    if (st && typeof st === 'object') {
      target = String(st.defaultSession || '')
      total = Number(st.sessionsIndexed || 0)
      const agents = Array.isArray(st.agents) ? st.agents.map(String) : []
      targetLive = agents.includes(target)
      // 本会话 id 的权威来源：DSH 客户端把"我"暴露在 URL/数据属性上时优先它，
      // 否则栏位只能显示"未知本会话"（不会猜错一个 id 出来）
      if (!sessionId) sessionId = currentSessionIdFromDom()
    }
    render()
  }

  /** 插栏：找到锚点就插在它上面；找不到就等下一轮（首屏 DOM 还没稳） */
  const mount = () => {
    try {
      if (bar && document.body && document.body.contains(bar)) return true
      const host = document.body || document.documentElement
      if (!host) return false
      if (!document.getElementById(STYLE_ID)) {
        host.appendChild(el('style', { id: STYLE_ID }, CSS))
        const styleNode = document.getElementById(STYLE_ID)
        if (styleNode) styleNode.textContent = CSS
      }
      let anchor = null
      for (const sel of ANCHOR_SELECTORS) {
        try {
          const found = document.querySelector(sel)
          if (found && found.parentNode) { anchor = found; break }
        } catch { /* 选择器不被支持就跳过 */ }
      }
      bar = el('div', { id: BAR_ID })
      render()
      if (anchor) anchor.parentNode.insertBefore(bar, anchor)
      else host.appendChild(bar)   // 实在找不到输入框区域：退化成贴底浮条（至少能用）
      return true
    } catch (error) {
      try { console.warn('[dev-task-bridge] 栏位挂载失败：', error) } catch { /* 忽略 */ }
      return false
    }
  }

  const tick = () => {
    try {
      mount()
      void refresh()
    } catch { /* 忽略：客户端半边永远不能抛到外面 */ }
  }

  tick()
  timer = window.setInterval(tick, POLL_MS)
  try {
    if (typeof MutationObserver === 'function' && document.body) {
      observer = new MutationObserver(() => { try { mount() } catch { /* 忽略 */ } })
      observer.observe(document.body, { childList: true, subtree: true })
    }
  } catch { /* 忽略 */ }

  const dispose = () => {
    try { if (timer) window.clearInterval(timer) } catch { /* 忽略 */ }
    try { if (observer) observer.disconnect() } catch { /* 忽略 */ }
    try { if (bar && bar.parentNode) bar.parentNode.removeChild(bar) } catch { /* 忽略 */ }
    try { const st = document.getElementById(STYLE_ID); if (st && st.parentNode) st.parentNode.removeChild(st) } catch { /* 忽略 */ }
    bar = null
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dev-task-bridge: 回传目标栏')
  } else {
    window.addEventListener('beforeunload', dispose, { once: true })
  }
}
