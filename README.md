# DaVinci Health Spec

DaVinci Chain 各系统「健康」的统一标准：服务怎么自报状态、外部怎么探测、什么情况才算故障、
可用性怎么算。链、区块浏览器、跨链桥、官网以及后续所有系统都按这份标准补充探测。

| 文件 | 内容 |
|---|---|
| [`SPEC.md`](SPEC.md) | **标准本体**：健康契约、探测方式、故障判定、可用性口径 |
| [`schema/health-v1.schema.json`](schema/health-v1.schema.json) | `/health` 响应的机器可读定义 |
| [`registry/services.yaml`](registry/services.yaml) | 服务注册表：探测什么、期望是什么 |
| [`probes/ts/`](probes/ts) | 参考探针与契约校验器（TypeScript，零依赖） |
| [`probes/shell/`](probes/shell) | 最小探针（只依赖 curl 与 jq） |

## 三十秒版本

服务暴露 `GET /health`，无论健康与否都返回 HTTP 200，健康度写在响应体里：

```json
{
  "schemaVersion": "1.0",
  "service": "market",
  "status": "degraded",
  "observedAt": "2026-09-18T01:00:00Z",
  "checks": [
    { "name": "rpc", "status": "up", "latencyMs": 42 },
    { "name": "indexer", "status": "degraded", "latencyMs": 3, "detail": "落后 1200 个区块" }
  ]
}
```

三态：`up` 功能完整，`degraded` 能用但有损，`down` 主要功能不可用。整体状态等于最差的那一项。

自测是否合规：

```bash
npx @davinci-chain/health-spec verify https://your-service.example/health
```

## 几条最容易踩的坑

这些都是线上实测出来的，写进标准是为了不再犯第二次：

1. **只看 HTTP 200 会长期假绿。** 空壳页面、CDN 缓存、SPA 兜底路由都会返回 200，
   静态站必须断言响应体里的特征文本。
2. **空闲的 Orbit 链不出块。** 「距上次出块多久」不是健康指标，按它告警曾累计误报 161 次。
   活性只能靠定期发一笔心跳交易来判断。
3. **单次失败不是故障。** 连续 3 个样本才判 `down`，连续 2 个 `up` 才算恢复，10 分钟内翻转 4 次算抖动。
4. **余额按「还能撑几天」判定，不用固定金额。** 用量一变，固定阈值要么太吵要么太晚。
5. **探针预算有限。** 公开 RPC 限流 30 r/s 且已有服务在吃这份配额，所有健康探针加起来不得超过 1 r/s。

完整清单见 [`SPEC.md`](SPEC.md) 第 3 节。

## 接入新系统

1. 往 [`registry/services.yaml`](registry/services.yaml) 加一条，声明类型、地址、期望。
2. 后端服务实现 `GET /health`，用上面的校验器自测。
3. 提 PR 时说明：新增的每个 check 在什么情况下会变成 `degraded`，什么情况下会变成 `down`。

采集与展示在运营面板（内部），对外状态页只显示服务名、三态和日可用性，不暴露任何内部细节。

## 测试

测试在 `probes/ts/test/`，用 Node 内置的 `node:test`，需要 Node ≥ 22。
全部离线：不需要私钥、测试网或 anvil，HTTP 相关用例只连本机 `127.0.0.1` 上临时起的服务器。

```bash
cd probes/ts
npm ci
npm test            # 先 build 到 dist/，再跑全部离线用例
```

| 文件 | 覆盖 |
|---|---|
| `judge.test.mjs` | 三态取最差项 `worst()`、故障判定 `decide()`、抖动 `isFlapping()`（SPEC 2.1、第 4 节） |
| `verify.test.mjs` | 契约校验器 `validate()` 的每条规则，以及 CLI 的退出码 0 / 1 / 2 |
| `probe.test.mjs` | `static` 的响应体断言、状态码、重定向、`maxBytes`；`service` 的直读与 adapter；超时 |
| `adapters.test.mjs` | 各 adapter 的归一结果 |
| `schema.test.mjs` | `schema/health-v1.schema.json` 的正例与反例，与校验器口径对照；README / SPEC 里的示例响应 |
| `registry.test.mjs` | `registry/services.yaml` 的格式：id、类型、只写公网地址、`static` 必须断言响应体、adapter 已实现等 |
| `online.test.mjs` | 在线冒烟，按注册表真的去探公网目标，**默认跳过** |

在线冒烟需要显式开启（只探 `static` / `service` 的公网地址，每个目标一个请求，不碰 RPC）：

```bash
npm run test:online        # 等同于 HEALTH_SPEC_ONLINE=1，先 build 再只跑在线用例
```

标为 `todo` 的用例对应已知缺陷（见 issue #2、#3），它们会显示失败但不影响退出码；修好后去掉 `todo`。
改 `registry/services.yaml` 或 schema 时，`npm test` 会一并校验。

## 许可

MIT
