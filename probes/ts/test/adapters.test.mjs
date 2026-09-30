// adapters.ts：把不合标准的上游响应归一成 Check[]。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adapt, worst } from '../dist/index.js'

// ---- 无 adapter：服务已按本标准实现 ----

test('标准响应：原样取 checks', () => {
  const checks = [{ name: 'rpc', status: 'up', latencyMs: 3 }, { name: 'indexer', status: 'degraded' }]
  assert.deepEqual(adapt(undefined, { status: 'degraded', checks }, 99), checks)
})

test('标准响应：checks 为空但有 status → 归一成一项 http，沿用 status 与探测耗时', () => {
  assert.deepEqual(adapt(undefined, { status: 'degraded', checks: [] }, 17), [{ name: 'http', status: 'degraded', latencyMs: 17 }])
  assert.deepEqual(adapt(undefined, { status: 'up' }, 5), [{ name: 'http', status: 'up', latencyMs: 5 }])
})

test('标准响应：既无 checks 也无 status → down', () => {
  for (const body of [{}, null, undefined, 'ok', 42, { checks: 'x' }]) {
    const out = adapt(undefined, body, 8)
    assert.equal(out.length, 1, JSON.stringify(body))
    assert.equal(out[0].status, 'down', JSON.stringify(body))
    assert.equal(out[0].latencyMs, 8)
    assert.match(out[0].detail, /不符合健康契约/)
  }
})

test('标准响应：上游 status 取值非法时判 down，不能被 worst() 当成 up（#2）', () => {
  for (const status of ['ok', 'OK', 'healthy', 'error', 1, true, {}]) {
    const out = adapt(undefined, { status }, 1)
    assert.equal(worst(out.map((c) => c.status)), 'down', JSON.stringify(status))
    assert.match(out[0].detail, /不符合健康契约/)
  }
})

test('标准响应：checks 里某项取值非法 → 该项 down，保留 name，不回显原始取值', () => {
  const out = adapt(undefined, { status: 'up', checks: [{ name: 'rpc', status: 'up' }, { name: 'db', status: 'error' }] }, 1)
  assert.deepEqual(out[0], { name: 'rpc', status: 'up' })
  assert.equal(out[1].name, 'db')
  assert.equal(out[1].status, 'down')
  assert.doesNotMatch(out[1].detail, /error/)
  assert.equal(worst(out.map((c) => c.status)), 'down')
})

test('标准响应：checks 元素不是对象 → 按序号命名并判 down；缺 name 只补名字', () => {
  const out = adapt(undefined, { checks: [null, 'up', { status: 'up' }] }, 1)
  assert.deepEqual(out.map((c) => [c.name, c.status]), [['check[0]', 'down'], ['check[1]', 'down'], ['check[2]', 'up']])
})

test('标准响应：整体 status 比 checks 更差 → 补一项 http，取两者最差', () => {
  const out = adapt(undefined, { status: 'down', checks: [{ name: 'rpc', status: 'up' }] }, 7)
  assert.deepEqual(out.at(-1), { name: 'http', status: 'down', latencyMs: 7, detail: '服务整体状态比各项 check 更差' })
  assert.equal(worst(out.map((c) => c.status)), 'down')
})

test('标准响应：checks 合法但整体 status 非法 → 补一项 down', () => {
  const out = adapt(undefined, { status: 'ok', checks: [{ name: 'rpc', status: 'up' }] }, 1)
  assert.equal(worst(out.map((c) => c.status)), 'down')
})

test('worst()：三态以外的取值按 down', () => {
  assert.equal(worst(['up', 'ok']), 'down')
  assert.equal(worst(['up', undefined]), 'down')
  assert.equal(worst(['up', 'degraded']), 'degraded')
})

// ---- safe-cgw：{"status":"OK"} ----

test('safe-cgw：status 为 OK → up，无 detail', () => {
  assert.deepEqual(adapt('safe-cgw', { status: 'OK' }, 12), [{ name: 'http', status: 'up', latencyMs: 12, detail: undefined }])
})

test('safe-cgw：其余任何响应 → down', () => {
  for (const body of [{ status: 'ok' }, { status: 'KO' }, {}, null, 'OK', { status: true }]) {
    const [c] = adapt('safe-cgw', body, 1)
    assert.equal(c.status, 'down', JSON.stringify(body))
    assert.match(c.detail, /未返回 OK/)
  }
})

// ---- blockscout-stats：拿得到统计即活着 ----

test('blockscout-stats：有 total_blocks 或 gas_prices → up', () => {
  assert.equal(adapt('blockscout-stats', { total_blocks: '123' }, 1)[0].status, 'up')
  assert.equal(adapt('blockscout-stats', { total_blocks: '0' }, 1)[0].status, 'up')
  assert.equal(adapt('blockscout-stats', { gas_prices: null }, 1)[0].status, 'up')
  assert.equal(adapt('blockscout-stats', { gas_prices: { average: 0.01 } }, 1)[0].detail, undefined)
})

test('blockscout-stats：两项都没有 → down', () => {
  for (const body of [{}, null, { message: 'Internal server error' }, []]) {
    const [c] = adapt('blockscout-stats', body, 4)
    assert.equal(c.status, 'down', JSON.stringify(body))
    assert.equal(c.latencyMs, 4)
    assert.match(c.detail, /内容异常/)
  }
})

// ---- 未知 adapter ----

test('未知 adapter → down，并在 detail 里写出名字', () => {
  const [c] = adapt('legacy-healthz', { status: 'OK' }, 2)
  assert.equal(c.status, 'down')
  assert.match(c.detail, /未知的 adapter：legacy-healthz/)
})

test('所有 adapter 都只产出一项名为 http 的 check', () => {
  for (const name of ['safe-cgw', 'blockscout-stats', 'nope']) {
    const out = adapt(name, {}, 0)
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'http')
  }
})
