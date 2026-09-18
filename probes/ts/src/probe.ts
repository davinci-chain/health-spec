import { PROBE_TIMEOUT_MS, USER_AGENT, worst } from './types.js'
import type { Check, Health, ServiceEntry, Status } from './types.js'
import { adapt } from './adapters.js'

/** 探测一个目标，结果统一归一成 Health 的形状 */
export async function probe(entry: ServiceEntry, now = () => new Date()): Promise<Health> {
  const checks = entry.type === 'static' ? await probeStatic(entry) : await probeService(entry)
  return {
    schemaVersion: '1.0',
    service: entry.id,
    status: worst(checks.map((c) => c.status)),
    observedAt: now().toISOString(),
    checks,
  }
}

/**
 * static：状态码 + 响应体断言。
 * 只看状态码会长期假绿 —— 页面空壳、CDN 缓存、SPA 兜底都会返回 200。
 */
async function probeStatic(entry: ServiceEntry): Promise<Check[]> {
  const expect = entry.expect ?? {}
  const started = Date.now()
  let res: Response
  try {
    res = await fetchWithTimeout(entry.url!)
  } catch (e) {
    return [{ name: 'http', status: 'down', latencyMs: Date.now() - started, detail: reason(e) }]
  }

  const wantStatus = expect.status ?? 200
  if (res.status !== wantStatus) {
    return [{ name: 'http', status: 'down', latencyMs: Date.now() - started, detail: `HTTP ${res.status}，期望 ${wantStatus}` }]
  }

  const body = await readCapped(res, expect.maxBytes ?? 4 * 1024 * 1024)
  const latencyMs = Date.now() - started

  if (expect.bodyContains && !body.includes(expect.bodyContains)) {
    return [{ name: 'http', status: 'down', latencyMs, detail: '页面缺少预期内容，可能只返回了空壳' }]
  }
  if (expect.bodyNotContains && body.includes(expect.bodyNotContains)) {
    return [{ name: 'http', status: 'down', latencyMs, detail: '页面出现了错误页特征' }]
  }
  return [{ name: 'http', status: 'up', latencyMs }]
}

/** service：读它自己的 /health；上游格式不合标准的，交给 adapter 归一 */
async function probeService(entry: ServiceEntry): Promise<Check[]> {
  const started = Date.now()
  let res: Response
  try {
    res = await fetchWithTimeout(entry.url!)
  } catch (e) {
    return [{ name: 'http', status: 'down', latencyMs: Date.now() - started, detail: reason(e) }]
  }
  const latencyMs = Date.now() - started
  if (!res.ok) return [{ name: 'http', status: 'down', latencyMs, detail: `HTTP ${res.status}` }]

  let body: unknown
  try {
    body = JSON.parse(await readCapped(res, 256 * 1024))
  } catch {
    return [{ name: 'http', status: 'down', latencyMs, detail: '响应不是合法 JSON' }]
  }
  return adapt(entry.adapter, body, latencyMs)
}

/**
 * 超时按 down 处理。注意 fetch 自身不会因慢响应而中止，必须显式给信号。
 */
async function fetchWithTimeout(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Response> {
  return fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** 读响应体但设上限，避免一个巨大的响应把探针拖死 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    chunks.push(value)
    if (size >= maxBytes) {
      await reader.cancel()
      break
    }
  }
  return new TextDecoder().decode(concat(chunks, Math.min(size, maxBytes)))
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    const take = Math.min(c.length, total - at)
    out.set(c.subarray(0, take), at)
    at += take
    if (at >= total) break
  }
  return out
}

/** 错误信息只留可判断的部分，不把内部细节写进 detail */
function reason(e: unknown): string {
  const msg = (e as Error)?.name === 'TimeoutError' ? '超时' : (e as Error)?.message ?? '请求失败'
  return msg.slice(0, 120)
}

/**
 * 判定：单次失败不算故障。传入按时间升序的最近样本，返回判定后的状态。
 * down 要连续 3 次，恢复要连续 2 次 up，其余维持上一次判定。
 */
export function decide(samples: Status[], previous: Status = 'up'): Status {
  const tail = (n: number) => samples.slice(-n)
  if (samples.length >= 3 && tail(3).every((s) => s === 'down')) return 'down'
  if (samples.length >= 3 && tail(3).every((s) => s !== 'up')) return 'degraded'
  if (samples.length >= 2 && tail(2).every((s) => s === 'up')) return 'up'
  return previous
}

/** 抖动：10 分钟窗口内状态翻转 4 次及以上，按 degraded 处理并合并成一条事件 */
export function isFlapping(window: Status[], minFlips = 4): boolean {
  let flips = 0
  for (let i = 1; i < window.length; i++) if (window[i] !== window[i - 1]) flips++
  return flips >= minFlips
}
