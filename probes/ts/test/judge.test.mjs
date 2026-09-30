// 三态聚合（worst）与故障判定（decide / isFlapping），对应 SPEC.md 2.1 与第 4 节。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { worst, decide, isFlapping } from '../dist/index.js'

test('worst：全 up → up', () => {
  assert.equal(worst(['up', 'up', 'up']), 'up')
})

test('worst：有 degraded 无 down → degraded，与顺序无关', () => {
  assert.equal(worst(['up', 'degraded', 'up']), 'degraded')
  assert.equal(worst(['degraded', 'up']), 'degraded')
  assert.equal(worst(['up', 'up', 'degraded']), 'degraded')
})

test('worst：任一 down → down，即使后面还有 degraded / up', () => {
  assert.equal(worst(['down', 'degraded', 'up']), 'down')
  assert.equal(worst(['up', 'degraded', 'down']), 'down')
  assert.equal(worst(['degraded', 'down', 'degraded']), 'down')
})

test('worst：空数组按 down（没有检查结果 = 不知道它活着）', () => {
  assert.equal(worst([]), 'down')
})

test('worst：单项原样返回', () => {
  for (const s of ['up', 'degraded', 'down']) assert.equal(worst([s]), s)
})

// ---- decide：down 连续 3 次，degraded 连续 3 次「degraded 或更差」，恢复连续 2 次 up ----

test('decide：连续 3 个 down → down', () => {
  assert.equal(decide(['down', 'down', 'down']), 'down')
  assert.equal(decide(['up', 'up', 'down', 'down', 'down']), 'down')
})

test('decide：只有 2 个 down 不算故障，维持上一次判定', () => {
  assert.equal(decide(['down', 'down']), 'up')
  assert.equal(decide(['up', 'down', 'down']), 'up')
  assert.equal(decide(['up', 'down', 'down'], 'degraded'), 'degraded')
})

test('decide：单次失败不算故障', () => {
  assert.equal(decide(['up', 'up', 'down']), 'up')
  assert.equal(decide(['down']), 'up')
})

test('decide：连续 3 个 degraded 或更差（但不全是 down）→ degraded', () => {
  assert.equal(decide(['degraded', 'degraded', 'degraded']), 'degraded')
  assert.equal(decide(['down', 'degraded', 'down']), 'degraded')
  assert.equal(decide(['degraded', 'down', 'down']), 'degraded')
  assert.equal(decide(['up', 'degraded', 'down', 'down']), 'degraded')
})

test('decide：2 个 degraded 不够，维持上一次判定', () => {
  assert.equal(decide(['up', 'degraded', 'degraded']), 'up')
})

test('decide：连续 2 个 up 才算恢复', () => {
  assert.equal(decide(['down', 'down', 'down', 'up', 'up'], 'down'), 'up')
  assert.equal(decide(['degraded', 'up', 'up'], 'degraded'), 'up')
})

test('decide：只有 1 个 up 不算恢复，维持 down', () => {
  assert.equal(decide(['down', 'down', 'down', 'up'], 'down'), 'down')
  assert.equal(decide(['up'], 'down'), 'down')
})

test('decide：样本不足时维持上一次判定，默认 up', () => {
  assert.equal(decide([]), 'up')
  assert.equal(decide([], 'down'), 'down')
  assert.equal(decide(['degraded'], 'degraded'), 'degraded')
})

test('decide：只看最近的样本，早先的 down 不影响', () => {
  assert.equal(decide(['down', 'down', 'down', 'up', 'down'], 'down'), 'down')
  assert.equal(decide(['down', 'down', 'down', 'degraded', 'up', 'up'], 'down'), 'up')
})

// ---- isFlapping：窗口内翻转 ≥ 4 次 ----

test('isFlapping：翻转 4 次 → true', () => {
  assert.equal(isFlapping(['up', 'down', 'up', 'down', 'up']), true)
})

test('isFlapping：翻转 3 次 → false（边界）', () => {
  assert.equal(isFlapping(['up', 'down', 'up', 'down']), false)
})

test('isFlapping：连续相同状态不算翻转', () => {
  assert.equal(isFlapping(['up', 'up', 'down', 'down', 'down', 'up', 'up']), false)
  assert.equal(isFlapping(['up', 'up', 'up', 'up', 'up', 'up']), false)
})

test('isFlapping：degraded 与 up 之间的切换也算翻转', () => {
  assert.equal(isFlapping(['up', 'degraded', 'up', 'degraded', 'up']), true)
})

test('isFlapping：空窗口和单样本 → false', () => {
  assert.equal(isFlapping([]), false)
  assert.equal(isFlapping(['down']), false)
})

test('isFlapping：可自定义阈值', () => {
  assert.equal(isFlapping(['up', 'down', 'up'], 2), true)
  assert.equal(isFlapping(['up', 'down', 'up'], 3), false)
})
