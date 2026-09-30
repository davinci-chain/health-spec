// 契约校验器 validate() 与 CLI（dist/verify.js）的退出码，对应 SPEC.md 第 2 节。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validate } from '../dist/index.js'
import { goodHealth, serve, json } from './helpers.mjs'

const has = (errs, fragment) => errs.some((e) => e.includes(fragment))

test('validate：合规样例零错误', () => {
  assert.deepEqual(validate(goodHealth()), [])
})

test('validate：如实报告 down 的服务同样合规', () => {
  const body = goodHealth({ status: 'down', checks: [{ name: 'rpc', status: 'down', detail: '连不上链' }] })
  assert.deepEqual(validate(body), [])
})

test('validate：checks 为空数组合规（只证明进程活着）', () => {
  assert.deepEqual(validate(goodHealth({ status: 'up', checks: [] })), [])
})

test('validate：整体 status 必须等于最差一项', () => {
  const up = validate(goodHealth({ status: 'up' }))
  assert.ok(has(up, 'status 应为 degraded'), up.join('\n'))

  const down = validate(goodHealth({ status: 'down' }))
  assert.ok(has(down, 'status 应为 degraded'), down.join('\n'))

  const hidden = validate(goodHealth({
    status: 'degraded',
    checks: [{ name: 'rpc', status: 'down' }, { name: 'database', status: 'degraded' }],
  }))
  assert.ok(has(hidden, 'status 应为 down'), hidden.join('\n'))
})

test('validate：全 up 时 status 必须是 up', () => {
  const errs = validate(goodHealth({ status: 'degraded', checks: [{ name: 'rpc', status: 'up' }] }))
  assert.ok(has(errs, 'status 应为 up'))
})

test('validate：schemaVersion 必须是 1.x', () => {
  assert.ok(has(validate(goodHealth({ schemaVersion: '2.0' })), 'schemaVersion'))
  assert.ok(has(validate(goodHealth({ schemaVersion: '1' })), 'schemaVersion'))
  assert.ok(has(validate(goodHealth({ schemaVersion: 1.0 })), 'schemaVersion'))
  assert.deepEqual(validate(goodHealth({ schemaVersion: '1.12' })), [])
})

test('validate：service 必须是小写短横线 id', () => {
  for (const bad of ['Market', 'market_api', '-market', 'market-', '', 'a'.repeat(41)]) {
    assert.ok(has(validate(goodHealth({ service: bad })), 'service'), bad)
  }
  for (const ok of ['m', 'market', 'safe-cgw', 'a'.repeat(40)]) {
    assert.deepEqual(validate(goodHealth({ service: ok })), [], ok)
  }
})

test('validate：status 只能是三态之一', () => {
  for (const bad of ['ok', 'UP', 'unknown', undefined, null]) {
    assert.ok(has(validate(goodHealth({ status: bad })), 'status 必须是'), String(bad))
  }
})

test('validate：observedAt 必须是时间', () => {
  assert.ok(has(validate(goodHealth({ observedAt: 'yesterday' })), 'observedAt'))
  assert.ok(has(validate(goodHealth({ observedAt: 1726621200 })), 'observedAt'))
  assert.ok(has(validate(goodHealth({ observedAt: undefined })), 'observedAt'))
})

test('validate：checks 必须是数组且最多 32 项', () => {
  assert.ok(has(validate(goodHealth({ checks: undefined })), 'checks 必须是数组'))
  assert.ok(has(validate(goodHealth({ checks: {} })), 'checks 必须是数组'))
  const many = Array.from({ length: 33 }, (_, i) => ({ name: `c${i}`, status: 'up' }))
  assert.ok(has(validate(goodHealth({ status: 'up', checks: many })), '最多 32 项'))
  assert.deepEqual(validate(goodHealth({ status: 'up', checks: many.slice(0, 32) })), [])
})

test('validate：check 的 name 命名规则', () => {
  const withName = (name) => validate(goodHealth({ status: 'up', checks: [{ name, status: 'up' }] }))
  for (const bad of ['RPC', '1rpc', 'db_main', 'upstream:', 'upstream:Market', 'a:b:c', '']) {
    assert.ok(has(withName(bad), 'name 命名不合规'), bad)
  }
  for (const ok of ['rpc', 'upstream:market', 'db-2', 'parent-finality']) {
    assert.deepEqual(withName(ok), [], ok)
  }
})

test('validate：check 的 status 取值', () => {
  const errs = validate(goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'ok' }] }))
  assert.ok(has(errs, 'checks[0].status'))
})

