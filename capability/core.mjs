// 领料核查核心：从现场扫描凭据一路核到本次真要装车的用幅。
//
// 数据汇合：
//   业务来源（cuts/scan/holes/issued，分资料版） + 现场接口（区块索引/凭据原件/装车台标签）
// 判定口径：
//   - 质量依据只认完整且哈希匹配的区块凭据（按扫描代、母卷、区块定位，旧读数不算数）
//   - 缺陷判定以当前资料版 holes 的复判接受位为准，且两个维度均有正长度相交才扣这一单
//   - 覆盖缺失与已确认缺陷分开报告；超出本次用幅的孔洞不扣这一单
//   - 装车台真实回执（labels）是在车状态的唯一依据；隔离以回读到 held 为准

import { SourceClient, ProviderClient } from './clients.mjs'
import { TileStore } from './tiles.mjs'
import * as geo from './geometry.mjs'
import * as layout from './layout.mjs'

function parseHoles(rows) {
  return rows.map(([id, mother, y0, y1, x0, x1, accept]) => ({
    id, mother,
    y0: Number(y0), y1: Number(y1), x0: Number(x0), x1: Number(x1),
    confirmed: accept === '1'
  }))
}

function parseScan(rows) {
  return rows.map(([mother, window, y0, y1, done]) => ({
    mother, window, y0: Number(y0), y1: Number(y1), done: done === '1'
  }))
}

function parseIssued(rows) {
  return rows.map(([order, finished, y0, y1, u0, u1, status]) => ({
    order, finished,
    y0: Number(y0), y1: Number(y1), u0: Number(u0), u1: Number(u1), status
  }))
}

export class Capability {
  constructor({ sourceRoot, providerRoot, fetchImpl } = {}) {
    this.source = new SourceClient(sourceRoot, fetchImpl)
    this.provider = new ProviderClient(providerRoot, fetchImpl)
    this.tiles = new TileStore()
    this.snapshot = null
    this.pendingHolds = new Map() // 标签号 → { intervals, range }，已 202 接收但尚未回读 held
  }

  async ensure() {
    if (!this.snapshot) await this.refresh()
  }

  // 拉齐两侧资料并给出相对上一快照的变化（复检更正、扫描代更替、缺口开合、回执变化）
  async refresh() {
    const previous = this.snapshot
    const catalog = await this.source.catalog()
    const [cuts, scan, holes, issued] = await Promise.all([
      this.source.stream('cuts'),
      this.source.stream('scan'),
      this.source.stream('holes'),
      this.source.stream('issued')
    ])
    const index = await this.provider.scanIndex()
    const tiles = await this.tiles.observe(index, path => this.provider.raw(path))
    const labels = await this.provider.labels()
    const snapshot = buildSnapshot({
      edition: catalog.edition, cuts: cuts.rows, scan: scan.rows,
      holes: holes.rows, issued: issued.rows, tiles, labels
    })
    for (const [label, hold] of [...this.pendingHolds]) {
      const current = labels.find(row => row.label === label)
      if (current && current.state === 'held') {
        this.pendingHolds.delete(label)
        hold.effective = true
      }
    }
    this.snapshot = snapshot
    return { edition: snapshot.edition, changes: diffSnapshots(previous, snapshot), summary: summarize(snapshot) }
  }

  // 单张领料单核查
  async assessOrder(order) {
    await this.ensure()
    const row = this.snapshot.issuedByOrder.get(order)
    if (!row) return null
    return this.assessIssued(row)
  }

  // 全部领料单的处置计划（装车台「能不能先发另一段」就看这里）
  async plan() {
    await this.ensure()
    const orders = this.snapshot.issued.map(row => this.assessIssued(row))
    const byDisposition = {}
    for (const result of orders) byDisposition[result.disposition] = (byDisposition[result.disposition] || 0) + 1
    return { edition: this.snapshot.edition, orders, byDisposition }
  }

  // 任意双轴范围的核查（同一成品卷的另一段）
  async assessRange(finished, usage) {
    await this.ensure()
    return this.assessUsage(this.snapshot, finished, usage)
  }

