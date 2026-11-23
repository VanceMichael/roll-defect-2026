import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { Capability } from '../capability/core.mjs'
import { createService } from '../capability/service.mjs'
import { parseTile, TileStore } from '../capability/tiles.mjs'
import * as layout from '../capability/layout.mjs'
import * as geo from '../capability/geometry.mjs'

const media = name => readFile(new URL('../records/media/' + name, import.meta.url))

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port
}

async function boot(t) {
  const sourceRoot = await listen(t, createSource())
  const providerRoot = await listen(t, provider())
  const capability = new Capability({ sourceRoot, providerRoot })
  const post = (root, path) => fetch(root + path, { method: 'POST' })
  return { capability, sourceRoot, providerRoot, post }
}

test('区块凭据解析：完整块、空块、坏头、残块', async () => {
  const p1 = parseTile(await media('scan-p1.dat'))
  assert.deepEqual(p1, [{ y0: 12, y1: 14, x0: 3, x1: 5, confirmed: false }])
  const p2 = parseTile(await media('scan-p2.dat'))
  assert.equal(p2.length, 2)
  assert.ok(p2.every(record => record.confirmed))
  assert.deepEqual(parseTile(await media('scan-q.dat')), []) // 零缺陷的完整块
  assert.throws(() => parseTile(Buffer.from('XXXX')), error => error.code === 'bad-magic')
  assert.throws(() => parseTile(Buffer.concat([Buffer.from('PPR1'), Buffer.alloc(5)])), error => error.code === 'incomplete')
})

test('凭据库按扫描代管理：旧读数不充当新标定', async () => {
  const [p1, p2] = await Promise.all([media('scan-p1.dat'), media('scan-p2.dat')])
  const store = new TileStore()
  const entry = (generation, sha256) => ({ mother: 'P', tile: 'X1', generation, path: '/x', box: [10, 20, 0, 8], sha256 })
  const g1 = await store.observe([entry('g1', '21560ac9dd64b18aa8854d17e3089d707537b55898374cb21d76303ba6740622')], async () => p1)
  assert.equal(g1[0].status, 'valid')
  // 重扫后索引已是 g2，取回的却仍是 g1 的件 → 旧读数
  const g2stale = await store.observe([entry('g2', '84378d1c912edac27be7018f2538b3cc46f31338a12ae6ba7cc59334846e60c8')], async () => p1)
  assert.equal(g2stale[0].status, 'stale')
  // 取回与任何已知代都对不上的件 → 哈希不符
  const g2bad = await store.observe([entry('g2', '84378d1c912edac27be7018f2538b3cc46f31338a12ae6ba7cc59334846e60c8')], async () => Buffer.from('PPR1'))
  assert.equal(g2bad[0].status, 'hash-mismatch')
  // 凭据到位 → 有效
  const g2ok = await store.observe([entry('g2', '84378d1c912edac27be7018f2538b3cc46f31338a12ae6ba7cc59334846e60c8')], async () => p2)
  assert.equal(g2ok[0].status, 'valid')
  // 取件失败 → 缺凭据
  const gone = await store.observe([entry('g2', '84378d1c912edac27be7018f2538b3cc46f31338a12ae6ba7cc59334846e60c8')], async () => { throw new Error('404') })
  assert.equal(gone[0].status, 'missing')
})

