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

test(
  '标准响应：上游 status 取值非法时应判 down，不能被 worst() 当成 up',
  { todo: '已知缺陷：fromSpec 不校验三态取值，worst() 忽略未知取值 → 假绿，见 #2' },
  () => {
    const out = adapt(undefined, { status: 'ok' }, 1)
    assert.equal(worst(out.map((c) => c.status)), 'down')
  },
)

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
