/**
 * 客户端半边：在聊天输入框上方挂一条「回传目标」栏。
 *
 * ── 形态契约（照 dsh-memory-evolve 逆向出来的；三个坑都踩过）──────────────────
 * 客户端入口既不是 ESM、也不是普通 CJS 文件，而是**一段调用 ModuleLoader 的脚本**：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     …你的代码（全部待在 factory 里，不能有顶层声明）…
 *     return module.exports; } });
 *
 * 踩坑记录（2026-10-10，连续三次让 web boot 起不来）：
 *   ① 写成 `export function apply` → `Unexpected token 'export'`（它按脚本执行）；
 *   ② 写成带顶层 `const` 的普通 CJS → `Identifier 'BAR_ID' has already been declared`
 *      （加载器会在同一作用域重新求值 → 所有代码必须在 factory 内）；
 *   ③ 自己包 IIFE 却没调 `__ModuleLoader__.load` → 加载器收不到模块 → `import failed`。
 *
 * 座位：`conversation.input.dock`（"Full-width entries above the composer card"，session 作用域），
 * 组件 props 里带 `sessionId`（与 dsh-memory-evolve 在 conversation.view 里用 props.sessionId 同理）。
 *
 * 数据全部来自宿主插件注册的 HTTP 路由（同源 fetch，走 hostFence 回环校验）：
 *   GET /dev-task/status · POST /dev-task/scan · GET /dev-task/panel
 */
