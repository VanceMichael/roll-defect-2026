// 扫描区块凭据：PPR1 原件解析 + 按（母卷、区块、扫描代）管理的凭据库。
// 设备返工重扫沿用同一个条带（区块）名称，只有扫描代不同；
// 只有完整且哈希匹配的区块才能覆盖其索引给出的范围，旧读数不得充当新标定。

import { createHash } from 'node:crypto'

export const MAGIC = 'PPR1'
export const RECORD_BYTES = 9

// PPR1 开头后每条 9 字节：4 个小端 16 位整数（纵起、纵止、横起、横止）+ 尾字节（1 已确认 / 0 尚未复判）
export function parseTile(buf) {
  if (buf.length < MAGIC.length || buf.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) {
    const error = new Error('区块凭据头不是 PPR1')
    error.code = 'bad-magic'
    throw error
  }
  if ((buf.length - MAGIC.length) % RECORD_BYTES !== 0) {
    const error = new Error('区块凭据长度不完整')
    error.code = 'incomplete'
    throw error
  }
  const records = []
  for (let offset = MAGIC.length; offset < buf.length; offset += RECORD_BYTES) {
    const y0 = buf.readUInt16LE(offset)
    const y1 = buf.readUInt16LE(offset + 2)
    const x0 = buf.readUInt16LE(offset + 4)
    const x1 = buf.readUInt16LE(offset + 6)
    const flag = buf[offset + 8]
    if (y1 <= y0 || x1 <= x0) {
      const error = new Error('区块凭据记录坐标无效')
      error.code = 'bad-record'
      throw error
    }
    records.push({ y0, y1, x0, x1, confirmed: flag === 1 })
  }
  return records
}

export const sha256 = buf => createHash('sha256').update(buf).digest('hex')

export class TileStore {
  constructor() {
    // 历史广告哈希：母卷|区块 → Map(扫描代 → sha256)，跨刷新保留，用于识别旧读数
    this.history = new Map()
    // 当前一代的凭据：母卷|区块|扫描代 → 凭据信息
    this.current = new Map()
  }

  remember(mother, tile, generation, hash) {
    const key = mother + '|' + tile
    if (!this.history.has(key)) this.history.set(key, new Map())
    this.history.get(key).set(generation, hash)
  }

  knownElsewhere(mother, tile, hash, exceptGeneration) {
    const generations = this.history.get(mother + '|' + tile)
    if (!generations) return false
    for (const [generation, known] of generations) {
      if (generation !== exceptGeneration && known === hash) return true
    }
    return false
  }

  // 按当前索引逐块取件并校验。fetchRaw(path) 返回 Buffer，失败时抛错。
  async observe(entries, fetchRaw) {
    const seen = new Map()
    for (const entry of entries) {
      const [y0, y1, x0, x1] = entry.box
      const info = {
        mother: entry.mother, tile: entry.tile, generation: entry.generation,
        box: { y0, y1, x0, x1 }, sha256: entry.sha256,
        status: 'missing', records: [], rawHash: null, error: null
      }
      let raw = null
      try {
        raw = await fetchRaw(entry.path)
      } catch {
        raw = null
      }
      if (raw) {
        info.rawHash = sha256(raw)
        try {
          info.records = parseTile(raw)
          if (info.rawHash === entry.sha256) {
            info.status = 'valid'
          } else if (this.knownElsewhere(entry.mother, entry.tile, info.rawHash, entry.generation)) {
            // 取回的仍是上一代的读数：标定已更新，旧件不能充当新凭据
            info.status = 'stale'
          } else {
            info.status = 'hash-mismatch'
          }
        } catch (error) {
          info.status = 'invalid-format'
          info.error = error.code || error.message
        }
      }
      this.remember(entry.mother, entry.tile, entry.generation, entry.sha256)
      seen.set(entry.mother + '|' + entry.tile + '|' + entry.generation, info)
    }
    this.current = seen
    return [...seen.values()]
  }

  validTiles() {
    return [...this.current.values()].filter(info => info.status === 'valid')
  }
}