test('谱系映射：拼接、反向、裁边后的双轴换算', () => {
  const segments = layout.parseCuts([
    ['F', '0', '10', 'P', '10', '20', '0', '4', '-'],
    ['F', '10', '20', 'Q', '0', '10', '5', '9', '+'],
    ['G', '0', '10', 'P', '10', '20', '4', '8', '+']
  ])
  const byRoll = layout.groupByFinished(segments)
  // 反向段：F 纵 4-10 → 母卷 P 纵 10-16，横 2-4 → P 横 2-4
  const [partF] = layout.usageToMother(byRoll.get('F'), { y0: 4, y1: 10, u0: 2, u1: 4 }).parts
  assert.deepEqual(partF.rect, { y0: 10, y1: 16, x0: 2, x1: 4 })
  // 同一横线 u=0 在不同纵段指向不同母卷：F 纵 10-20 → Q 横 5-6
  const [partQ] = layout.usageToMother(byRoll.get('F'), { y0: 10, y1: 20, u0: 0, u1: 1 }).parts
  assert.deepEqual(partQ.rect, { y0: 0, y1: 10, x0: 5, x1: 6 })
  // 孔洞回落：P 纵 12-14 横 3-5 反向映到 F 纵 6-8；横 4-5 不在 F 的裁窗内（归 G），只落横 3-4
  const [hitF] = layout.holeToFinished(byRoll.get('F'), { mother: 'P', y0: 12, y1: 14, x0: 3, x1: 5 })
  assert.deepEqual(hitF.rect, { y0: 6, y1: 8, x0: 3, x1: 4 })
  // 裁边后：P 纵 13-15 横 6-7 映到 G 纵 3-5 横 2-3，且不在 F 上
  const [hitG] = layout.holeToFinished(byRoll.get('G'), { mother: 'P', y0: 13, y1: 15, x0: 6, x1: 7 })
  assert.deepEqual(hitG.rect, { y0: 3, y1: 5, x0: 2, x1: 3 })
  assert.equal(layout.holeToFinished(byRoll.get('F'), { mother: 'P', y0: 13, y1: 15, x0: 6, x1: 7 }).length, 0)
})

test('矩形减法与半开相交', () => {
  const pieces = geo.subtract(geo.rect(0, 10, 0, 10), geo.rect(2, 4, 2, 4))
  assert.equal(pieces.length, 4)
  assert.equal(pieces.reduce((sum, piece) => sum + geo.area(piece), 0), 96)
  assert.equal(geo.intersection(geo.rect(0, 8, 0, 4), geo.rect(8, 10, 0, 4)), null) // 半开：贴边不算相交
  assert.deepEqual(geo.subtractAll(geo.rect(0, 10, 0, 4), [geo.rect(0, 8, 0, 4)]), [geo.rect(8, 10, 0, 4)])
})

test('初检（r1 + scan）：覆盖缺失与已确认缺陷分开，界外孔不扣本单', async t => {
  const { capability } = await boot(t)
  const { edition, changes, summary } = await capability.refresh()
  assert.equal(edition, 'r1')
  assert.equal(changes.initial, true)
  assert.deepEqual(summary.tiles, { valid: 2 })

  // O1 已装出：d1 尚未复判，只挂待复判，不扣单
  const o1 = await capability.assessOrder('O1')
  assert.equal(o1.disposition, 'departed-clear')
  assert.deepEqual(o1.charged, [])
  assert.deepEqual(o1.pendingReview.map(h => h.hole), ['d1'])
  assert.deepEqual(o1.outOfScope.map(h => h.hole), ['d2']) // 同卷界外已确认孔洞，不扣这一单
  assert.deepEqual(o1.evidence.map(e => [e.tile, e.generation, e.status]), [['X1', 'g1', 'valid']])
  assert.deepEqual(o1.evidence[0].sharedWith, ['O3']) // 与 O3 共用的原检区块仍可留用

  // O2：Q 纵 8-10 检窗口未完成 → 覆盖缺失；d2 超出用幅不扣
  const o2 = await capability.assessOrder('O2')
  assert.equal(o2.disposition, 'await-evidence')
  assert.equal(o2.gaps.length, 1)
  assert.deepEqual(o2.gaps[0].rect, { y0: 8, y1: 10, x0: 5, x1: 6 })
  assert.deepEqual(o2.gaps[0].finishedRect, { y0: 18, y1: 20, x0: 0, x1: 1 })
  assert.equal(o2.gaps[0].reason, 'window-incomplete')
  assert.equal(o2.gaps[0].window, 'sq2')
  assert.deepEqual(o2.outOfScope.map(h => h.hole), ['d2'])
  assert.equal(o2.gate.canScanIn, false)
  assert.deepEqual(o2.gate.reasons, ['evidence-gap'])

  // O3：P 覆盖完整、无相交缺陷 → 可继续扫描入车
  const o3 = await capability.assessOrder('O3')
  assert.equal(o3.disposition, 'clear')
  assert.equal(o3.gate.canScanIn, true)
  assert.deepEqual(o3.evidence[0].sharedWith, ['O1'])

  // 业务确认 d2 但凭据里无此记录 → 两侧互查差异
  assert.deepEqual(capability.snapshot.discrepancies, [{ type: 'hole-without-credential', mother: 'Q', hole: 'd2' }])

  const dock = await capability.dockReport()
  const slots = Object.fromEntries(dock.slots.map(slot => [slot.slot, slot]))
  assert.equal(slots.X.reassignable, true)  // 已装出，车位空
  assert.equal(slots.M.reassignable, false) // 排队中
  assert.equal(slots.L.reassignable, false) // 仍在打印原票
  assert.equal(slots.L.reason, 'printing')
})

