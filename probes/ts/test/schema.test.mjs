// schema/health-v1.schema.json 的正例与反例，以及它与 validate() 的口径对照。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { validate } from '../dist/index.js'
import { goodHealth, readRepoFile } from './helpers.mjs'

const schema = JSON.parse(readRepoFile('schema/health-v1.schema.json'))
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const check = ajv.compile(schema)
const schemaOk = (body) => {
  const ok = check(body)
  return { ok, why: ajv.errorsText(check.errors) }
}

test('schema 本身能按 draft 2020-12 严格模式编译', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(typeof check, 'function')
})

// ---- 正例 ----

const POSITIVE = {
  '标准样例': goodHealth(),
  '无 version 字段': (({ version, ...rest }) => rest)(goodHealth()),
  'checks 为空数组': goodHealth({ status: 'up', checks: [] }),
  '如实报告 down': goodHealth({ status: 'down', checks: [{ name: 'rpc', status: 'down', detail: '连不上链' }] }),
  'schemaVersion 1.x 的次版本': goodHealth({ schemaVersion: '1.3' }),
  '带时区偏移的时间': goodHealth({ observedAt: '2026-09-18T09:00:00+08:00' }),
  '带毫秒的时间': goodHealth({ observedAt: '2026-09-18T01:00:00.123Z' }),
  '32 项 checks（上限）': goodHealth({ status: 'up', checks: Array.from({ length: 32 }, (_, i) => ({ name: `c${i}`, status: 'up' })) }),
  'check 只有必填字段': goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up' }] }),
}

for (const [label, body] of Object.entries(POSITIVE)) {
  test(`正例：${label}`, () => {
    const r = schemaOk(body)
    assert.ok(r.ok, r.why)
    assert.deepEqual(validate(body), [], '校验器应与 schema 一致')
  })
}

/** 取出 Markdown 里所有 ```json 代码块 */
function jsonBlocks(md) {
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]))
}

test('文档里的示例响应（README / SPEC）都能通过 schema 与校验器', () => {
  const examples = [...jsonBlocks(readRepoFile('README.md')), ...jsonBlocks(readRepoFile('SPEC.md'))]
  assert.ok(examples.length >= 2, '应至少找到 README 与 SPEC 各一个示例')
  for (const ex of examples) {
    const r = schemaOk(ex)
    assert.ok(r.ok, `${ex.service}: ${r.why}`)
    assert.deepEqual(validate(ex), [], ex.service)
  }
})

// ---- 反例：schema 与 validate() 都应拒绝 ----

const drop = (key) => (({ [key]: _, ...rest }) => rest)(goodHealth())

const NEGATIVE_BOTH = {
  '缺 schemaVersion': drop('schemaVersion'),
  '缺 service': drop('service'),
  '缺 status': drop('status'),
  '缺 observedAt': drop('observedAt'),
  '缺 checks': drop('checks'),
  'schemaVersion 为 2.0': goodHealth({ schemaVersion: '2.0' }),
  'schemaVersion 为数字': goodHealth({ schemaVersion: 1 }),
  'service 含大写': goodHealth({ service: 'Market' }),
  'service 以短横线结尾': goodHealth({ service: 'market-' }),
  'service 超过 40 字符': goodHealth({ service: 'a'.repeat(41) }),
  'status 不在三态内': goodHealth({ status: 'ok' }),
  'observedAt 不是时间': goodHealth({ observedAt: 'yesterday' }),
  'checks 不是数组': goodHealth({ checks: {} }),
  'checks 超过 32 项': goodHealth({ status: 'up', checks: Array.from({ length: 33 }, (_, i) => ({ name: `c${i}`, status: 'up' })) }),
  'check 名字大写': goodHealth({ status: 'up', checks: [{ name: 'RPC', status: 'up' }] }),
  'check 名字多段冒号': goodHealth({ status: 'up', checks: [{ name: 'a:b:c', status: 'up' }] }),
  'check 缺 name': goodHealth({ status: 'up', checks: [{ status: 'up' }] }),
  'check 缺 status': goodHealth({ status: 'up', checks: [{ name: 'rpc' }] }),
  'check status 非法': goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'fine' }] }),
  'latencyMs 为负': goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up', latencyMs: -1 }] }),
  'latencyMs 为字符串': goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up', latencyMs: '42' }] }),
  'detail 超过 200 字': goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up', detail: 'x'.repeat(201) }] }),
}

for (const [label, body] of Object.entries(NEGATIVE_BOTH)) {
  test(`反例：${label}`, () => {
    assert.equal(schemaOk(body).ok, false, 'schema 应拒绝')
    assert.ok(validate(body).length > 0, '校验器应拒绝')
  })
}

// ---- 反例：只有 schema 能表达的结构约束 ----

test('反例（schema）：顶层不允许多余字段', () => {
  assert.equal(schemaOk(goodHealth({ uptime: 123 })).ok, false)
})

test('反例（schema）：check 不允许多余字段', () => {
  assert.equal(schemaOk(goodHealth({ status: 'up', checks: [{ name: 'rpc', status: 'up', host: 'x' }] })).ok, false)
})

test('反例（schema）：version 最长 64', () => {
  assert.ok(schemaOk(goodHealth({ version: 'v'.repeat(64) })).ok)
  assert.equal(schemaOk(goodHealth({ version: 'v'.repeat(65) })).ok, false)
})

// ---- 反例：只有校验器能表达的语义约束（schema 无法表达，是预期差异） ----

test('反例（校验器）：整体 status 与最差项不一致 —— schema 放行、校验器拒绝', () => {
  const body = goodHealth({ status: 'up' })
  assert.ok(schemaOk(body).ok)
  assert.ok(validate(body).length > 0)
})

// ---- 口径一致：schema 拒绝的，校验器也拒绝 ----

test(
  '口径一致：schema 拒绝的时间格式与 check 名长度，校验器也应拒绝',
  () => {
    const cases = [
      goodHealth({ observedAt: '2026-09-18' }),
      goodHealth({ observedAt: 'Sep 18 2026' }),
      goodHealth({ status: 'up', checks: [{ name: 'a'.repeat(41), status: 'up' }] }),
    ]
    for (const body of cases) {
      assert.equal(schemaOk(body).ok, false)
      assert.ok(validate(body).length > 0, JSON.stringify(body.observedAt))
    }
  },
)
