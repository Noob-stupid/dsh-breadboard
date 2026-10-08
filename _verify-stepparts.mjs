// 上线验证：step.parts 搜索 + 一键导入（真下载真入库）。跑完即删。
const b = 'http://127.0.0.1:19387/@dsh-breadboard/dsh-hardware-sandbox'
const j = async (r) => {
  const t = await r.text()
  try { return JSON.parse(t) } catch { return t.slice(0, 120) }
}

console.log('build =', (await j(await fetch(b + '/api/capabilities'))).build)
console.log()

console.log('=== 1. 搜索：应返回**可一键导入的候选** ===')
const t0 = Date.now()
const s = await j(await fetch(b + '/api/model-search?q=' + encodeURIComponent('raspberry pi')))
console.log('  HTTP 200 |', (s.candidates || []).length, '条候选 |', Date.now() - t0, 'ms')
for (const c of (s.candidates || []).slice(0, 6)) {
  const mb = c.byteSize ? (c.byteSize / 1024 / 1024).toFixed(1) + 'MB' : '?'
  console.log('   ·', String(c.name).padEnd(34), mb.padStart(7), '|', c.manufacturer || '', '| 可导入 =', c.importable)
  if (c.sizeMm) console.log('      来源标注尺寸:', JSON.stringify(c.sizeMm), '(可直接当 size 初值)')
}
console.log('  外链兜底:', (s.sources || []).length, '条')
console.log()

console.log('=== 2. 一键导入：小件（Pico 1.7MB）验证管线 ===')
const t1 = Date.now()
const imp = await fetch(b + '/api/model-import', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ modelKey: 'rpi-4b', partId: 'raspberry_pi_pico' }),
})
const o1 = await j(imp)
console.log('  HTTP', imp.status, '|', Date.now() - t1, 'ms')
console.log('  ', JSON.stringify(o1.record || o1).slice(0, 140))
console.log()

console.log('=== 3. 取回校验（应是 GLB，逐字节与上游一致由魔数+大小确认）===')
const g = await fetch(b + '/api/model/rpi-4b')
const bytes = Buffer.from(await g.arrayBuffer())
console.log('  HTTP', g.status, '|', g.headers.get('content-type'), '|', bytes.length, 'bytes')
console.log('  魔数 =', JSON.stringify(bytes.subarray(0, 4).toString('ascii')))
console.log()

console.log('=== 4. 超限拒绝：树莓派 4B 是 52MB（上限 64MB，应能过）===')
const imp2 = await fetch(b + '/api/model-import', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ modelKey: 'bme280', partId: 'raspberry_pi_4_model_b' }),
})
console.log('  HTTP', imp2.status, '(200=在限内已下载；413=超限)', '|', JSON.stringify(await j(imp2)).slice(0, 100))
console.log()

console.log('=== 5. 最终清单 ===')
console.log(' ', JSON.stringify(await j(await fetch(b + '/api/model'))))
