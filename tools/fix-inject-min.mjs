/** 最小修复：exports.inject = []  →  ['slots']（并把结果打印出来自证）。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'lib', 'client.js')
let s = fs.readFileSync(CLIENT, 'utf8')

const BEFORE = 'exports.inject = []'
const AFTER = "exports.inject = ['slots']"

console.log('  替换前：文件里有没有 "' + BEFORE + '" → ' + (s.includes(BEFORE) ? '有' : '没有'))
if (s.includes(BEFORE)) {
  s = s.replace(BEFORE, AFTER)
  fs.writeFileSync(CLIENT, s, 'utf8')
}
const now = fs.readFileSync(CLIENT, 'utf8')
console.log('  替换后：含 "' + AFTER + '" → ' + (now.includes(AFTER) ? '是 ✅' : '否 ✗'))
for (const line of now.split(/\r?\n/)) {
  if (line.includes('exports.inject')) console.log('  实际行：' + line.trim())
}