  // 对需要隔离的未出库标签提交隔离（只隔相交段），返回回执与最新计划
  async reconcile({ autoHold = false } = {}) {
    await this.ensure()
    const holds = []
    if (autoHold) {
      for (const row of this.snapshot.issued) {
        const result = this.assessIssued(row)
        if (result.disposition !== 'isolate-required' || !result.label) continue
        if (this.pendingHolds.has(result.label.label)) continue
        const intervals = result.charged.map(entry => entry.rect)
        const range = geo.bounding(intervals)
        const receipt = await this.provider.hold({
          label: result.label.label,
          range: [range.y0, range.y1, range.x0, range.x1],
          intervals: intervals.map(r => [r.y0, r.y1, r.x0, r.x1])
        })
        if (receipt.status === 202) {
          this.pendingHolds.set(result.label.label, { intervals, range })
        }
        holds.push({ label: result.label.label, order: row.order, status: receipt.status, receipt: receipt.body })
      }
      if (holds.length) await this.reloadLabels()
    }
    return { holds, plan: await this.plan(), dock: await this.dockReport() }
  }

  // 装车台视角：标签、车位可否重新分配、各单能否继续扫描入车
  async dockReport() {
    await this.ensure()
    const slots = []
    for (const label of this.snapshot.labels) {
      const pending = this.pendingHolds.get(label.label)
      const reassignable = (label.state === 'held' || label.state === 'departed') && !pending
      let reason = null
      if (!reassignable) {
        if (pending) reason = 'hold-accepted-awaiting-readback' // 已接收隔离却仍在打印原票
        else if (label.state === 'printing') reason = 'printing'
        else reason = 'occupied'
      }
      slots.push({ slot: label.slot, label: label.label, order: label.order, state: label.state, reassignable, reason })
    }
    const gates = this.snapshot.issued.map(row => {
      const result = this.assessIssued(row)
      return { order: row.order, label: result.label?.label ?? null, ...result.gate }
    })
    return { labels: this.snapshot.labels, slots, gates }
  }

  // 主管查询：从成品度量追到母卷证据、补扫缺口、真实在车状态、需处置的用幅
  async supervisor(finished) {
    await this.ensure()
    const segments = this.snapshot.segmentsByFinished.get(finished)
    if (!segments) return null
    const mothers = [...new Set(segments.map(seg => seg.mother))]
    const evidence = mothers.map(mother => ({
      mother,
      tiles: (this.snapshot.tilesByMother.get(mother) ?? []).map(tile => ({
        tile: tile.tile, generation: tile.generation, box: tile.box,
        status: tile.status, defects: tile.records
      })),
      windows: this.snapshot.windowsByMother.get(mother) ?? { done: [], incomplete: [] }
    }))
    const gaps = []
    for (const seg of segments) {
      const full = geo.rect(seg.my0, seg.my1, seg.mx0, seg.mx1)
      const coverage = this.snapshot.coverageByMother.get(seg.mother) ?? []
      for (const rest of geo.subtractAll(full, coverage)) {
        gaps.push({
          mother: seg.mother, rect: rest,
          finishedRect: layout.motherRectToFinished(seg, rest),
          ...this.gapReason(seg.mother, rest)
        })
      }
    }
    const usages = this.snapshot.issued
      .filter(row => row.finished === finished)
      .map(row => this.assessIssued(row))
    const onTruck = usages.map(result => ({
      order: result.order,
      label: result.label?.label ?? null,
      slot: result.label?.slot ?? null,
      state: result.label?.state ?? 'unknown'
    }))
    const recalls = usages
      .filter(result => result.disposition === 'recall')
      .map(result => ({
        order: result.order,
        label: result.label?.label ?? null,
        intervals: result.charged.map(entry => ({ hole: entry.hole, finished: entry.rect, mother: entry.motherRect }))
      }))
    return {
      finished,
      edition: this.snapshot.edition,
      segments: segments.map(seg => ({
        range: [seg.f0, seg.f1], mother: seg.mother,
        motherY: [seg.my0, seg.my1], motherX: [seg.mx0, seg.mx1], direction: seg.dir
      })),
      evidence,
      gaps,
      usages,
      onTruck,
      recalls,
      discrepancies: this.snapshot.discrepancies.filter(item => mothers.includes(item.mother))
    }
  }