test('validate：latencyMs 必须是非负数', () => {
  const withLatency = (latencyMs) => validate(goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up', latencyMs }] }))
  assert.ok(has(withLatency(-1), 'latencyMs'))
  assert.ok(has(withLatency('42'), 'latencyMs'))
  assert.ok(has(withLatency(Number.NaN), 'latencyMs'))
  assert.deepEqual(withLatency(0), [])
  assert.deepEqual(withLatency(12.5), [])
})

test('validate：detail 最长 200 字', () => {
  const withDetail = (detail) => validate(goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up', detail }] }))
  assert.deepEqual(withDetail('好'.repeat(200)), [])
  assert.ok(has(withDetail('好'.repeat(201)), '最长 200'))
  assert.ok(has(withDetail(42), '最长 200'))
})

test('validate：detail 不得含内网地址、端口或密钥', () => {
  const withDetail = (detail) => validate(goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up', detail }] }))
  for (const leak of [
    '连不上 10.1.2.3',
    '连不上 127.0.0.1',
    '连不上 192.168.0.1',
    '端口 :8545 拒绝连接',
    'password authentication failed',
    'invalid SECRET',
    'token expired',
  ]) {
    assert.ok(has(withDetail(leak), '疑似含内网地址'), leak)
  }
  for (const clean of ['落后 2 个区块', '写入延迟高于基线 3 倍', '上游超时']) {
    assert.deepEqual(withDetail(clean), [], clean)
  }
})

test('validate：响应耗时超过 5 秒上限报错，未传耗时不校验', () => {
  assert.deepEqual(validate(goodHealth(), 5000), [])
  assert.ok(has(validate(goodHealth(), 5001), '超过 5000ms'))
  assert.deepEqual(validate(goodHealth()), [])
})

test('validate：非对象输入逐项报错而不是抛异常', () => {
  for (const body of [null, undefined, 42, 'up', []]) {
    const errs = validate(body)
    assert.ok(errs.length >= 4, `${JSON.stringify(body)} → ${errs.length} 项`)
  }
})

test('validate：checks 里出现 null 元素应报错而不是抛异常', () => {
  const errs = validate(goodHealth({ status: 'up', checks: [null] }))
  assert.ok(has(errs, 'checks[0]'))
})

test('validate：detail 含 172.16.0.0/12 内网地址也应拦截', () => {
  const errs = validate(goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up', detail: '连不上 172.16.0.1' }] }))
  assert.ok(has(errs, '疑似含内网地址'))
})

// ---- CLI：退出码 0 = 合规，1 = 不合规，2 = 请求失败 ----

const CLI = fileURLToPath(new URL('../dist/verify.js', import.meta.url))
function runCli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
  })
}

const srv = await serve({
  '/good': json(goodHealth()),
  '/bad': json(goodHealth({ status: 'up' })),
  '/notjson': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>ok</html>'),
  '/status503': json(goodHealth({ status: 'down', checks: [{ name: 'rpc', status: 'down' }] }), 503),
})
after(() => srv.close())

test('CLI：合规 → 退出码 0，打印 ✓', async () => {
  const r = await runCli('verify', srv.url('/good'))
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /✓ 合规\s+market\s+status=degraded\s+3 项检查/)
})

test('CLI：不合规 → 退出码 1，列出原因', async () => {
  const r = await runCli('verify', srv.url('/bad'))
  assert.equal(r.code, 1)
  assert.match(r.stderr, /不合规/)
  assert.match(r.stderr, /status 应为 degraded/)
})

test('CLI：响应不是 JSON → 退出码 1', async () => {
  const r = await runCli('verify', srv.url('/notjson'))
  assert.equal(r.code, 1)
  assert.match(r.stderr, /不是合法 JSON/)
})

test('CLI：非 200 时提示 /health 应恒返回 200，但仍按响应体判定', async () => {
  const r = await runCli('verify', srv.url('/status503'))
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stderr, /HTTP 503/)
})

test('CLI：连接失败 → 退出码 2', async () => {
  // 先起再关，拿到一个确定没有人监听的本机端口
  const dead = await serve({})
  const url = dead.url('/health')
  await dead.close()
  const r = await runCli('verify', url)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /请求失败/)
})

test('CLI：缺少 URL 或 URL 非 http(s) → 退出码 2 并打印用法', async () => {
  for (const args of [['verify'], ['verify', 'ftp://example.invalid/health']]) {
    const r = await runCli(...args)
    assert.equal(r.code, 2, args.join(' '))
    assert.match(r.stderr, /用法/)
  }
})

test('CLI：省略 verify 子命令也能直接传 URL', async () => {
  const r = await runCli(srv.url('/good'))
  assert.equal(r.code, 0, r.stderr)
})
