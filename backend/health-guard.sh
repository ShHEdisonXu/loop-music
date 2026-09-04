#!/bin/bash
# 2F Music 健康守护 v2
# 由用户 crontab 每5分钟调用。双容器探针，连续3次失败才重启（防单次502抖动），重启后带3分钟冷却防震荡。
LOG=/vol4/1000/download-service/health-guard.log
STATE_DIR=/vol4/1000/download-service/.health
mkdir -p "$STATE_DIR"
TS=$(date '+%F %T')

fail() { # fail <state_file> <svc>
  local f="$1" svc="$2" n; n=0
  [ -f "$f" ] && n=$(cat "$f" 2>/dev/null)
  n=$((n+1)); echo "$n" > "$f"
  if [ "$n" -ge 3 ]; then
    echo "$TS [$svc] 连续${n}次不健康，触发重启" >> "$LOG"
    docker restart "$svc" >> "$LOG" 2>&1
    rm -f "$f"
    touch "$STATE_DIR/${svc}.last_restart"
    sleep 60
  fi
}
ok() { # ok <state_file> <svc>
  local f="$1" svc="$2"
  rm -f "$f"
}

# 冷却检查：重启后 180 秒内不重复重启
cooldown() { # cooldown <svc>
  local svc="$1" lf="$STATE_DIR/${svc}.last_restart" now old
  [ -f "$lf" ] || return 0
  now=$(date +%s); old=$(date -r "$lf" +%s 2>/dev/null || echo 0)
  [ $((now-old)) -lt 180 ]
}

# 探针：download-service
if curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:23237/api/health 2>/dev/null | grep -q '^200$'; then
  ok "$STATE_DIR/ds.fail" download-service
else
  if cooldown download-service; then
    echo "$TS [download-service] 冷却中，本次失败仅记录；当前仍按连续计数处理" >> "$LOG"
  fi
  fail "$STATE_DIR/ds.fail" download-service
fi

# 探针：2fmusic-ncm-api
if curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:23236/ 2>/dev/null | grep -q '^200$'; then
  ok "$STATE_DIR/ncm.fail" 2fmusic-ncm-api
else
  fail "$STATE_DIR/ncm.fail" 2fmusic-ncm-api
fi

exit 0
