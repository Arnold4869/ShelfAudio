/**
 * 静态自检：所有 import 的名字，目标模块是否真的导出了
 * 用法: node scripts/check-imports.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const files = [
  'src/app.js',
  'src/lib/api.js', 'src/lib/player.js', 'src/lib/store.js',
  'src/lib/voice.js', 'src/lib/voice-ui.js', 'src/lib/permissions.js',
  'src/views/shelf.js', 'src/views/player.js', 'src/views/search.js',
  'src/views/settings.js', 'src/views/login.js',
]

/** 收集一个文件里所有被导出的名字 */
function exportedNames(src) {
  const names = new Set()
  // export function / async function / const / let / class
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1])
  }
  // export { a, b as c }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const asMatch = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      const raw = t.replace(/\s+as\s+[A-Za-z_$][\w$]*$/, '').trim()
      names.add(asMatch ? asMatch[1] : raw)
    }
  }
  // export default
  if (/export\s+default\b/.test(src)) names.add('default')
  return names
}

let problems = 0
let checked = 0

for (const rel of files) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) { console.log(`❌ 文件不存在: ${rel}`); problems++; continue }
  const src = fs.readFileSync(abs, 'utf8')

  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2]
    if (!spec.startsWith('.')) continue            // 第三方包不检查
    const target = path.resolve(path.dirname(abs), spec)
    if (!fs.existsSync(target)) {
      console.log(`❌ ${rel} → 模块不存在: ${spec}`); problems++; continue
    }
    const targetSrc = fs.readFileSync(target, 'utf8')
    const avail = exportedNames(targetSrc)

    for (const raw of m[1].split(',')) {
      const t = raw.trim()
      if (!t) continue
      const name = t.replace(/\s+as\s+.*$/, '').trim()
      if (!name) continue
      checked++
      if (!avail.has(name)) {
        console.log(`❌ ${rel} 引用了 "${name}"，但 ${spec} 未导出`)
        problems++
      }
    }
  }
}

console.log('─'.repeat(46))
if (problems === 0) console.log(`✅ 导入/导出全部一致（检查 ${checked} 个符号）`)
else console.log(`发现 ${problems} 个问题（检查 ${checked} 个符号）`)
process.exit(problems ? 1 : 0)
