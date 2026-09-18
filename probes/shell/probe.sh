#!/usr/bin/env bash
# DaVinci 健康探针（最小实现，只依赖 curl 与 jq）
#
#   probe.sh static  <url> <必须出现的文本>    # 静态站：状态码 + 响应体断言
#   probe.sh service <url>                     # 自检服务：读 /health
#   probe.sh tls     <host>                    # 证书剩余天数（需要 openssl）
#
# 输出一行 JSON，符合 schema/health-v1.schema.json 的 checks 元素形状。
# 退出码：0=up  1=degraded  2=down
set -uo pipefail

UA='DaVinciHealthProbe/1.0 (+https://github.com/davinci-chain/health-spec)'
TIMEOUT=5

emit() { # name status latency detail
  jq -cn --arg n "$1" --arg s "$2" --argjson l "${3:-0}" --arg d "${4:-}" \
    '{name:$n,status:$s,latencyMs:$l} + (if $d == "" then {} else {detail:$d} end)'
  case "$2" in up) exit 0 ;; degraded) exit 1 ;; *) exit 2 ;; esac
}

now_ms() { date +%s000; }

case "${1:-}" in
  static)
    url=${2:?需要 url}; must=${3:?需要断言文本}
    start=$(now_ms)
    body=$(curl -sS -m "$TIMEOUT" -A "$UA" -w '\n%{http_code}' "$url" 2>/dev/null) || emit http down 0 "请求失败"
    lat=$(( $(now_ms) - start ))
    code=$(printf '%s' "$body" | tail -n1)
    [ "$code" = "200" ] || emit http down "$lat" "HTTP $code"
    # 只看状态码会长期假绿：空壳页面、CDN 缓存、SPA 兜底都会返回 200
    printf '%s' "$body" | grep -qF -- "$must" || emit http down "$lat" "页面缺少预期内容，可能只返回了空壳"
    emit http up "$lat"
    ;;

  service)
    url=${2:?需要 url}
    start=$(now_ms)
    body=$(curl -sS -m "$TIMEOUT" -A "$UA" "$url" 2>/dev/null) || emit http down 0 "请求失败"
    lat=$(( $(now_ms) - start ))
    st=$(printf '%s' "$body" | jq -r '.status // empty' 2>/dev/null)
    case "$st" in
      up|degraded|down) emit http "$st" "$lat" ;;
      *) emit http down "$lat" "响应不符合健康契约" ;;
    esac
    ;;

  tls)
    host=${2:?需要域名}
    end=$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
          | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    [ -n "$end" ] || emit tls down 0 "取不到证书"
    # macOS 与 GNU 的 date 参数不同，两种都试
    exp=$(date -j -f '%b %d %T %Y %Z' "$end" +%s 2>/dev/null || date -d "$end" +%s 2>/dev/null)
    [ -n "$exp" ] || emit tls degraded 0 "证书日期无法解析"
    days=$(( (exp - $(date +%s)) / 86400 ))
    [ "$days" -lt 0 ]  && emit tls down 0 "证书已过期"
    [ "$days" -lt 14 ] && emit tls degraded 0 "证书 ${days} 天后过期"
    emit tls up 0 "证书 ${days} 天后过期"
    ;;

  *)
    echo "用法：probe.sh {static <url> <文本>|service <url>|tls <host>}" >&2
    exit 64
    ;;
esac
