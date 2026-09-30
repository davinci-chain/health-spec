// registry/services.yaml 的格式校验。规则来自 SPEC.md 第 1、3 节与注册表文件头注释。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { adapt } from '../dist/index.js'
import { readRepoFile } from './helpers.mjs'

const reg = parse(readRepoFile('registry/services.yaml'))
const services = reg.services ?? []

const TYPES = new Set(['service', 'static', 'chain', 'contract'])
const TIERS = new Set([0, 1, 2])
const ID_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/**
 * SPEC 3.3 的 chain 只读检查项与心跳。validator 未在 3.3 表里单列，
 * 但 3.3「禁止」第 6 条要求 validator 链路单独覆盖，注册表里以 validator 表示。
 */
const CHAIN_CHECKS = new Set(['rpc', 'head', 'ws', 'batch', 'parentFinality', 'wallets', 'exposure', 'heartbeat', 'validator'])
const ENTRY_KEYS = new Set(['id', 'name', 'type', 'url', 'adapter', 'tier', 'expect', 'tls', 'checks', 'chain', 'internal', 'asserts', 'verifiedAt'])
const EXPECT_KEYS = new Set(['status', 'bodyContains', 'bodyNotContains', 'maxBytes'])

const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

/**
 * 注册表是公开的：只能写公网地址。拒绝 IP 字面量、显式端口、内网主机名和非 https/wss 协议。
 * 返回问题描述，没问题返回 null。
 */
function publicUrlProblem(raw, protocols = ['https:']) {
  let u
  try {
    u = new URL(raw)
  } catch {
    return '不是合法 URL'
  }
  if (!protocols.includes(u.protocol)) return `协议必须是 ${protocols.join(' / ')}`
  if (u.port) return '不得写显式端口'
  if (u.username || u.password) return '不得包含凭据'
  const host = u.hostname
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return '不得使用 IP 地址'
  if (!host.includes('.') || /\.(local|internal|lan|svc|cluster\.local)$/.test(host) || host === 'localhost') return '不得使用内网主机名'
  return null
}

test('publicUrlProblem 自检：能拦住内网地址', () => {
  for (const bad of [
    'http://davincichain.io/',
    'https://10.1.2.3/health',
    'https://localhost/health',
    'https://market:8080/health',
    'https://market.davincichain.io:8443/health',
    'https://svc.default.svc.cluster.local/health',
    'https://user:pw@davincichain.io/',
    'not a url',
  ]) {
    assert.notEqual(publicUrlProblem(bad), null, bad)
  }
  assert.equal(publicUrlProblem('https://market.davincichain.io/health'), null)
})

// ---- 顶层 ----

test('顶层：version 为 1，updatedAt 为合法日期', () => {
  assert.equal(reg.version, 1)
  assert.ok(isDate(reg.updatedAt), String(reg.updatedAt))
})

test('顶层：services 非空数组', () => {
  assert.ok(Array.isArray(reg.services) && reg.services.length > 0)
})

// ---- chains ----

test('chains：每条链有整数 chainId 与公网 https RPC / wss WS', () => {
  assert.ok(reg.chains && typeof reg.chains === 'object')
  for (const [key, c] of Object.entries(reg.chains)) {
    assert.match(key, ID_RE, `链 key ${key}`)
    assert.ok(Number.isInteger(c.chainId) && c.chainId > 0, `${key}.chainId`)
    assert.equal(publicUrlProblem(c.rpc), null, `${key}.rpc`)
    if (c.ws !== undefined) assert.equal(publicUrlProblem(c.ws, ['wss:']), null, `${key}.ws`)
    if (c.parent !== undefined) {
      assert.equal(typeof c.parent.name, 'string', `${key}.parent.name`)
      assert.ok(Number.isInteger(c.parent.chainId) && c.parent.chainId !== c.chainId, `${key}.parent.chainId`)
    }
  }
})

// ---- services：每条通用规则 ----

test('services：id 唯一且符合服务 id 规则（与 /health 的 service 字段同一规则）', () => {
  const seen = new Set()
  for (const s of services) {
    assert.match(String(s.id), ID_RE, `id ${s.id}`)
    assert.ok(!seen.has(s.id), `id 重复：${s.id}`)
    seen.add(s.id)
  }
})

test('services：必填 name / type / tier / verifiedAt，且取值合法', () => {
  for (const s of services) {
    assert.ok(typeof s.name === 'string' && s.name.trim(), `${s.id}.name`)
    assert.ok(TYPES.has(s.type), `${s.id}.type = ${s.type}`)
    assert.ok(TIERS.has(s.tier), `${s.id}.tier = ${s.tier}`)
    assert.ok(isDate(s.verifiedAt), `${s.id}.verifiedAt = ${s.verifiedAt}`)
  }
})

test('services：没有未知字段（防止拼错字段名导致配置静默失效）', () => {
  for (const s of services) {
    for (const k of Object.keys(s)) assert.ok(ENTRY_KEYS.has(k), `${s.id} 有未知字段 ${k}`)
    if (s.expect) for (const k of Object.keys(s.expect)) assert.ok(EXPECT_KEYS.has(k), `${s.id}.expect 有未知字段 ${k}`)
  }
})

