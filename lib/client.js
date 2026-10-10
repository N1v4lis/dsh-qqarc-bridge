/**
 * 客户端半边：在**会话头部右侧**放一组「回传目标」控件（与 dsh-memory-evolve 的
 * 「复制会话 id」按钮同一个座位）。
 *
 * ── 形态契约（逆向 dsh-memory-evolve 得到；三次 boot 事故换来的）────────────────
 * 入口是一段**脚本**，必须调用 ModuleLoader，所有代码待在 factory 内：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     …你的代码…
 *     return module.exports; } });
 *
 * 事故证据链：① `export` → Unexpected token 'export'；② 顶层 `const` → Identifier 已声明；
 * ③ 自包 IIFE 但不调 __ModuleLoader__ → import failed。
 *
 * ── 座位与更新方式 ────────────────────────────────────────────────────────
 * 座位 `conversation.session.header.actions`（session 作用域，会话头右侧那一排，
 * dsh-memory-evolve 的「复制会话 id」就注册在这里）。
 * 组件交给 React 渲染，`props.sessionId` 随会话切换变化 → 控件自动跟着更新
 * （不再"自己插 DOM"：那会重复、且切会话不跟手）。
 *
 * 数据来自宿主插件注册的 HTTP 路由（同源 fetch，走 hostFence 回环校验）：
 *   GET /dev-task/status · POST /dev-task/scan · GET /dev-task/panel
 */
