#!/bin/sh
# 日次ダンプ: BACKUP_TIME (HH:MM) に pg_dump -Fc を 1 回実行し、生成物を /backups に置く。
# KEEP_DAYS を過ぎたダンプは削除する。ボリュームはホスト側の別ディスクを bind mount する想定。
set -u

TH="${BACKUP_TIME%:*}"
TM="${BACKUP_TIME#*:}"

while :; do
  h="$(date +%H)"
  m="$(date +%M)"
  cur=$(( h * 60 + m ))
  tgt=$(( TH * 60 + TM ))
  [ "$tgt" -le "$cur" ] && tgt=$(( tgt + 1440 ))
  sleep_secs=$(( (tgt - cur) * 60 ))
  echo "[backup] next dump in ${sleep_secs}s"
  sleep "$sleep_secs"

  ts="$(date +%Y%m%d_%H%M%S)"
  out="/backups/${POSTGRES_DB}_${ts}.dump"
  if PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$PGHOST" -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$out"; then
    echo "[backup] created $out"
  else
    echo "[backup] FAILED dump -> $out" >&2
    rm -f "$out"
  fi

  find /backups -name "${POSTGRES_DB}_*.dump" -type f -mtime "+${KEEP_DAYS}" -delete
done
