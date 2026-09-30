// 测试公用：合规的 /health 样例、本机回环 HTTP 服务器、仓库根目录下的文件路径。
// 全部离线：HTTP 服务器只监听 127.0.0.1，不访问任何外部地址。
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

export const REPO_ROOT = new URL('../../../', import.meta.url)
export const repoFile = (rel) => new URL(rel, REPO_ROOT)
export const readRepoFile = (rel) => readFileSync(repoFile(rel), 'utf8')

/** 一份合规的 /health 响应体；override 可覆盖任意顶层字段 */
export function goodHealth(override = {}) {
  return {
    schemaVersion: '1.0',
    service: 'market',
    status: 'degraded',
    observedAt: '2026-09-18T01:00:00Z',
    version: '1.4.2+a1b2c3d',
    checks: [
      { name: 'rpc', status: 'up', latencyMs: 42 },
      { name: 'database', status: 'degraded', latencyMs: 1180, detail: '写入延迟高于基线 3 倍' },
      { name: 'upstream:market', status: 'up' },
    ],
    ...override,
  }
}

/**
 * 起一个本机 HTTP 服务器。routes: { '/path': (req, res) => void }，未命中返回 404。
 * 返回 { url(path), close() }。
 */
export async function serve(routes) {
  const server = createServer((req, res) => {
    const handler = routes[new URL(req.url, 'http://x').pathname]
    if (!handler) {
      res.writeHead(404).end('not found')
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}

export const json = (body, status = 200) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body))
}

export const html = (body, status = 200) => (req, res) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body)
}
