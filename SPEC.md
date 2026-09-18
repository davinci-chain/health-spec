# DaVinci 服务健康标准 v1

本文件定义 DaVinci Chain 各系统「健康」的统一口径：服务怎么自报状态、外部怎么探测、多久探一次、
什么情况才算故障、可用性怎么算。各系统按本标准补充探测，采集端才能把结果拼成一张一致的图。

契约版本写在响应里的 `schemaVersion`，本文对应 `1.0`。破坏性改动会升主版本，并在 `CHANGELOG.md` 记录。

---

## 1. 服务分四类

探测方式由服务形态决定，不由团队归属决定。

| 类型 | 说明 | 例子 | 探测方式 |
|---|---|---|---|
| `service` | 自己能跑代码的后端 | 运营面板、行情服务、Safe 后端 | 暴露 `/health`（见第 2 节），探针只读它 |
| `static` | 静态站点，无服务端 | 官网、区块浏览器、Safe 前端 | 外部拨测 + **响应体断言**（见 3.2） |
| `chain` | 链与 RPC 网关 | Nitro 节点、公开 RPC | 只读 JSON-RPC + 心跳交易（见 3.3） |
| `contract` | 链上合约不变量 | 跨链桥的 Inbox / Outbox / Bridge | 只读 `eth_call` 断言（见 3.4） |

服务清单在 [`registry/services.yaml`](registry/services.yaml)，新系统上线时往里加一条。

---

## 2. 自检契约：`GET /health`

`service` 类必须实现。响应 `200`，`content-type: application/json`，**无论健康与否都返回 200**——
HTTP 状态码表示「这个接口本身通不通」，业务健康度看响应体里的 `status`。

```json
{
  "schemaVersion": "1.0",
  "service": "market",
  "status": "degraded",
  "observedAt": "2026-09-18T01:00:00Z",
  "version": "1.4.2+a1b2c3d",
  "checks": [
    { "name": "rpc",      "status": "up",       "latencyMs": 42 },
    { "name": "database", "status": "degraded", "latencyMs": 1180, "detail": "写入延迟高于基线 3 倍" },
    { "name": "indexer",  "status": "up",       "latencyMs": 3, "detail": "落后 2 个区块" }
  ]
}
```

机器可读的定义见 [`schema/health-v1.schema.json`](schema/health-v1.schema.json)。

### 2.1 三态

| status | 含义 | 判定 |
|---|---|---|
| `up` | 功能完整 | 全部 check 都是 `up` |
| `degraded` | **能用但有损**：降级、延迟超标、数据滞后、依赖不可用但有兜底 | 至少一个 check 是 `degraded`，没有 `down` |
| `down` | 主要功能不可用 | 至少一个 check 是 `down` |

服务整体 `status` = 各 `checks` 里最差的那个，取值只能由服务自己算好，探针不重算。
一个 check 是否致命由服务自己定义：非关键依赖挂了应当报 `degraded` 而不是 `down`。

### 2.2 硬性要求

1. **不鉴权、不限流、不记 access log。** 面板、行情这类有 IP 白名单的服务，`/health` 必须是白名单的例外。
2. **5 秒内返回。** 超时按 `down` 处理。
3. **不做重活。** 不扫全表、不打外部依赖的写接口、不发交易。所有 check 读的应是进程内已有的状态或一次轻量查询。
4. **不泄露内部信息。** `detail` 里不写内网地址、端口、密钥、堆栈、SQL。它是给人看的一句话。
5. **`observedAt` 是数据的观测时刻**，不是请求时刻。缓存的结果要如实写它被采集的时间。
6. **路径统一为 `/health`。** 已有 `/healthz` 的服务保留旧路径做兼容，但必须同时提供 `/health`。

### 2.3 check 命名

同一个含义在各服务里用同一个名字，便于横向对比：

| name | 含义 |
|---|---|
| `rpc` | 到链 RPC 的连通性与延迟 |
| `database` | 主数据库 |
| `cache` | Redis 一类缓存 |
| `queue` | 消息队列 |
| `indexer` | 自建索引进度（落后多少块写进 `detail`） |
| `upstream:<名字>` | 其他内部服务依赖，如 `upstream:market` |
| `storage` | 磁盘或对象存储 |

---

## 3. 外部探测

