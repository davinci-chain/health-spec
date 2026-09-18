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

## 许可

MIT