window.__ModuleLoader__.load({
  id: 'dsh-dev-task-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    var BAR_ID = 'dev-task-bridge-bar'
    var STYLE_ID = 'dev-task-bridge-bar-style'

    /** 拿不到座位时退回 DOM 注入：插在输入框所在块上方 */
    var ANCHOR_SELECTORS = [
      '[class*="_composerCard"]',
      '[class*="_composer"]',
      '[class*="_composerBar"]',
      '[class*="_inputDock"]',
    ]

    var CSS = ''
      + '#' + BAR_ID + '{display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
      + 'font:12px/1.5 system-ui,"Segoe UI",sans-serif;color:#9aa4b2;'
      + 'padding:5px 10px;margin:0 0 6px;border:1px solid rgba(127,127,127,.22);border-radius:8px;'
      + 'background:rgba(127,127,127,.06)}'
      + '#' + BAR_ID + ' code{background:rgba(127,127,127,.16);padding:1px 5px;border-radius:4px;font-size:11px}'
      + '#' + BAR_ID + ' button{font:inherit;color:#fff;background:#2563eb;border:0;border-radius:6px;'
      + 'padding:2px 8px;cursor:pointer}'
      + '#' + BAR_ID + ' button.ghost{background:transparent;color:#6ea8fe;border:1px solid rgba(110,168,254,.5)}'
      + '#' + BAR_ID + ' .ok{color:#3fb950}'
      + '#' + BAR_ID + ' .warn{color:#d29922}'
      + '#' + BAR_ID + ' a{color:#6ea8fe;text-decoration:none}'

    function el(tag, attrs, text) {
      var node = document.createElement(tag)
      var a = attrs || {}
      Object.keys(a).forEach(function (k) {
        if (k === 'class') node.className = a[k]
        else if (k === 'style') node.setAttribute('style', a[k])
        else node.setAttribute(k, a[k])
      })
      if (text) node.textContent = text
      return node
    }

    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID)) return
        var style = el('style', { id: STYLE_ID }, '')
        style.textContent = CSS
        ;(document.head || document.documentElement).appendChild(style)
      } catch (e) { /* 忽略 */ }
    }

    function getJson(url) {
      return fetch(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : null })
        .catch(function () { return null })
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(6000),
      }).then(function (res) { return res.json().catch(function () { return null }) })
        .catch(function () { return null })
    }

    /** 造一条栏位节点（节点只建一次，之后只更新文字，避免 React 重渲染把 DOM 冲掉） */
    function createBar() {
      ensureStyle()
      var bar = el('div', { id: BAR_ID }, '')
      var state = { sessionId: '', target: '', live: false, total: 0 }

      function render() {
        bar.textContent = ''
        bar.appendChild(el('span', {}, 'DSH 回传目标'))
        bar.appendChild(el('code', {}, state.sessionId || '(未知本会话)'))
        if (state.sessionId) {
          var copy = el('button', { class: 'ghost', type: 'button' }, '复制')
          copy.addEventListener('click', function () {
            try {
              if (navigator.clipboard) navigator.clipboard.writeText(state.sessionId)
              copy.textContent = '已复制'
              setTimeout(function () { copy.textContent = '复制' }, 1200)
            } catch (e) { /* 忽略 */ }
          })
          bar.appendChild(copy)
        }
        bar.appendChild(el('span', {}, '→ 当前目标：'))
        bar.appendChild(el('code', { class: state.target ? '' : 'warn' }, state.target || '(未绑定)'))
        bar.appendChild(el('span', { class: state.live ? 'ok' : 'warn' }, state.live ? '活着' : '未打开'))

        var setSelf = el('button', { type: 'button' }, '把本会话设为目标')
        setSelf.addEventListener('click', function () {
          if (!state.sessionId) { setSelf.textContent = '拿不到本会话 id'; return }
          setSelf.disabled = true
          postJson('/dev-task/scan', { sessionId: state.sessionId }).then(function (r) {
            setSelf.disabled = false
            setSelf.textContent = r && r.ok ? '已设为目标 ✓' : '设置失败'
            refresh()
          })
        })
        bar.appendChild(setSelf)
        bar.appendChild(el('a', { href: '/dev-task/panel', target: '_blank', rel: 'noreferrer' },
          '会话区面板（' + state.total + '）'))
      }

      function refresh() {
        return getJson('/dev-task/status').then(function (st) {
          if (st && typeof st === 'object') {
            state.target = String(st.defaultSession || '')
            state.total = Number(st.sessionsIndexed || 0)
            var agents = Array.isArray(st.agents) ? st.agents.map(String) : []
            state.live = agents.indexOf(state.target) >= 0
          }
          render()
        })
      }

      render()
      refresh()
      return {
        node: bar,
        setSessionId: function (id) { if (id && !state.sessionId) { state.sessionId = String(id); render() } },
        refresh: refresh,
      }
    }

    /** 兜底挂载：不在 React 树里也能出现（React 渲染成功时节点会被搬进座位） */
    function mountFallback(node) {
      try {
        if (node.parentNode) return
        var doc = document
        ensureStyle()
        var anchor = null
        for (var i = 0; i < ANCHOR_SELECTORS.length; i += 1) {
          try {
            var found = doc.querySelector(ANCHOR_SELECTORS[i])
            if (found && found.parentNode) { anchor = found; break }
          } catch (e) { /* 忽略 */ }
        }
        if (anchor) anchor.parentNode.insertBefore(node, anchor)
        else (doc.body || doc.documentElement).appendChild(node)
      } catch (e) { /* 忽略 */ }
    }

    /** 座位组件：优先交给 React 渲染容器；拿不到 React 就返回 null + DOM 兜底 */
    function makeComponent() {
      var React = null
      try { React = require('react') } catch (e) { React = null }
      var bar = createBar()
      setTimeout(function () { mountFallback(bar.node) }, 1200)

      return function (props) {
        try {
          if (props && props.sessionId) bar.setSessionId(props.sessionId)
          if (React && typeof React.createElement === 'function') {
            return React.createElement('div', {
              ref: function (node) { if (node && !node.contains(bar.node)) node.appendChild(bar.node) },
            })
          }
        } catch (e) { /* 落到兜底 */ }
        setTimeout(function () { mountFallback(bar.node) }, 0)
        return null
      }
    }

    function apply(ctx) {
      var dispose = null
      var bar = null
      try {
        var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : (ctx && ctx.slots)
        if (slots && typeof slots.register === 'function') {
          var entry = { name: 'conversation.input.dock', id: 'dev-task-bridge-target', order: 40 }
          var register = function () { return slots.register(entry, makeComponent()) }
          dispose = typeof slots.inject === 'function'
            ? slots.inject('conversation.input.dock', register)
            : register()
        }
      } catch (error) {
        try { console.warn('[dev-task-bridge] 座位注册失败，改用 DOM 注入：', error) } catch (e) { /* 忽略 */ }
      }
      // 双保险：无论座位成功与否都注入一份（成功后 React 会把同一个节点搬进座位）
      try {
        var fallback = makeComponent()
        bar = fallback({}) // 只是为了让 makeComponent 内部那条兜底定时器排上队
      } catch (e) { /* 忽略 */ }

      var cleanup = function () {
        try { if (typeof dispose === 'function') dispose() } catch (e) { /* 忽略 */ }
        try {
          var node = document.getElementById(BAR_ID)
          if (node && node.parentNode) node.parentNode.removeChild(node)
          var st = document.getElementById(STYLE_ID)
          if (st && st.parentNode) st.parentNode.removeChild(st)
        } catch (e) { /* 忽略 */ }
      }
      try {
        if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { return cleanup }, 'dev-task-bridge: 回传目标栏')
        else window.addEventListener('beforeunload', cleanup, { once: true })
      } catch (e) { /* 忽略 */ }
    }

    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
