// 半开区间矩形运算。所有坐标均为左闭右开 [y0, y1) x [x0, x1)，
// 与来源资料「各段为左闭右开」「两个维度均有正长度相交」的约定一致。

export const rect = (y0, y1, x0, x1) => ({ y0, y1, x0, x1 })

export const intersects = (a, b) => a.y0 < b.y1 && b.y0 < a.y1 && a.x0 < b.x1 && b.x0 < a.x1

export function intersection(a, b) {
  if (!intersects(a, b)) return null
  return rect(Math.max(a.y0, b.y0), Math.min(a.y1, b.y1), Math.max(a.x0, b.x0), Math.min(a.x1, b.x1))
}

// a 减去 b 后剩余的矩形集合（0~4 块）
export function subtract(a, b) {
  const hit = intersection(a, b)
  if (!hit) return [a]
  const out = []
  if (a.y0 < hit.y0) out.push(rect(a.y0, hit.y0, a.x0, a.x1))
  if (hit.y1 < a.y1) out.push(rect(hit.y1, a.y1, a.x0, a.x1))
  if (a.x0 < hit.x0) out.push(rect(hit.y0, hit.y1, a.x0, hit.x0))
  if (hit.x1 < a.x1) out.push(rect(hit.y0, hit.y1, hit.x1, a.x1))
  return out
}

// a 依次减去一组矩形后的剩余部分
export function subtractAll(a, list) {
  let rest = [a]
  for (const b of list) rest = rest.flatMap(piece => subtract(piece, b))
  return rest
}

export const area = r => (r.y1 - r.y0) * (r.x1 - r.x0)

// 一组矩形的包围盒
export function bounding(list) {
  return rect(
    Math.min(...list.map(r => r.y0)), Math.max(...list.map(r => r.y1)),
    Math.min(...list.map(r => r.x0)), Math.max(...list.map(r => r.x1))
  )
}
