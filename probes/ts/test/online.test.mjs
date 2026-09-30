// 在线冒烟：按注册表真的去探公网目标。默认跳过，显式开启：
//   HEALTH_SPEC_ONLINE=1 npm test     或     npm run test:online
// 只探 static / service 两类公网地址（每个目标 1 个请求），不碰 RPC，不需要任何密钥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { probe, validate } from '../dist/index.js'
import { readRepoFile } from './helpers.mjs'

const ONLINE = process.env.HEALTH_SPEC_ONLINE === '1'
const reg = parse(readRepoFile('registry/services.yaml'))
const targets = reg.services.filter((s) => (s.type === 'static' || s.type === 'service') && !s.internal)

for (const entry of targets) {
  test(`在线：${entry.id} 探测结果合规且为 up`, { skip: !ONLINE && '未设置 HEALTH_SPEC_ONLINE=1' }, async () => {
    const h = await probe(entry)
    assert.deepEqual(validate(h), [], `${entry.id} 探测结果不合契约`)
    assert.equal(h.status, 'up', `${entry.id}：${JSON.stringify(h.checks)}`)
  })
}

for (const entry of targets.filter((s) => s.type === 'service' && !s.adapter)) {
  test(`在线：${entry.id} 的 /health 通过契约校验`, { skip: !ONLINE && '未设置 HEALTH_SPEC_ONLINE=1' }, async () => {
    const res = await fetch(entry.url, { signal: AbortSignal.timeout(5_000) })
    assert.equal(res.status, 200)
    assert.deepEqual(validate(await res.json()), [])
  })
}
