// 领料核查服务：给质检与装车台两边系统对接的 HTTP 接口。
// 默认监听 127.0.0.1:8710，可用 PORT / SOURCE_ROOT / PROVIDER_ROOT 调整。

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { Capability } from './core.mjs'

export function createService(options = {}) {
  const capability = new Capability(options)

  const server = createServer(async (request, response) => {
    const send = (code, data) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(data))
    }
    try {
      const url = new URL(request.url, 'http://localhost')
      const body = async () => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      }

      if (url.pathname === '/health' && request.method === 'GET') {
        return send(200, { ok: true, edition: capability.snapshot?.edition ?? null })
      }
      if (url.pathname === '/refresh' && request.method === 'POST') {
        return send(200, await capability.refresh())
      }
      if (url.pathname === '/requisitions' && request.method === 'GET') {
        return send(200, await capability.plan())
      }
      if (url.pathname === '/requisitions/check' && request.method === 'POST') {
        const payload = await body()
        const { finished, y, u } = payload
        if (!finished || !Array.isArray(y) || !Array.isArray(u)) {
          return send(422, { error: '需要 finished、y:[起,止]、u:[左,右]' })
        }
        return send(200, await capability.assessRange(finished, { y0: y[0], y1: y[1], u0: u[0], u1: u[1] }))
      }
      const requisition = /^\/requisitions\/([^/]+)$/.exec(url.pathname)
      if (requisition && request.method === 'GET') {
        const result = await capability.assessOrder(decodeURIComponent(requisition[1]))
        return result ? send(200, result) : send(404, { error: '没有该领料单' })
      }
      if (url.pathname === '/reconcile' && request.method === 'POST') {
        return send(200, await capability.reconcile(await body()))
      }
      if (url.pathname === '/dock' && request.method === 'GET') {
        return send(200, await capability.dockReport())
      }
      const roll = /^\/supervisor\/rolls\/([^/]+)$/.exec(url.pathname)
      if (roll && request.method === 'GET') {
        const result = await capability.supervisor(decodeURIComponent(roll[1]))
        return result ? send(200, result) : send(404, { error: '没有该成品卷' })
      }
      return send(404, { error: '没有该资料或操作' })
    } catch (error) {
      if (error.code === 'no-such-roll') return send(404, { error: error.message })
      return send(500, { error: error.message })
    }
  })
  server.capability = capability
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createService({
    sourceRoot: process.env.SOURCE_ROOT || 'http://127.0.0.1:8700',
    providerRoot: process.env.PROVIDER_ROOT || 'http://127.0.0.1:8701'
  })
  server.listen(Number(process.env.PORT || 8710), '127.0.0.1', () => {
    console.log('领料核查能力已启动')
  })
}