采集端（当前是运营面板）按下表定期探测，结果统一归一成第 2 节的形状再入库。

### 3.1 通用规则

| 项 | 值 |
|---|---|
| 超时 | 5 秒（心跳交易 180 秒） |
| 重试 | 单轮内不重试。判定靠连续样本，见第 4 节 |
| User-Agent | `DaVinciHealthProbe/1.0 (+https://github.com/davinci-chain/health-spec)` |
| 并发 | 同一目标同时只允许一个探针在跑，上一轮没结束就跳过这一轮并记 `skipped` |
| 出口 | 探针必须从**公网**访问公网地址，不走内网捷径——否则测不出 DNS、证书、反代的问题 |

### 3.2 `static`：必须校验响应体

静态站与 SPA 常常在后端已经挂掉、或者被 CDN 缓存了一个空壳的情况下，仍然返回 HTTP 200。
只看状态码的探针在这类目标上会长期假绿。

因此每个 `static` 服务在注册表里必须配 `expect`，至少断言一段只有页面真正渲染出来才会出现的文本：

```yaml
- id: explorer
  type: static
  url: https://explorer.davincichain.io/
  expect:
    status: 200
    bodyContains: "DaVinci Scan"      # 必须出现
    bodyNotContains: "Cloudflare Error"
    maxBytes: 2097152                 # 响应体上限，防止把探针拖死
  tls:
    minDaysLeft: 14                   # 证书剩余天数低于此值报 degraded
```

判定：状态码不符或 `bodyContains` 缺失 → `down`；证书剩余天数不足 → `degraded`；
响应时间超过该目标 7 天 p95 的 3 倍 → `degraded`。

### 3.3 `chain`：能做什么、不能做什么

**允许的只读探测**

| check | 方法 | 判定 |
|---|---|---|
| `rpc` | `eth_chainId` | 返回值不等于期望链 ID → `down` |
| `head` | `eth_blockNumber` + `eth_getBlockByNumber(latest)` | 不可达 → `down` |
| `ws` | `eth_subscribe(newHeads)` 建连后立即断开 | 建连失败 → `degraded` |
| `batch` | 读 SequencerInbox 的 `batchCount()` | 计数**回退** → `down`；有未上链数据且滞留 > 90 分钟 → `down` |
| `parentFinality` | 父链 `eth_getBlockByNumber("finalized")` 的时间戳 | 滞后 > 30 分钟 → `degraded`，> 60 分钟 → `down` |
| `wallets` | 父链上 batch poster / validator 余额 | 按第 5 节的「还能撑几天」判定 |
| `exposure` | `rpc_modules` | 出现 `debug`/`txpool`/`admin`/`personal`/`miner` → `down`（这是安全回归） |

**心跳（活性）**

空闲的 Orbit 链在没有交易时**不出块**，所以「距上次出块多久」不是健康指标。活性只能靠心跳：
每 6 小时用一个**专用钱包**发一笔自转 0 的交易，看能否被打包。

心跳由服务器上的 `monitor.sh` 负责发，采集端只读它的结果，不自己持有热钱包私钥。
心跳失败两次 → sequencer 判 `down`。

**禁止**

1. 禁止用 `txpool_status` 判活——nitro 上会让 handler 崩。
2. 禁止用 `eth_getBlockByNumber("pending")`——nitro 上完全等同 `latest`，得不到任何额外信息。
3. 禁止按「距上次出块时长」或「距上次 batch 时长」告警——空闲链本就如此，这条曾累计误报 161 次。
4. 禁止调用任何会改变状态的方法：`debug_*`、`admin_*`、`miner_*`、`personal_*`。**连「探一下方法在不在」都不行**，
   暴露面只能用 `rpc_modules` 判断。
5. 禁止压测共享节点。
6. **batch 链路与 validator 链路必须分别覆盖**。历史上两次监控改造都只盯 batch，staker 静默失败完全看不见。

**探针预算**：公开 RPC 限流 30 r/s，且 Safe 的索引器已经在吃这份配额。
所有健康探针加起来对 RPC 的请求**不得超过 1 r/s**。

### 3.4 `contract`：只读断言

用 `eth_call` 读链上不变量，写法是「期望值来自注册表，实测值来自链上，不一致就报警」：

