import type { Check, Status } from './types.js'

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

/** 已经符合本标准的服务：原样取它的 checks */
function fromSpec(body: unknown, latencyMs: number): Check[] {
  const b = body as { checks?: Check[]; status?: Status }
  if (Array.isArray(b?.checks) && b.checks.length) return b.checks
  if (b?.status) return [{ name: 'http', status: b.status, latencyMs }]
  return [{ name: 'http', status: 'down', latencyMs, detail: '响应不符合健康契约' }]
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
