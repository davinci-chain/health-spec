#!/usr/bin/env node
/**
 * 校验一个服务的 /health 是否符合本标准：
 *   npx @davinci-chain/health-spec verify https://your-service.example/health
 *
 * 退出码 0 = 合规，1 = 不合规，2 = 请求失败。
 * 校验的是「契约」，不是「服务是否健康」：一个如实报告 down 的服务同样是合规的。
 */
import { PROBE_TIMEOUT_MS, USER_AGENT, worst } from './types.js'
import type { Health, Status } from './types.js'

const STATUSES = new Set<Status>(['up', 'degraded', 'down'])
const NAME_RE = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/
const SERVICE_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/

export function validate(body: unknown, latencyMs?: number): string[] {
  const errs: string[] = []
  const b = body as Partial<Health>
  const req = (cond: boolean, msg: string) => { if (!cond) errs.push(msg) }

  req(typeof b?.schemaVersion === 'string' && /^1\.\d+$/.test(b.schemaVersion), 'schemaVersion 必须是 1.x')
  req(typeof b?.service === 'string' && SERVICE_RE.test(b.service), 'service 必须是小写短横线 id')
  req(typeof b?.status === 'string' && STATUSES.has(b.status as Status), 'status 必须是 up / degraded / down')
  req(typeof b?.observedAt === 'string' && !Number.isNaN(Date.parse(b.observedAt!)), 'observedAt 必须是 RFC 3339 时间')
  req(Array.isArray(b?.checks), 'checks 必须是数组')

  if (Array.isArray(b?.checks)) {
    req(b.checks.length <= 32, 'checks 最多 32 项')
    b.checks.forEach((c, i) => {
      req(typeof c?.name === 'string' && NAME_RE.test(c.name), `checks[${i}].name 命名不合规`)
      req(STATUSES.has(c?.status), `checks[${i}].status 取值不合规`)
      req(c.latencyMs === undefined || (typeof c.latencyMs === 'number' && c.latencyMs >= 0), `checks[${i}].latencyMs 必须是非负数`)
      req(c.detail === undefined || (typeof c.detail === 'string' && c.detail.length <= 200), `checks[${i}].detail 最长 200 字`)
      // 内部信息不该出现在对外字段里
      if (typeof c.detail === 'string' && /\b(10|127|192\.168)\.\d+\.\d+|:\d{4,5}\b|password|secret|token/i.test(c.detail)) {
        errs.push(`checks[${i}].detail 疑似含内网地址、端口或密钥`)
      }
    })
    // 整体状态必须等于最差的一项，否则界面会和明细自相矛盾
    if (b.checks.length && STATUSES.has(b.status as Status)) {
      const expect = worst(b.checks.map((c) => c.status))
      req(b.status === expect, `status 应为 ${expect}（等于 checks 里最差的一项），实际是 ${b.status}`)
    }
  }

  if (latencyMs !== undefined && latencyMs > PROBE_TIMEOUT_MS) {
    errs.push(`响应耗时 ${latencyMs}ms，超过 ${PROBE_TIMEOUT_MS}ms 上限`)
  }
  return errs
}

async function main(): Promise<number> {
  const url = process.argv[3] ?? process.argv[2]
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('用法：health-spec verify <url>')
    return 2
  }
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (e) {
    console.error(`请求失败：${(e as Error).message}`)
    return 2
  }
  const latencyMs = Date.now() - started

  if (res.status !== 200) console.error(`⚠️  HTTP ${res.status}：/health 无论健康与否都应返回 200，健康度看响应体`)
  let body: unknown
  try {
    body = JSON.parse(await res.text())
  } catch {
    console.error('响应不是合法 JSON')
    return 1
  }

  const errs = validate(body, latencyMs)
  if (errs.length === 0) {
    const b = body as Health
    console.log(`✓ 合规  ${b.service}  status=${b.status}  ${b.checks.length} 项检查  ${latencyMs}ms`)
    return 0
  }
  console.error(`✗ 不合规（${errs.length} 项）`)
  for (const e of errs) console.error(`  - ${e}`)
  return 1
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  process.exit(await main())
}
