/**
 * dsh-auth.mjs — obtain a usable DSH web credential from a local process.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * `dsh-host-webserver` itself carries NO authentication (its README: "No
 * server-wide TLS, authentication, or origin policy"). The 401 comes from route
 * owners. `dsh-client-connection` registers the `/api` route gated by
 * `connection.admit(req)`, and plugins that want the same policy call
 * `ctx.connection.requestRejection(req)` themselves. `dsh-host-frontend-static`
 * gates only the index response via `ctx.connection.authorizeIndex(req,res)`;
 * plain static assets under the dist root are served WITHOUT authentication.
 *
 * The credential is an authority-bound HMAC-signed cookie:
 *   name  = "dsh-auth-" + base64url(sha256(requestAuthority))
 *   value = "v1." + base64url(JSON.stringify({version,authority,issuedAt,expiresAt}))
 *           + "." + base64url(HMAC-SHA256(secret, body))
 *
 * The signing secret is the owner-scoped credential record
 * `client-connection/browser-session`, persisted by the local credential
 * provider in `$DSH_HOME/.credentials.yaml` under `records.<key>.payload.secret`.
 *
 * Transcribed from @deepseek-ai/dsh-client-connection/lib/index.js lines 223-322.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const AUTH_RECORD_KEY = 'client-connection/browser-session'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const TOKEN_QUERY = 'token'
const DEFAULT_MAX_AGE_DAYS = 30

const b64url = (v) => Buffer.from(v).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** Cookie name for one request authority (`host:port` as the client sends it). */
export function cookieNameFor(authority) {
  return COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest())
}

/**
 * Read the browser-session signing secret from `$DSH_HOME/.credentials.yaml`.
 * Deliberately a narrow line scan rather than a YAML parse, so the helper has
 * no dependencies; it also means the file must keep its current indentation.
 * @returns {Buffer} the 32-byte secret
 */
export function readSigningSecret(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const file = path.join(dshHome, '.credentials.yaml')
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim().startsWith(AUTH_RECORD_KEY + ':'))
  if (start < 0) throw new Error(`record "${AUTH_RECORD_KEY}" not found in ${file}`)
  let encoded = null
  for (let i = start + 1; i < lines.length; i++) {
    // A new top-level key ends the record.
    if (/^\S/.test(lines[i]) && !/^\s*$/.test(lines[i])) break
    const m = /^\s+secret:\s*(\S+)\s*$/.exec(lines[i])
    if (m) { encoded = m[1]; break }
  }
  if (encoded === null) throw new Error(`secret not found under "${AUTH_RECORD_KEY}" in ${file}`)
  const secret = Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (secret.byteLength !== 32) throw new Error(`secret must be 32 bytes, got ${secret.byteLength}`)
  return secret
}

/**
 * Mint one valid browser-session cookie value.
 * @param {string} authority - exact `host:port` the request will carry in Host
 * @param {Buffer} secret - signing secret
 * @param {number} [maxAgeDays] - must match the server's `cookieMaxAgeDays`
 */
export function mintCookie(authority, secret, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const issuedAt = Date.now()
  const expiresAt = issuedAt + maxAgeDays * 1440 * 60 * 1000
  const body = b64url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt,
  }), 'utf8'))
  const sig = b64url(createHmac('sha256', secret).update(body).digest())
  return { name: cookieNameFor(authority), value: `v1.${body}.${sig}` }
}

/** Convenience: build the `Cookie` header for one authority. */
export function cookieHeader(dshHome) {
  return (baseUrl) => {
    const u = new URL(baseUrl)
    const { name, value } = mintCookie(u.host, readSigningSecret(dshHome))
    return `${name}=${value}`
  }
}

/**
 * Authenticated fetch against the DSH web server.
 * @param {string} url - absolute URL on the DSH origin
 * @param {RequestInit} [init]
 */
export async function dshFetch(url, init = {}) {
  const u = new URL(url)
  const { name, value } = mintCookie(u.host, readSigningSecret())
  const headers = new Headers(init.headers || {})
  headers.set('cookie', `${name}=${value}`)
  return fetch(url, { ...init, headers })
}

// ------------------------------------------------------------------ CLI usage
// node dsh-auth.mjs post /dev-task '{"sessionId":"...","text":"hello"}'
if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}`
  || process.argv[1]?.endsWith('dsh-auth.mjs')) {
  const [, , action, target, payload] = process.argv
  const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
  if (action === 'cookie') {
    // Print just the cookie name/value pair for use with curl.
    const u = new URL(base)
    const { name, value } = mintCookie(u.host, readSigningSecret())
    console.log(`${name}=${value}`)
  } else if (action === 'get' || action === 'post') {
    const res = await dshFetch(base + (target || '/'), {
      method: action.toUpperCase(),
      ...(action === 'post'
        ? { headers: { 'Content-Type': 'application/json' }, body: payload ?? '{}' }
        : {}),
    })
    console.log(`HTTP ${res.status}`)
    console.log((await res.text()).slice(0, 2000))
  } else {
    console.log('usage: node dsh-auth.mjs cookie')
    console.log('       node dsh-auth.mjs get  /some/path')
    console.log('       node dsh-auth.mjs post /dev-task \'{"sessionId":"...","text":"..."}\'')
  }
}