test('复检更正（r2 + rescan）：隔离相交段、阻止入车、车位不重新分配', async t => {
  const { capability, sourceRoot, providerRoot, post } = await boot(t)
  await capability.refresh()
  await post(sourceRoot, '/control?edition=r2')
  await post(providerRoot, '/lab?stage=rescan')
  const { changes } = await capability.refresh()

  // 更正内容：d1、d3 转确认，d2 撤销；X1 升为 g2 但取回旧读数；Q 缺口补上
  assert.deepEqual(changes.edition, { from: 'r1', to: 'r2' })
  assert.deepEqual(changes.holesConfirmed, ['d1', 'd3'])
  assert.deepEqual(changes.holesCleared, ['d2'])
  assert.deepEqual(changes.generations, [{ mother: 'P', tile: 'X1', from: 'g1', to: 'g2' }])
  assert.deepEqual(changes.tileStatus, [{ mother: 'P', tile: 'X1', generation: 'g2', from: 'valid', to: 'stale' }])
  assert.deepEqual(changes.coverageGained, [{ mother: 'Q', rect: { y0: 8, y1: 10, x0: 5, x1: 9 } }])
  assert.deepEqual(changes.coverageLost, [{ mother: 'P', rect: { y0: 10, y1: 20, x0: 0, x1: 8 } }])

  // O3 尚未出库，d3 相交 → 隔离相交段并阻止扫描入车；P 凭据缺口按代定位
  const o3 = await capability.assessOrder('O3')
  assert.equal(o3.disposition, 'isolate-required')
  assert.deepEqual(o3.charged.map(h => h.hole), ['d3'])
  assert.deepEqual(o3.charged[0].rect, { y0: 3, y1: 5, x0: 2, x1: 3 })
  assert.deepEqual(o3.charged[0].motherRect, { y0: 13, y1: 15, x0: 6, x1: 7 })
  assert.equal(o3.charged[0].evidenceOk, false)
  assert.equal(o3.gaps[0].reason, 'credential-stale')
  assert.equal(o3.gaps[0].generation, 'g2')
  assert.deepEqual(o3.outOfScope.map(h => h.hole), ['d1']) // d1 在 G 上但超出 O3 用幅

  // O1 已装车出门 → 留原单，报截回区间
  const o1 = await capability.assessOrder('O1')
  assert.equal(o1.disposition, 'recall')
  assert.deepEqual(o1.actions[0].intervals, [{ y0: 6, y1: 8, x0: 3, x1: 4 }])

  // O2 不相交 → 继续
  const o2 = await capability.assessOrder('O2')
  assert.equal(o2.disposition, 'clear')
  assert.equal(o2.gate.canScanIn, true)

  // 提交隔离：只隔相交段；202 后装车台仍在打印原票 → 车位不重新分配
  const { holds, dock } = await capability.reconcile({ autoHold: true })
  assert.deepEqual(holds.map(h => [h.label, h.status]), [['D1', 202]])
  const slots = Object.fromEntries(dock.slots.map(slot => [slot.slot, slot]))
  assert.equal(slots.L.reassignable, false)
  assert.equal(slots.L.reason, 'hold-accepted-awaiting-readback')
  const gates = Object.fromEntries(dock.gates.map(gate => [gate.order, gate]))
  assert.equal(gates.O3.canScanIn, false)
  assert.ok(gates.O3.reasons.includes('hold-pending-readback'))
  assert.equal(gates.O2.canScanIn, true) // 原先没有相交的另一订单继续
})