test('services：所有 url 都是公网 https 地址', () => {
  for (const s of services) {
    if (s.url === undefined) continue
    assert.equal(publicUrlProblem(s.url), null, `${s.id}.url = ${s.url}`)
  }
})

test('services：tls.minDaysLeft 为正整数', () => {
  for (const s of services) {
    if (s.tls === undefined) continue
    assert.ok(Number.isInteger(s.tls.minDaysLeft) && s.tls.minDaysLeft > 0, `${s.id}.tls.minDaysLeft`)
  }
})

test('services：internal 只能是布尔值', () => {
  for (const s of services) if (s.internal !== undefined) assert.equal(typeof s.internal, 'boolean', s.id)
})

// ---- 按类型的规则 ----

test('static：必须有 url 和 expect.bodyContains（SPEC 3.2：只看状态码会假绿）', () => {
  const statics = services.filter((s) => s.type === 'static')
  assert.ok(statics.length > 0)
  for (const s of statics) {
    assert.ok(s.url, `${s.id} 缺 url`)
    assert.ok(typeof s.expect?.bodyContains === 'string' && s.expect.bodyContains.trim(), `${s.id} 缺 expect.bodyContains`)
  }
})

test('static：bodyContains 不能是空壳也有的通用标记', () => {
  const SHELL = /^<\/?(html|head|body|div|script)\b|^<!doctype/i
  for (const s of services.filter((x) => x.type === 'static')) {
    assert.ok(!SHELL.test(s.expect.bodyContains.trim()), `${s.id}.bodyContains = ${s.expect.bodyContains}`)
    assert.ok(s.expect.bodyContains.trim().length >= 6, `${s.id}.bodyContains 太短，容易误中`)
  }
})

test('static：expect.status 是 HTTP 状态码，maxBytes 为正整数', () => {
  for (const s of services.filter((x) => x.type === 'static')) {
    const e = s.expect
    if (e.status !== undefined) assert.ok(Number.isInteger(e.status) && e.status >= 100 && e.status <= 599, `${s.id}.expect.status`)
    if (e.maxBytes !== undefined) assert.ok(Number.isInteger(e.maxBytes) && e.maxBytes > 0, `${s.id}.expect.maxBytes`)
    if (e.bodyNotContains !== undefined) assert.equal(typeof e.bodyNotContains, 'string', `${s.id}.expect.bodyNotContains`)
  }
})

test('service：必须有 url；adapter 若有，必须是 adapters.ts 里实现了的', () => {
  for (const s of services.filter((x) => x.type === 'service')) {
    assert.ok(s.url, `${s.id} 缺 url`)
    if (s.adapter !== undefined) {
      const [c] = adapt(s.adapter, {}, 0)
      assert.doesNotMatch(c.detail ?? '', /未知的 adapter/, `${s.id}.adapter = ${s.adapter}`)
    }
  }
})

test('adapter 只能用于 service 类型', () => {
  for (const s of services) if (s.adapter !== undefined) assert.equal(s.type, 'service', s.id)
})

test('chain：chain 指向已声明的链，checks 非空且都是 SPEC 3.3 允许的项', () => {
  const chains = services.filter((s) => s.type === 'chain')
  assert.ok(chains.length > 0)
  for (const s of chains) {
    assert.ok(reg.chains?.[s.chain], `${s.id}.chain = ${s.chain} 未在 chains 里声明`)
    assert.ok(Array.isArray(s.checks) && s.checks.length > 0, `${s.id}.checks`)
    for (const c of s.checks) assert.ok(CHAIN_CHECKS.has(c), `${s.id}.checks 含未知项 ${c}`)
    assert.equal(new Set(s.checks).size, s.checks.length, `${s.id}.checks 有重复`)
  }
})

test('chain：batch 链路与 validator 链路必须分别覆盖（SPEC 3.3 禁止第 6 条）', () => {
  const all = services.filter((s) => s.type === 'chain').flatMap((s) => s.checks)
  assert.ok(all.includes('batch'), '缺 batch')
  assert.ok(all.includes('validator'), '缺 validator')
})

test('exposure 是安全回归，必须单独成条目并标 internal（SPEC 6.2）', () => {
  for (const s of services) {
    if (!s.checks?.includes('exposure')) continue
    assert.deepEqual(s.checks, ['exposure'], `${s.id}：exposure 不得与可用性检查混在同一条目`)
    assert.equal(s.internal, true, `${s.id} 必须 internal: true`)
  }
})

test('contract：必须声明 chain 与至少一条断言', () => {
  for (const s of services.filter((x) => x.type === 'contract')) {
    assert.ok(reg.chains?.[s.chain], `${s.id}.chain`)
    assert.ok(Array.isArray(s.asserts) && s.asserts.length > 0, `${s.id}.asserts`)
  }
})
