import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

test('重扫沿用块名，车位打印中不会立即接纳隔离', async t => {
  const root = await listen(t)
  const raw = async () => Buffer.from(await (await fetch(root + '/scanline/raw?id=X1')).arrayBuffer())
  const first = await raw()
  assert.equal(first.subarray(0, 4).toString(), 'PPR1')
  await post(root, '/lab?stage=rescan')
  const [tile] = await (await fetch(root + '/scanline/index')).json()
  assert.equal(tile.generation, 'g2')
  assert.deepEqual(await raw(), first)
  assert.equal((await post(root, '/loads/hold', { label: 'D1', range: [2, 3, 1, 4] })).status, 202)
  await post(root, '/lab?stage=known')
  assert.notDeepEqual(await raw(), first)
  assert.equal((await (await fetch(root + '/loads/labels')).json())[2].state, 'held')
})
