/** 本标准的三态。顺序即严重度，聚合时取最差的一个。 */
export type Status = 'up' | 'degraded' | 'down'

const ORDER: Record<Status, number> = { up: 0, degraded: 1, down: 2 }

/** 取最差状态；空数组按 down（没有任何检查结果 = 不知道它活着） */
export function worst(list: Status[]): Status {
  return list.reduce<Status>((acc, s) => (ORDER[s] > ORDER[acc] ? s : acc), list.length ? 'up' : 'down')
}

export interface Check {
  name: string
  status: Status
  latencyMs?: number
  /** 给人看的一句话。不写内网地址、端口、密钥、堆栈、SQL */
  detail?: string
}

export interface Health {
  schemaVersion: string
  service: string
  status: Status
  observedAt: string
  version?: string
  checks: Check[]
}

export interface StaticExpect {
  status?: number
  bodyContains?: string
  bodyNotContains?: string
  maxBytes?: number
}

export interface TlsExpect {
  minDaysLeft: number
}

export interface ServiceEntry {
  id: string
  name: string
  type: 'service' | 'static' | 'chain' | 'contract'
  url?: string
  adapter?: string
  tier: number
  expect?: StaticExpect
  tls?: TlsExpect
  checks?: string[]
  chain?: string
}

export const PROBE_TIMEOUT_MS = 5_000
export const USER_AGENT = 'DaVinciHealthProbe/1.0 (+https://github.com/davinci-chain/health-spec)'