window.__ModuleLoader__.load({
  id: 'dsh-dev-task-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    var STYLE_ID = 'dev-task-bridge-header-style'
    var POLL_MS = 2000

    var CSS = ''
      + '.dtb-wrap{display:flex;align-items:center;gap:6px;font:12px/1.4 system-ui,"Segoe UI",sans-serif;color:#9aa4b2;white-space:nowrap}'
      + '.dtb-wrap code{background:rgba(127,127,127,.16);padding:1px 5px;border-radius:4px;font-size:11px;color:#e6e6e6}'
      + '.dtb-wrap button{font:inherit;color:#e6e6e6;background:rgba(127,127,127,.18);border:1px solid rgba(127,127,127,.28);'
      + 'border-radius:6px;padding:2px 7px;cursor:pointer}'
      + '.dtb-wrap button:hover{background:rgba(127,127,127,.3)}'
      + '.dtb-wrap button.primary{background:#2563eb;border-color:#2563eb;color:#fff}'
      + '.dtb-wrap a{color:#6ea8fe;text-decoration:none}'
      + '.dtb-wrap .ok{color:#3fb950}.dtb-wrap .warn{color:#d29922}'

    /** 自报：把"我走到哪一步了"告诉宿主（失败静默，绝不影响渲染） */
    function report(payload) {
      try {
        fetch('/dev-task/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ source: 'client', id: 'dsh-dev-task-bridge' }, payload || {})),
        }).catch(function () {})
      } catch (e) { /* 忽略 */ }
    }

    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID)) return
        var style = document.createElement('style')
        style.id = STYLE_ID
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

    /** 头部空间有限：id 只显示前 13 位，悬停看全文 */
    function shortId(id) {
      var s = String(id || '')
      return s.length <= 14 ? s : s.slice(0, 13) + '…'
    }

    function makeWidget(React, props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : ''
      var useState = React.useState
      var useEffect = React.useEffect
      var h = React.createElement

      var targetS = useState('')
      var liveS = useState(false)
      var totalS = useState(0)
      var copiedS = useState(false)
      var busyS = useState(false)

      var target = targetS[0]
      var live = liveS[0]
      var total = totalS[0]
      var copied = copiedS[0]
      var busy = busyS[0]

      useEffect(function () {
        ensureStyle()
        var alive = true
        var tick = function () {
          getJson('/dev-task/status').then(function (st) {
            if (!alive || !st || typeof st !== 'object') return
            var def = String(st.defaultSession || '')
            targetS[1](def)
            totalS[1](Number(st.sessionsIndexed || 0))
            var agents = Array.isArray(st.agents) ? st.agents.map(String) : []
            liveS[1](agents.indexOf(def) >= 0)
          })
        }
        tick()
        var timer = window.setInterval(tick, POLL_MS)
        return function () { alive = false; window.clearInterval(timer) }
      }, [])

      var kids = []
      kids.push(h('span', { key: 'label' }, '回传目标'))
      kids.push(h('code', { key: 'id', title: sessionId || '(未知本会话)' },
        sessionId ? shortId(sessionId) : '(未知本会话)'))
      if (sessionId) {
        kids.push(h('button', {
          key: 'copy',
          type: 'button',
          title: '复制本会话 id',
          onClick: function () {
            try {
              if (navigator.clipboard) navigator.clipboard.writeText(sessionId)
              copiedS[1](true)
              window.setTimeout(function () { copiedS[1](false) }, 1200)
            } catch (e) { /* 忽略 */ }
          },
        }, copied ? '已复制' : '复制 id'))
      }
      kids.push(h('span', { key: 'arrow' }, '→'))
      kids.push(h('code', { key: 'target', title: target || '(未绑定)' },
        target ? shortId(target) : '(未绑定)'))
      kids.push(h('span', { key: 'live', className: live ? 'ok' : 'warn' }, live ? '活着' : '未打开'))
      kids.push(h('button', {
        key: 'set',
        type: 'button',
        className: 'primary',
        disabled: busy || !sessionId,
        onClick: function () {
          if (!sessionId) return
          busyS[1](true)
          postJson('/dev-task/scan', { sessionId: sessionId }).then(function (r) {
            busyS[1](false)
            if (r && r.ok) { targetS[1](sessionId); liveS[1](true) }
          })
        },
      }, busy ? '设置中…' : '设为目标'))
      kids.push(h('a', { key: 'panel', href: '/dev-task/panel', target: '_blank', rel: 'noreferrer' },
        '会话区(' + total + ')'))

      return h('div', { className: 'dtb-wrap' }, kids)
    }

    /** 座位组件：交给 React 渲染；拿不到 React 就什么也不渲染（绝不自己插 DOM） */
    function makeComponent() {
      var React = null
      try { React = require('react') } catch (e) { React = null }
      if (!React || typeof React.createElement !== 'function') {
        report({ event: 'no-react', detail: 'require("react") 不可用，控件无法渲染' })
        return function () { return null }
      }
      var reported = false
      return function (props) {
        try {
          if (!reported) {
            reported = true
            report({ event: 'render', rendered: true, sessionId: props && props.sessionId ? String(props.sessionId) : '' })
          }
          return makeWidget(React, props || {})
        } catch (error) {
          report({ event: 'render-error', error: String((error && error.message) || error) })
          try { console.warn('[dev-task-bridge] 回传目标控件渲染失败：', error) } catch (e) { /* 忽略 */ }
          return null
        }
      }
    }

    function apply(ctx) {
      var dispose = null
      var registered = false
      var detail = ''
      try {
        // ⚠️ slots 要**先从属性上取**：先例 dsh-memory-evolve 用的就是 ctx.slots.inject(...)，
        //    上一版写 ctx.get('slots') 拿到的是 undefined（自报里就是这么暴露出来的）。
        var slots = (ctx && ctx.slots)
          || (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null)
        if (slots && typeof slots.register === 'function') {
          var entry = { name: 'conversation.session.header.actions', id: 'dev-task-bridge-target', order: 5 }
          var register = function () { return slots.register(entry, makeComponent()) }
          dispose = typeof slots.inject === 'function'
            ? slots.inject('conversation.session.header.actions', register)
            : register()
          registered = true
          detail = 'registered via ' + (typeof slots.inject === 'function' ? 'inject+register' : 'register')
        } else {
          detail = 'ctx.get("slots") 拿不到 slots 服务'
        }
      } catch (error) {
        detail = 'register 抛错：' + String((error && error.message) || error)
        try { console.warn('[dev-task-bridge] 座位注册失败（控件不显示；功能仍可走 /dev-task/panel）：', error) } catch (e) { /* 忽略 */ }
      }
      report({ event: 'apply', registered: registered, detail: detail, hasCtx: !!ctx })
      var cleanup = function () {
        try { if (typeof dispose === 'function') dispose() } catch (e) { /* 忽略 */ }
        try {
          var st = document.getElementById(STYLE_ID)
          if (st && st.parentNode) st.parentNode.removeChild(st)
        } catch (e) { /* 忽略 */ }
      }
      try {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return cleanup }, 'dev-task-bridge: 回传目标控件')
        } else window.addEventListener('beforeunload', cleanup, { once: true })
      } catch (e) { /* 忽略 */ }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
