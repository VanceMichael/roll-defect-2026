// 两侧资料通道：
// - SourceClient：业务来源的分页数据流（ETag 条件请求、资料版识别、继续标记逐页领取）
// - ProviderClient：现场外部接口（区块索引、凭据原件、装车台标签与隔离回执）

export class SourceClient {
  constructor(root, fetchImpl = fetch) {
    this.root = root
    this.fetch = fetchImpl
    this.cache = new Map() // 请求路径 → { etag, rows }
  }

  async catalog() {
    const response = await this.fetch(this.root + '/catalog')
    if (!response.ok) throw new Error(`来源目录读取失败: ${response.status}`)
    return response.json()
  }

  // 整流领取：跟随 Link rel="next" 逐页取完；带 ETag 重验，304 时复用已领记录。
  // 不用 from/until 按时间列截断：跨范围记录只看起列会漏，键列筛选后由调用方按起止字段判定相交。
  async stream(name, { key } = {}) {
    const query = key === undefined ? '' : '?key=' + encodeURIComponent(key)
    const path = `/records/${name}${query}`
    const cached = this.cache.get(path)
    const headers = cached ? { 'If-None-Match': cached.etag } : {}
    let response = await this.fetch(this.root + path, { headers })
    if (response.status === 304 && cached) {
      return { rows: cached.rows, edition: response.headers.get('X-Edition'), cached: true }
    }
    if (!response.ok) throw new Error(`来源数据流 ${name} 读取失败: ${response.status}`)
    const etag = response.headers.get('ETag')
    const edition = response.headers.get('X-Edition')
    const rows = []
    for (;;) {
      const text = await response.text()
      rows.push(...text.split('\n').filter(Boolean).map(line => line.split('\t')))
      const link = response.headers.get('Link')
      const next = link && /^<([^>]+)>;\s*rel="next"/.exec(link)
      if (!next) break
      response = await this.fetch(this.root + next[1])
      if (!response.ok) throw new Error(`来源数据流 ${name} 续页读取失败: ${response.status}`)
    }
    if (etag) this.cache.set(path, { etag, rows })
    return { rows, edition, cached: false }
  }
}

export class ProviderClient {
  constructor(root, fetchImpl = fetch) {
    this.root = root
    this.fetch = fetchImpl
  }

  async scanIndex() {
    const response = await this.fetch(this.root + '/scanline/index')
    if (!response.ok) throw new Error(`扫描区块索引读取失败: ${response.status}`)
    return response.json()
  }

  async raw(path) {
    const response = await this.fetch(this.root + path)
    if (!response.ok) {
      const error = new Error(`区块凭据取件失败: ${response.status}`)
      error.status = response.status
      throw error
    }
    return Buffer.from(await response.arrayBuffer())
  }

  async labels() {
    const response = await this.fetch(this.root + '/loads/labels')
    if (!response.ok) throw new Error(`装车台标签读取失败: ${response.status}`)
    return response.json()
  }

  // 提交隔离：202 仅表示装车台接收，是否生效要以 /loads/labels 的回读为准
  async hold(payload) {
    const response = await this.fetch(this.root + '/loads/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    let body = null
    try { body = await response.json() } catch { /* 空回执 */ }
    return { status: response.status, body }
  }
}
