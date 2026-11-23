// 成品卷谱系：cuts 流把成品卷的纵段映射到母卷的纵、横区间。
// 方向 + 表示同向卷起，- 表示反向（翻向）上卷；横向一律以「成品横向零 = 该段横向裁切起点」换算，
// 即成品本地横坐标 u 对应母卷横坐标 mX0 + u，不随方向翻转。

import { rect } from './geometry.mjs'

export function parseCuts(rows) {
  return rows.map(([finished, f0, f1, mother, my0, my1, mx0, mx1, dir]) => ({
    finished, f0: Number(f0), f1: Number(f1), mother,
    my0: Number(my0), my1: Number(my1), mx0: Number(mx0), mx1: Number(mx1), dir
  }))
}

export function groupByFinished(segments) {
  const map = new Map()
  for (const seg of segments) {
    if (!map.has(seg.finished)) map.set(seg.finished, [])
    map.get(seg.finished).push(seg)
  }
  for (const list of map.values()) list.sort((a, b) => a.f0 - b.f0)
  return map
}

// 成品纵区间 [a, b) → 母卷纵区间（半开）
export function finishedToMotherY(seg, a, b) {
  return seg.dir === '-'
    ? [seg.my0 + (seg.f1 - b), seg.my0 + (seg.f1 - a)]
    : [seg.my0 + (a - seg.f0), seg.my0 + (b - seg.f0)]
}

// 母卷纵区间 [a, b) → 成品纵区间（半开）
export function motherToFinishedY(seg, a, b) {
  return seg.dir === '-'
    ? [seg.f0 + (seg.my1 - b), seg.f0 + (seg.my1 - a)]
    : [seg.f0 + (a - seg.my0), seg.f0 + (b - seg.my0)]
}

// 母卷上的矩形 → 成品本地矩形（同一纵段内）
export function motherRectToFinished(seg, mRect) {
  const [fy0, fy1] = motherToFinishedY(seg, mRect.y0, mRect.y1)
  return rect(fy0, fy1, mRect.x0 - seg.mx0, mRect.x1 - seg.mx0)
}

// 领用的双轴范围 {y0, y1, u0, u1}（成品本地坐标）→ 各纵段对应的母卷矩形。
// 同一横线在不同纵段会落到不同母卷（拼接），反向段纵向翻转。
export function usageToMother(segments, usage) {
  const parts = []
  const warnings = []
  for (const seg of segments) {
    const y0 = Math.max(seg.f0, usage.y0)
    const y1 = Math.min(seg.f1, usage.y1)
    if (y0 >= y1) continue
    const width = seg.mx1 - seg.mx0
    const cutViolation = usage.u0 < 0 || usage.u1 > width
    if (cutViolation) {
      warnings.push(`用幅横向 ${usage.u0}-${usage.u1} 超出 ${seg.finished} 纵段 ${seg.f0}-${seg.f1} 的裁切宽度 0-${width}`)
    }
    const u0 = Math.max(0, usage.u0)
    const u1 = Math.min(width, usage.u1)
    if (u0 >= u1) continue
    const [my0, my1] = finishedToMotherY(seg, y0, y1)
    parts.push({
      segment: seg,
      rect: rect(my0, my1, seg.mx0 + u0, seg.mx0 + u1),
      part: rect(y0, y1, u0, u1)
    })
  }
  if (segments.length && parts.length === 0 && !warnings.length) {
    warnings.push(`用幅纵向 ${usage.y0}-${usage.y1} 不在 ${segments[0].finished} 的任何纵段内`)
  }
  return { parts, warnings }
}

// 母卷上的孔洞 → 落到某成品卷的本地矩形（可能多处：一支母卷可进多支成品卷）
export function holeToFinished(segments, hole) {
  const hits = []
  for (const seg of segments) {
    if (seg.mother !== hole.mother) continue
    const y0 = Math.max(seg.my0, hole.y0)
    const y1 = Math.min(seg.my1, hole.y1)
    if (y0 >= y1) continue
    const width = seg.mx1 - seg.mx0
    const u0 = Math.max(0, hole.x0 - seg.mx0)
    const u1 = Math.min(width, hole.x1 - seg.mx0)
    if (u0 >= u1) continue
    const [fy0, fy1] = motherToFinishedY(seg, y0, y1)
    hits.push({
      segment: seg,
      rect: rect(fy0, fy1, u0, u1),
      motherRect: rect(y0, y1, Math.max(seg.mx0, hole.x0), Math.min(seg.mx1, hole.x1))
    })
  }
  return hits
}