  async reloadLabels() {
    const labels = await this.provider.labels()
    this.snapshot = { ...this.snapshot, labels, labelByOrder: new Map(labels.map(row => [row.order, row])) }
    for (const [label, hold] of [...this.pendingHolds]) {
      const current = labels.find(row => row.label === label)
      if (current && current.state === 'held') {
        this.pendingHolds.delete(label)
        hold.effective = true
      }
    }
  }

  assessIssued(row) {
    const usage = { y0: row.y0, y1: row.y1, u0: row.u0, u1: row.u1 }
    const base = this.assessUsage(this.snapshot, row.finished, usage, row.order)
    const label = this.snapshot.labelByOrder.get(row.order) ?? null
    const departed = label?.state === 'departed'
    const held = label?.state === 'held'
    const pending = label ? this.pendingHolds.get(label.label) : null
    let disposition
    if (departed) disposition = base.charged.length ? 'recall' : 'departed-clear'
    else if (base.charged.length) disposition = held ? 'isolated' : 'isolate-required'
    else if (base.gaps.length) disposition = 'await-evidence'
    else disposition = 'clear'
    const actions = []
    if (disposition === 'recall') {
      actions.push({ type: 'recall', intervals: base.charged.map(entry => entry.rect), note: '已装车出门，留原单，截回或继续追踪' })
    }
    if (disposition === 'isolate-required') {
      actions.push({ type: 'isolate', label: label?.label ?? null, slot: label?.slot ?? null, intervals: base.charged.map(entry => entry.rect), note: '只隔离相交段，回读 held 前车位不重新分配' })
    }
    if (disposition === 'isolated') {
      actions.push({ type: 'isolated', label: label?.label ?? null, slot: label?.slot ?? null, intervals: base.charged.map(entry => entry.rect) })
    }
    if (disposition === 'await-evidence') {
      actions.push({ type: 'rescan', gaps: base.gaps, note: '覆盖缺失区域需补扫或重新取件后才能放行' })
    }
    const reasons = []
    if (departed) reasons.push('departed')
    if (base.charged.length) reasons.push('defect-charged')
    if (base.gaps.length) reasons.push('evidence-gap')
    if (held) reasons.push('isolated')
    if (pending) reasons.push('hold-pending-readback')
    return {
      ...base,
      order: row.order,
      recordStatus: row.status,
      label,
      disposition,
      actions,
      gate: { canScanIn: reasons.length === 0, reasons }
    }
  }

  // 双轴范围核查：应领的原检区块、覆盖缺失、已确认缺陷、不扣本单的界外孔洞
  assessUsage(snapshot, finished, usage, excludeOrder = null) {
    const segments = snapshot.segmentsByFinished.get(finished)
    if (!segments) {
      const error = new Error(`没有成品卷 ${finished} 的谱系`)
      error.code = 'no-such-roll'
      throw error
    }
    const { parts, warnings } = layout.usageToMother(segments, usage)
    const usageRect = geo.rect(usage.y0, usage.y1, usage.u0, usage.u1)

    // 其他领料单在同一区块上的占用（用于「共用的原检区块仍可留用」）
    const usageOf = new Map()
    for (const row of snapshot.issued) {
      if (row.order === excludeOrder) continue
      usageOf.set(row.order, layout.usageToMother(
        snapshot.segmentsByFinished.get(row.finished) ?? [],
        { y0: row.y0, y1: row.y1, u0: row.u0, u1: row.u1 }
      ).parts)
    }

    // 应领的原检区块：与任一母卷矩形相交的当前代区块；多块领料单可共用留用
    const evidence = []
    for (const tile of snapshot.tiles) {
      const hits = parts.filter(part => part.segment.mother === tile.mother && geo.intersects(tile.box, part.rect))
      if (!hits.length) continue
      evidence.push({
        mother: tile.mother, tile: tile.tile, generation: tile.generation,
        box: tile.box, status: tile.status, defects: tile.records,
        sharedWith: snapshot.issued
          .filter(row => (usageOf.get(row.order) ?? [])
            .some(part => part.segment.mother === tile.mother && geo.intersects(tile.box, part.rect)))
          .map(row => row.order)
      })
    }

    // 覆盖缺失：应覆盖范围减去有效凭据覆盖
    const gaps = []
    for (const part of parts) {
      const coverage = snapshot.coverageByMother.get(part.segment.mother) ?? []
      for (const rest of geo.subtractAll(part.rect, coverage)) {
        gaps.push({
          mother: part.segment.mother, rect: rest,
          finishedRect: layout.motherRectToFinished(part.segment, rest),
          ...this.gapReason(part.segment.mother, rest)
        })
      }
    }

    // 孔洞分类：相交且已确认 → 扣这一单；相交未复判 → 待复判；同卷界外已确认 → 不扣这一单
    const charged = []
    const pendingReview = []
    const outOfScope = []
    for (const hit of snapshot.holesByFinished.get(finished) ?? []) {
      const clipped = geo.intersection(hit.rect, usageRect)
      if (hit.hole.confirmed && clipped) {
        const coverage = snapshot.coverageByMother.get(hit.hole.mother) ?? []
        charged.push({
          hole: hit.hole.id, rect: clipped, motherRect: hit.motherRect,
          evidenceOk: geo.subtractAll(hit.motherRect, coverage).length === 0
        })
      } else if (clipped) {
        pendingReview.push({ hole: hit.hole.id, rect: clipped, motherRect: hit.motherRect })
      } else if (hit.hole.confirmed) {
        outOfScope.push({ hole: hit.hole.id, rect: hit.rect, motherRect: hit.motherRect })
      }
    }

    const decision = charged.length ? 'defect-detected' : (gaps.length ? 'insufficient-evidence' : 'clear')
    return { finished, usage, parts, evidence, gaps, charged, pendingReview, outOfScope, warnings, decision }
  }

