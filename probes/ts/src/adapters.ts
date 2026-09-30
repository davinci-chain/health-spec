import { isStatus, worst } from './types.js'
import type { Check } from './types.js'

/**
 * 已有服务不一定按本标准返回。adapter 把它们的响应归一成 Check[]，
 * 这样采集端和界面只需要认识一种形状。
 *
 * 新服务应当直接实现 SPEC.md 第 2 节的 /health，不要写新的 adapter。
 * 每个 adapter 都对应一个「让上游改造」的 issue，改造完成后删掉它。
 */
export function adapt(name: string | undefined, body: unknown, latencyMs: number): Check[] {
  switch (name) {
    case undefined:
      return fromSpec(body, latencyMs)
    case 'safe-cgw':
      return fromSafeCgw(body, latencyMs)
    case 'blockscout-stats':
      return fromBlockscoutStats(body, latencyMs)
    default:
      return [{ name: 'http', status: 'down', latencyMs, detail: `未知的 adapter：${name}` }]
  }
}

const BAD_CONTRACT = '响应不符合健康契约'
const BAD_STATUS = `${BAD_CONTRACT}：status 不是 up / degraded / down`

/**
 * 已经符合本标准的服务：取它的 checks。
 * 上游的取值不能直接信：三态以外的 status 一律归一成 down；
 * 整体 status 比各项 check 更差时补一项 http 记下它，两者取最差，不让任何一边被忽略成假绿。
 */
function fromSpec(body: unknown, latencyMs: number): Check[] {
  const b = body as { checks?: unknown; status?: unknown } | null | undefined
  const hasStatus = b?.status !== undefined && b?.status !== null
  if (Array.isArray(b?.checks) && b.checks.length) {
    const checks = b.checks.map(toCheck)
    if (!hasStatus) return checks
    if (!isStatus(b.status)) return [...checks, { name: 'http', status: 'down', latencyMs, detail: BAD_STATUS }]
    const agg = worst(checks.map((c) => c.status))
    if (worst([b.status, agg]) !== agg) {
      return [...checks, { name: 'http', status: b.status, latencyMs, detail: '服务整体状态比各项 check 更差' }]
    }
    return checks
  }
  if (hasStatus) {
    if (isStatus(b!.status)) return [{ name: 'http', status: b!.status, latencyMs }]
    return [{ name: 'http', status: 'down', latencyMs, detail: BAD_STATUS }]
  }
  return [{ name: 'http', status: 'down', latencyMs, detail: BAD_CONTRACT }]
}

/** 单项 check：取值合法原样保留（缺 name 按序号补）；否则归一成 down，不回显上游的原始取值 */
function toCheck(raw: unknown, i: number): Check {
  const c = raw as Partial<Check> | null
  const named = typeof c?.name === 'string' && c.name !== ''
  const name = named ? c!.name! : `check[${i}]`
  if (c && typeof c === 'object' && isStatus(c.status)) return named ? (c as Check) : { ...(c as Check), name }
  return { name, status: 'down', detail: BAD_STATUS }
}

/** Safe client gateway：{"status":"OK"} */
function fromSafeCgw(body: unknown, latencyMs: number): Check[] {
  const ok = (body as { status?: string })?.status === 'OK'
  return [{ name: 'http', status: ok ? 'up' : 'down', latencyMs, detail: ok ? undefined : '上游未返回 OK' }]
}

/** Blockscout /api/v2/stats：拿得到统计就说明后端和数据库都活着 */
function fromBlockscoutStats(body: unknown, latencyMs: number): Check[] {
  const b = body as { total_blocks?: string; gas_prices?: unknown }
  const alive = b?.total_blocks !== undefined || b?.gas_prices !== undefined
  return [{ name: 'http', status: alive ? 'up' : 'down', latencyMs, detail: alive ? undefined : '统计接口返回内容异常' }]
}
