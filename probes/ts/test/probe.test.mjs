// probe.ts：static / service 两类探测与结果归一。只访问 127.0.0.1 上的本机服务器。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { probe, validate, USER_AGENT } from '../dist/index.js'
import { goodHealth, serve, json, html } from './helpers.mjs'

const PAGE = '<html><body><h1>DaVinci Swap</h1><p>ready</p></body></html>'
let lastUA = ''

const srv = await serve({
  '/page': (req, res) => {
    lastUA = req.headers['user-agent']
    html(PAGE)(req, res)
  },
  '/shell': html('<html><body><div id="root"></div></body></html>'),
  '/error-page': html('<html><body>DaVinci Swap — Cloudflare Error 522</body></html>'),
  '/gone': html('gone', 404),
  '/redirect': (req, res) => res.writeHead(302, { location: '/page' }).end(),
  '/big': html('x'.repeat(64 * 1024) + 'DaVinci Swap'),
  '/health': json(goodHealth()),
  '/health-down': json({ ...goodHealth(), status: 'down', checks: [{ name: 'rpc', status: 'down' }, { name: 'db', status: 'up' }] }),
  '/health-500': json(goodHealth(), 500),
  '/health-html': html(PAGE),
  '/health-huge': json(JSON.stringify(goodHealth()).replace('"rpc"', `"rpc","pad":"${'x'.repeat(300 * 1024)}"`)),
  '/cgw': json({ status: 'OK' }),
  '/stats': json({ total_blocks: '42' }),
})
after(() => srv.close())

const fixedNow = () => new Date('2026-09-30T00:00:00.000Z')
const staticEntry = (path, expect) => ({ id: 'swap-web', name: 'DEX', type: 'static', tier: 2, url: srv.url(path), expect })
const serviceEntry = (path, adapter) => ({ id: 'market', name: '行情', type: 'service', tier: 2, url: srv.url(path), adapter })

// ---- 结果形状 ----

test('probe：结果是符合契约的 Health，service / observedAt 取自入参', async () => {
  const h = await probe(staticEntry('/page', { bodyContains: 'DaVinci Swap' }), fixedNow)
  assert.equal(h.schemaVersion, '1.0')
  assert.equal(h.service, 'swap-web')
  assert.equal(h.observedAt, '2026-09-30T00:00:00.000Z')
  assert.deepEqual(validate(h), [])
})

test('probe：失败结果同样符合契约', async () => {
  const h = await probe(staticEntry('/gone', { bodyContains: 'DaVinci Swap' }), fixedNow)
  assert.equal(h.status, 'down')
  assert.deepEqual(validate(h), [])
})

test('probe：带上标准 User-Agent', async () => {
  await probe(staticEntry('/page'))
  assert.equal(lastUA, USER_AGENT)
})

// ---- static ----

test('static：200 且含预期文本 → up', async () => {
  const h = await probe(staticEntry('/page', { status: 200, bodyContains: 'DaVinci Swap' }))
  assert.equal(h.status, 'up')
  assert.equal(h.checks.length, 1)
  assert.equal(h.checks[0].name, 'http')
  assert.ok(h.checks[0].latencyMs >= 0)
})

test('static：200 但只有空壳（缺预期文本）→ down，不能假绿', async () => {
  const h = await probe(staticEntry('/shell', { bodyContains: 'DaVinci Swap' }))
  assert.equal(h.status, 'down')
  assert.match(h.checks[0].detail, /空壳/)
})

test('static：出现错误页特征 → down', async () => {
  const h = await probe(staticEntry('/error-page', { bodyContains: 'DaVinci Swap', bodyNotContains: 'Cloudflare Error' }))
  assert.equal(h.status, 'down')
  assert.match(h.checks[0].detail, /错误页特征/)
})

test('static：状态码与期望不符 → down，detail 写出实际与期望', async () => {
  const h = await probe(staticEntry('/gone', { bodyContains: 'gone' }))
  assert.equal(h.status, 'down')
  assert.equal(h.checks[0].detail, 'HTTP 404，期望 200')
})

test('static：可声明非 200 的期望状态码', async () => {
  const h = await probe(staticEntry('/gone', { status: 404, bodyContains: 'gone' }))
  assert.equal(h.status, 'up')
})