  // 缺口定位：按扫描代、母卷、区块说明缺的是什么
  gapReason(mother, rest) {
    const tiles = (this.snapshot.tilesByMother.get(mother) ?? []).filter(tile => geo.intersects(tile.box, rest))
    if (tiles.length) {
      const stale = tiles.find(tile => tile.status === 'stale')
      if (stale) return { reason: 'credential-stale', tile: stale.tile, generation: stale.generation }
      const first = tiles[0]
      return { reason: 'credential-invalid', tile: first.tile, generation: first.generation, status: first.status }
    }
    const windows = this.snapshot.windowsByMother.get(mother)
    const incomplete = windows?.incomplete.find(win => win.y0 < rest.y1 && rest.y0 < win.y1)
    if (incomplete) return { reason: 'window-incomplete', window: incomplete.window }
    return { reason: 'no-credential' }
  }
}

function buildSnapshot({ edition, cuts, scan, holes, issued, tiles, labels }) {
  const segments = layout.parseCuts(cuts)
  const segmentsByFinished = layout.groupByFinished(segments)
  const windows = parseScan(scan)
  const windowsByMother = new Map()
  for (const win of windows) {
    if (!windowsByMother.has(win.mother)) windowsByMother.set(win.mother, { done: [], incomplete: [] })
    const group = windowsByMother.get(win.mother)
    if (win.done) group.done.push([win.y0, win.y1])
    else group.incomplete.push(win)
  }
  const holeList = parseHoles(holes)
  const holesByFinished = new Map()
  for (const hole of holeList) {
    for (const [finished, segs] of segmentsByFinished) {
      for (const hit of layout.holeToFinished(segs, hole)) {
        if (!holesByFinished.has(finished)) holesByFinished.set(finished, [])
        holesByFinished.get(finished).push({ hole, rect: hit.rect, motherRect: hit.motherRect })
      }
    }
  }
  const tilesByMother = new Map()
  for (const tile of tiles) {
    if (!tilesByMother.has(tile.mother)) tilesByMother.set(tile.mother, [])
    tilesByMother.get(tile.mother).push(tile)
  }
  // 有效覆盖 = 完整且哈希匹配的区块范围（零缺陷的完整块同样提供覆盖）
  const coverageByMother = new Map()
  for (const tile of tiles) {
    if (tile.status !== 'valid') continue
    if (!coverageByMother.has(tile.mother)) coverageByMother.set(tile.mother, [])
    coverageByMother.get(tile.mother).push(tile.box)
  }
  // 业务确认与凭据记录互查
  const discrepancies = []
  for (const hole of holeList) {
    if (!hole.confirmed) continue
    const recorded = tiles.some(tile => tile.status === 'valid' && tile.mother === hole.mother &&
      tile.records.some(rec => rec.confirmed && rec.y0 === hole.y0 && rec.y1 === hole.y1 && rec.x0 === hole.x0 && rec.x1 === hole.x1))
    if (!recorded) discrepancies.push({ type: 'hole-without-credential', mother: hole.mother, hole: hole.id })
  }
  for (const tile of tiles) {
    if (tile.status !== 'valid') continue
    for (const rec of tile.records) {
      if (!rec.confirmed) continue
      const known = holeList.some(hole => hole.confirmed && hole.mother === tile.mother &&
        hole.y0 === rec.y0 && hole.y1 === rec.y1 && hole.x0 === rec.x0 && hole.x1 === rec.x1)
      if (!known) discrepancies.push({ type: 'credential-without-hole', mother: tile.mother, tile: tile.tile, record: rec })
    }
  }
  const issuedList = parseIssued(issued)
  return {
    edition,
    segmentsByFinished,
    windowsByMother,
    holes: holeList,
    holesByFinished,
    issued: issuedList,
    issuedByOrder: new Map(issuedList.map(row => [row.order, row])),
    tiles,
    tilesByMother,
    coverageByMother,
    labels,
    labelByOrder: new Map(labels.map(row => [row.order, row])),
    discrepancies
  }
}

