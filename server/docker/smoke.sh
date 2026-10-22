#!/usr/bin/env bash
# 結合確認 (スモークテスト): サーバー上で実行する。
#
#   cd /home/<user>/boothreview
#   set -a; . ./.env; set +a
#   BASE_URL=http://127.0.0.1:${API_PORT:-8080} bash server/docker/smoke.sh
#   # Tunnel 経由: BASE_URL=https://reviews.example.com bassh ...
set -uo pipefail

BASE="${BASE_URL:-http://127.0.0.1:8080}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
THRESHOLD="${REPORT_AUTOHIDE_THRESHOLD:-5}"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "ADMIN_TOKEN を環境変数で渡してください (.env の値)" >&2
  exit 1
fi

ITEM=$(( 1000000 + $(date +%s) % 8999999 ))   # 実行ごとに別の商品ID (前回状態に依存しない)
A=$(cat /proc/sys/kernel/random/uuid)
B=$(cat /proc/sys/kernel/random/uuid)
C1=$(cat /proc/sys/kernel/random/uuid)
C2=$(cat /proc/sys/kernel/random/uuid)
C3=$(cat /proc/sys/kernel/random/uuid)
C4=$(cat /proc/sys/kernel/random/uuid)
C5=$(cat /proc/sys/kernel/random/uuid)

fail=0
check() {
  if printf '%s' "$3" | grep -q "$2"; then
    echo "OK   : $1"
  else
    echo "FAIL : $1 (期待: [$2] 実際: [$3])"
    fail=1
  fi
}

echo "=== 1. healthz"
check "healthz 200" '"status":"ok"' "$(curl -sf "$BASE/healthz")"

echo "=== 2. 空の一覧と集計"
check "一覧 (0件)" '"total":0' "$(curl -s "$BASE/v1/items/$ITEM/reviews")"
check "集計 (avg null)" '"average":null' "$(curl -s "$BASE/v1/items/$ITEM/summary")"

echo "=== 3. 投稿 / 更新 (A)"
POST1=$(curl -s -X POST -H 'content-type: application/json' \
  -d "{\"rating\":4,\"body\":\"スモークテストのレビューです\",\"anonId\":\"$A\"}" \
  "$BASE/v1/items/$ITEM/reviews")
check "新規投稿 201" '"created":true' "$POST1"
ID=$(printf '%s' "$POST1" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
ETAG=$(curl -s -D - -o /dev/null "$BASE/v1/items/$ITEM/reviews" | grep -i '^etag' | cut -d' ' -f2 | tr -d '\r')
check "ETag 付与" 'etag' "$(curl -s -D - -o /dev/null "$BASE/v1/items/$ITEM/reviews" | grep -i '^etag')"
check "If-None-Match 304" '304' "$(curl -s -o /dev/null -w '%{http_code}' -H "if-none-match: $ETAG" "$BASE/v1/items/$ITEM/reviews")"
curl -s -o /dev/null -X POST -H 'content-type: application/json' \
  -d '{"rating":5,"body":"更新後の本文に書き換えました","anonId":"'"$A"'"}' \
  "$BASE/v1/items/$ITEM/reviews"
check "再投稿は更新 (レコード数は1のまま)" '"total":1' "$(curl -s "$BASE/v1/items/$ITEM/reviews")"

echo "=== 4. 権限 (他人は編集・削除できない)"
check "他人のPATCH 403" 'FORBIDDEN' "$(curl -s -X PATCH -H 'content-type: application/json' -H "x-anon-id: $B" -d '{"body":"他人が勝手に書き換える"}' "$BASE/v1/reviews/$ID")"
check "他人のDELETE 403" 'FORBIDDEN' "$(curl -s -X DELETE -H "x-anon-id: $B" "$BASE/v1/reviews/$ID")"
check "本人のmine取得" "\"id\":$ID" "$(curl -s -H "x-anon-id: $A" "$BASE/v1/items/$ITEM/mine")"

echo "=== 5. 通報 → 自動非表示 (閾値=$THRESHOLD)"
for R in "$B" "$C1" "$C2" "$C3" "$C4" "$C5"; do
  curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"anonId\":\"$R\"}" "$BASE/v1/reviews/$ID/report"
done
check "非表示で一覧から消える" '"total":0' "$(curl -s "$BASE/v1/items/$ITEM/reviews?perPage=50")"

echo "=== 6. 管理 (非表示 → 復活 → 削除)"
check "管理一覧に報告数$THRESHOLD" "\"reportCount\":$THRESHOLD" "$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/v1/admin/reviews?status=hidden&itemId=$ITEM")"
check "管理トークンなし 401" 'UNAUTHORIZED' "$(curl -s "$BASE/v1/admin/reviews")"
check "復活 'published'" '"status":"published"' "$(curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"status":"published"}' "$BASE/v1/admin/reviews/$ID")"
check "削除 'deleted'" '"status":"deleted"' "$(curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"status":"deleted"}' "$BASE/v1/admin/reviews/$ID")"

echo "=== 7. 本人のみの削除"
POST_B=$(curl -s -X POST -H 'content-type: application/json' -d "{\"rating\":3,\"body\":\"Bさんのレビュー本文です\",\"anonId\":\"$B\"}" "$BASE/v1/items/$ITEM/reviews")
ID_B=$(printf '%s' "$POST_B" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
check "本人のDELETE ok" '"ok":true' "$(curl -s -X DELETE -H "x-anon-id: $B" "$BASE/v1/reviews/$ID_B")"

if [ "$fail" = 0 ]; then
  echo "ALL SMOKE CHECKS PASSED"
else
  echo "SOME CHECKS FAILED (上の FAIL 行を参照)"
  exit 1
fi