test('回读生效（r2 + known）：凭据到位、车位释放、主管查询', async t => {
  const { capability, sourceRoot, providerRoot, post } = await boot(t)
  await capability.refresh()
  await post(sourceRoot, '/control?edition=r2')
  await post(providerRoot, '/lab?stage=rescan')
  await capability.refresh()
  await capability.reconcile({ autoHold: true })
  await post(providerRoot, '/lab?stage=known')
  const { changes } = await capability.refresh()

  // g2 凭据到位，D1 回读 held
  assert.deepEqual(changes.tileStatus, [{ mother: 'P', tile: 'X1', generation: 'g2', from: 'stale', to: 'valid' }])
  assert.deepEqual(changes.coverageGained, [{ mother: 'P', rect: { y0: 10, y1: 20, x0: 0, x1: 8 } }])
  assert.deepEqual(changes.labels, [{ label: 'D1', order: 'O3', from: 'printing', to: 'held' }])

  const o3 = await capability.assessOrder('O3')
  assert.equal(o3.disposition, 'isolated')
  assert.equal(o3.charged[0].evidenceOk, true)
  assert.deepEqual(o3.gaps, [])

  const dock = await capability.dockReport()
  const slots = Object.fromEntries(dock.slots.map(slot => [slot.slot, slot]))
  assert.equal(slots.L.reassignable, true) // 有效回读之后才可重新分配

  // 主管查询 F：母卷证据、补扫缺口、真实在车状态、需处置的用幅
  const f = await capability.supervisor('F')
  assert.equal(f.edition, 'r2')
  assert.deepEqual(f.gaps, [])
  const tileP = f.evidence.find(e => e.mother === 'P').tiles[0]
  assert.deepEqual([tileP.tile, tileP.generation, tileP.status], ['X1', 'g2', 'valid'])
  assert.equal(tileP.defects.length, 2)
  assert.deepEqual(f.onTruck, [
    { order: 'O1', label: 'D3', slot: 'X', state: 'departed' },
    { order: 'O2', label: 'D2', slot: 'M', state: 'queued' }
  ])
  assert.deepEqual(f.recalls, [{
    order: 'O1', label: 'D3',
    intervals: [{ hole: 'd1', finished: { y0: 6, y1: 8, x0: 3, x1: 4 }, mother: { y0: 12, y1: 14, x0: 3, x1: 4 } }]
  }])
  assert.deepEqual(f.usages.map(u => [u.order, u.disposition]), [['O1', 'recall'], ['O2', 'clear']])
  assert.deepEqual(f.discrepancies, [])

  const g = await capability.supervisor('G')
  assert.deepEqual(g.usages.map(u => [u.order, u.disposition]), [['O3', 'isolated']])
  assert.deepEqual(g.onTruck, [{ order: 'O3', label: 'D1', slot: 'L', state: 'held' }])
  assert.deepEqual(g.recalls, [])
})

test('服务接口：两边系统对接的核查端点', async t => {
  const sourceRoot = await listen(t, createSource())
  const providerRoot = await listen(t, provider())
  const root = await listen(t, createService({ sourceRoot, providerRoot }))
  const json = async response => ({ status: response.status, body: await response.json() })

  assert.deepEqual(await json(await fetch(root + '/health')), { status: 200, body: { ok: true, edition: null } })
  const refresh = await json(await fetch(root + '/refresh', { method: 'POST' }))
  assert.equal(refresh.body.edition, 'r1')

  const o2 = await json(await fetch(root + '/requisitions/O2'))
  assert.equal(o2.body.disposition, 'await-evidence')

  // 装车台问「同一成品卷的另一段能不能先发」→ 任意双轴范围核查
  const check = await json(await fetch(root + '/requisitions/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finished: 'F', y: [10, 20], u: [0, 1] })
  }))
  assert.equal(check.body.decision, 'insufficient-evidence')
  assert.equal(check.body.gaps[0].reason, 'window-incomplete')

  const missing = await json(await fetch(root + '/requisitions/O9'))
  assert.equal(missing.status, 404)

  const dock = await json(await fetch(root + '/dock'))
  assert.equal(dock.body.slots.length, 3)

  const f = await json(await fetch(root + '/supervisor/rolls/F'))
  assert.equal(f.body.finished, 'F')
  assert.equal(f.body.gaps.length, 1) // Q 纵 8-10 待补扫
  assert.equal(f.body.gaps[0].reason, 'window-incomplete')
})