test('static：未配 expect 时只要求 200', async () => {
  assert.equal((await probe(staticEntry('/page'))).status, 'up')
  assert.equal((await probe(staticEntry('/gone'))).status, 'down')
})

test('static：跟随重定向', async () => {
  const h = await probe(staticEntry('/redirect', { bodyContains: 'DaVinci Swap' }))
  assert.equal(h.status, 'up')
})

test('static：只读 maxBytes 以内的响应体，预期文本在上限之外 → down', async () => {
  const capped = await probe(staticEntry('/big', { bodyContains: 'DaVinci Swap', maxBytes: 1024 }))
  assert.equal(capped.status, 'down')
  const full = await probe(staticEntry('/big', { bodyContains: 'DaVinci Swap', maxBytes: 1024 * 1024 }))
  assert.equal(full.status, 'up')
})

test('static：连不上 → down', async () => {
  const dead = await serve({})
  const url = dead.url('/')
  await dead.close()
  const h = await probe({ id: 'x', name: 'x', type: 'static', tier: 2, url })
  assert.equal(h.status, 'down')
  assert.ok(h.checks[0].detail.length > 0)
})

// ---- service ----

test('service：直读标准 /health，checks 原样保留，整体取最差项', async () => {
  const h = await probe(serviceEntry('/health'))
  assert.equal(h.status, 'degraded')
  assert.deepEqual(h.checks, goodHealth().checks)
})

test('service：任一 check down → 整体 down', async () => {
  const h = await probe(serviceEntry('/health-down'))
  assert.equal(h.status, 'down')
  assert.equal(h.checks.length, 2)
})

test('service：非 2xx → down', async () => {
  const h = await probe(serviceEntry('/health-500'))
  assert.equal(h.status, 'down')
  assert.equal(h.checks[0].detail, 'HTTP 500')
})

test('service：响应不是 JSON → down', async () => {
  const h = await probe(serviceEntry('/health-html'))
  assert.equal(h.status, 'down')
  assert.match(h.checks[0].detail, /不是合法 JSON/)
})

test('service：响应体超过 256 KiB 被截断 → 视为非法 JSON → down', async () => {
  const h = await probe(serviceEntry('/health-huge'))
  assert.equal(h.status, 'down')
  assert.match(h.checks[0].detail, /不是合法 JSON/)
})

test('service：按 adapter 归一上游响应', async () => {
  assert.equal((await probe(serviceEntry('/cgw', 'safe-cgw'))).status, 'up')
  assert.equal((await probe(serviceEntry('/stats', 'blockscout-stats'))).status, 'up')
  assert.equal((await probe(serviceEntry('/stats', 'safe-cgw'))).status, 'down')
  assert.equal((await probe(serviceEntry('/cgw', 'no-such-adapter'))).status, 'down')
})

// ---- 超时与错误信息（替换全局 fetch，不真的等 5 秒） ----

async function withFetch(fake, fn) {
  const real = globalThis.fetch
  globalThis.fetch = fake
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

test('超时 → down，detail 为「超时」；并确实传了中止信号', async () => {
  let gotSignal = false
  await withFetch(
    async (url, init) => {
      gotSignal = init?.signal instanceof AbortSignal
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    },
    async () => {
      for (const type of ['static', 'service']) {
        const h = await probe({ id: 'x', name: 'x', type, tier: 2, url: 'http://127.0.0.1:9/' })
        assert.equal(h.status, 'down', type)
        assert.equal(h.checks[0].detail, '超时', type)
      }
    },
  )
  assert.ok(gotSignal, 'fetch 必须带 AbortSignal，否则慢响应不会被中止')
})

test('错误信息截断到 120 字以内（不把长堆栈写进 detail）', async () => {
  await withFetch(
    async () => {
      throw new Error('e'.repeat(500))
    },
    async () => {
      const h = await probe({ id: 'x', name: 'x', type: 'service', tier: 2, url: 'http://127.0.0.1:9/' })
      assert.equal(h.status, 'down')
      assert.equal(h.checks[0].detail.length, 120)
      assert.deepEqual(validate(h), [])
    },
  )
})