function diffSnapshots(previous, next) {
  if (!previous) return { initial: true }
  const changes = {}
  if (previous.edition !== next.edition) changes.edition = { from: previous.edition, to: next.edition }
  const prevHoles = new Map(previous.holes.map(hole => [hole.id, hole]))
  const confirmed = []
  const cleared = []
  const added = []
  for (const hole of next.holes) {
    const before = prevHoles.get(hole.id)
    if (!before) {
      added.push(hole.id)
      if (hole.confirmed) confirmed.push(hole.id)
    } else if (!before.confirmed && hole.confirmed) confirmed.push(hole.id)
    else if (before.confirmed && !hole.confirmed) cleared.push(hole.id)
  }
  if (confirmed.length) changes.holesConfirmed = confirmed
  if (cleared.length) changes.holesCleared = cleared
  if (added.length) changes.holesAdded = added
  const prevTiles = new Map(previous.tiles.map(tile => [tile.mother + '|' + tile.tile, tile]))
  const generations = []
  const tileStatus = []
  for (const tile of next.tiles) {
    const before = prevTiles.get(tile.mother + '|' + tile.tile)
    if (before && before.generation !== tile.generation) {
      generations.push({ mother: tile.mother, tile: tile.tile, from: before.generation, to: tile.generation })
    }
    if (!before || before.status !== tile.status || before.generation !== tile.generation) {
      tileStatus.push({ mother: tile.mother, tile: tile.tile, generation: tile.generation, from: before?.status ?? null, to: tile.status })
    }
  }
  if (generations.length) changes.generations = generations
  if (tileStatus.length) changes.tileStatus = tileStatus
  const coverageGained = []
  const coverageLost = []
  const mothers = new Set([...previous.coverageByMother.keys(), ...next.coverageByMother.keys()])
  for (const mother of mothers) {
    const before = previous.coverageByMother.get(mother) ?? []
    const after = next.coverageByMother.get(mother) ?? []
    for (const rect of before.flatMap(r => geo.subtractAll(r, after))) coverageLost.push({ mother, rect })
    for (const rect of after.flatMap(r => geo.subtractAll(r, before))) coverageGained.push({ mother, rect })
  }
  if (coverageGained.length) changes.coverageGained = coverageGained
  if (coverageLost.length) changes.coverageLost = coverageLost
  const prevLabels = new Map(previous.labels.map(row => [row.label, row]))
  const labelChanges = []
  for (const label of next.labels) {
    const before = prevLabels.get(label.label)
    if (before && before.state !== label.state) labelChanges.push({ label: label.label, order: label.order, from: before.state, to: label.state })
  }
  if (labelChanges.length) changes.labels = labelChanges
  return changes
}

function summarize(snapshot) {
  const tileStatus = {}
  for (const tile of snapshot.tiles) tileStatus[tile.status] = (tileStatus[tile.status] || 0) + 1
  return {
    edition: snapshot.edition,
    rolls: [...snapshot.segmentsByFinished.keys()],
    orders: snapshot.issued.length,
    tiles: tileStatus,
    discrepancies: snapshot.discrepancies.length
  }
}