```yaml
- id: bridge-core
  type: contract
  chain: davinci-testnet
  asserts:
    - name: inbox-code
      call: codesize
      target: "0x..."            # 合约地址
      expect: { gt: 0 }
    - name: outbox-owner
      call: "owner()"
      target: "0x..."
      expect: { equals: "0x..." }
```

合约地址与期望值以**链上实测**为准，改动必须在提交里说明依据。

---

## 4. 什么才算故障

单次失败不算故障。网络抖动、一次 TLS 握手超时、一次限流，都会制造假警报。

| 规则 | 值 |
|---|---|
| **判定 down** | 连续 **3** 个样本为 `down` |
| **判定 degraded** | 连续 **3** 个样本为 `degraded` 或更差 |
| **判定恢复** | 连续 **2** 个样本为 `up` |
| **抖动（flapping）** | 10 分钟内状态翻转 ≥ 4 次 → 标记 `flapping`，按 `degraded` 处理，合并成一条事件 |
| **维护窗口** | 注册表里可声明维护窗口，窗口内的样本照常记录，但不开事件、不计入可用性 |

**事件（incident）**：从判定 `down` 到判定恢复算一次事件，记录开始时刻、结束时刻、持续时长、
触发它的 check 名字。MTTR = 同一服务全部事件持续时长的均值。

### 4.1 探测间隔

| 目标 | 间隔 |
|---|---|
| `static`、`service` | 60 秒 |
| `chain` 的只读项 | 30 秒 |
| `contract` 断言 | 10 分钟 |
| 心跳交易 | 6 小时 |
| TLS 证书剩余天数 | 6 小时 |

按第 4 节的规则，一个 60 秒间隔的服务从真正挂掉到被判定为故障，最长约 3 分钟。

---

## 5. 余额口径：按「还能撑几天」，不按固定金额

固定阈值（例如「低于 0.15 ETH 报警」）在用量变化时要么太吵要么太晚。统一改成：

```
日均支出 = 最近 3 天余额下降总额 / 3        （只算下降，充值不抵扣）
可用天数 = 当前余额 / 日均支出
```

| 可用天数 | 状态 |
|---|---|
| < 7 天 | `down`（必须立即充值） |
| < 14 天 | `degraded` |
| ≥ 14 天 | `up` |

观测不足 1 天不计算日均支出，此时报 `unknown` 而不是 `up`。
这条同时适用于链上运营钱包和云账户余额。

---

## 6. 可用性与延迟

| 指标 | 口径 |
|---|---|
| **可用性** | 按 **1 分钟**样本计算：该分钟内最后一个样本不是 `down` 即算可用。`degraded` 计入可用 |
| **统计周期** | 自然月，时区 UTC |
| **目标** | 链与 RPC 99.5%；其余服务 99%。达不到的月份要在事件记录里有对应的 incident |
| **延迟** | 每个探针记 p50 / p95。基线取该目标过去 7 天的 p95，实测超过基线 3 倍算 `degraded` |
| **缺样本** | 探针自己没跑（进程重启、`skipped`）的时间段标记为 `no-data`，**不计入**可用性的分子分母 |

### 6.1 数据保留

| 粒度 | 保留 |
|---|---|
| 原始样本 | 35 天 |
| 分钟聚合 | 90 天 |
| 日聚合（可用性、p50/p95、事件数） | 2 年 |
| 事件记录 | 永久 |

---

## 7. 对外披露

对外状态页只显示**服务名 + 三态 + 最近 90 天的日可用性**，不显示：
内网地址与端口、错误堆栈、`detail` 原文、钱包余额、云账户余额、任何阈值的实际数值。

内部面板显示全部细节。两者读同一份数据，差别只在渲染层的字段裁剪。

---

## 8. 接入新系统的最短路径

1. 在 [`registry/services.yaml`](registry/services.yaml) 里加一条，声明类型、地址、期望。
2. 如果是 `service` 类，实现 `GET /health`，用校验器自测：
   ```bash
   npx @davinci-chain/health-spec verify https://your-service.example/health
   ```
3. 参考实现在 [`probes/ts/`](probes/ts)（TypeScript）和 [`probes/shell/`](probes/shell)（只依赖 curl 与 jq）。
4. 提 PR 时，在描述里写清楚新增的 check 各自在什么情况下会变成 `degraded` 和 `down`。
