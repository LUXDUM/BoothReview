#!/usr/bin/env bash
# 結合確認 (スモークテスト): サーバー上で実行する。
#
#   cd /opt/boothreview && ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2) bash server/docker/smoke.sh
#   # Tunnel 経由で確認する場合: BASE_URL=https://reviews.example.com を先頭に付けて指定
#   BASE_URL=https://reviews.example.com ADMIN_TOKEN=... bash server/docker/smoke.sh
#
set -uo pipefail

BASE="${BASE_URL:-http://127.0.0.1:8080}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "ADMIN_TOKEN を環境変数で渡してください (.env の値)" >&2
  exit 1
fi

ITEM=9012345
A=$(cat /proc/sys/kernel/random/uuid)
B=$(cat /proc/sys/kernel/random/uuid)
C1=$(cat /proc/sys/kernel/random/uuid)
C2=$(cat /proc/sys/kernel/random/uuid)
C3=$(cat /proc/sys/kernel/random/uuid)
C4=$(cat /proc/sys/kernel/random/uuid)
C5=$(cat /proc/sys/kernel/random/uuid)

fail=0
check() { # check <説明> <期待部分文字列> <実際の出力>
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
check "If-None-Match 304" '304' "$(curl -s -o /dev/null -w '%{http_code}' -H "$ETAG" "$BASE/v1/items/$ITEM/reviews")"
curl -s -o /dev/null -X POST -H 'content-type: application/json' \
  -d "{\"rating\":5,\"body\":\"更新後の本文に書き換えました\",\"anonId\":\"$A\"}" \
  "$BASE/v1/items/$ITEM/reviews"
check "再投稿は更新 (レコード数は1のまま)" '"total":1' "$(curl -s "$BASE/v1/items/$ITEM/reviews")"

echo "=== 4. 権限 (他人は編集・削除できない)"
check "他人のPATCH 403" 'FORBIDDEN' "$(curl -s -X PATCH -H 'content-type: application/json' -H "x-anon-id: $B" -d '{"body":"他人が勝手に書き換える"}' "$BASE/v1/reviews/$ID")"
check "他人のDELETE 403" 'FORBIDDEN' "$(curl -s -X DELETE -H "x-anon-id: $B" "$BASE/v1/reviews/$ID")"
MINE=$(curl -s -H "x-anon-id: $A" "$BASE/v1/items/$ITEM/mine")
check "本人のmine取得" "\"id\":$ID" "$MINE"

echo "=== 5. 通報 → 自動非表示 (閾値取得)"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"anonId\":\"$B\"}" "$BASE/v1/reviews/$ID/report"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"anonId\":\"$C1\"}" "$BASE/v1/reviews/$ID/report"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"anonId\":\"$C2\"}" "$BASE/v1/reviews/$ID/report"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"anonId\":\"$C3\"}" "$BASE/v1/reviews/$ID/report"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"anonId\":\"$C4\"}" "$BASE/v1/reviews/$ID/report"
LAST=$(curl -s -X POST -H 'content-type: application/json' -d "{\"anonId\":\"$C5\"}" "$BASE/v1/reviews/$ID/report")
check "5件目の通報 '"'"ok"'"'" '"ok":true' "$LAST"
check "自動非表示で一覧から消える (60秒キャッシュ別Id判定用)" '"total":0' "$(curl -s "$BASE/v1/items/$ITEM/reviews?perPage=50")"

echo "=== 6. 管理 (非表示 → 復活 → 削除)"
check "管理一覧に報告数5" '"reportCount":5' "$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/v1/admin/reviews?status=hidden&itemId=$ITEM")"
check "管理トークンなし 401" 'UNAUTHORIZED' "$(curl -s "$BASE/v1/admin/reviews")"
check "復活 'published'" '"status":"published"' "$(curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"status":"published"}' "$BASE/v1/admin/reviews/$ID")"
check "削除 'deleted'" '"status":"deleted"' "$(curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"status":"deleted"}' "$BASE/v1/admin/reviews/$ID")"

echo "=== 7. 本人のみの削除"
# B が投稿し、B 自身が削除できる
POST_B=$(curl -s -X POST -H 'content-type: application/json' -d "{\"rating\":3,\"body\":\"Bさんのレビュー本文です\",\"anonId\":\"$B\"}" "$BASE/v1/items/$ITEM/reviews")
ID_B=$(printf '%s' "$POST_B" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
check "本人のDELETE ok" '"ok":true' "$(curl -s -X DELETE -H "x-anon-id: $B" "$BASE/v1/reviews/$ID_B")"

if [ "$fail" = 0 ]; then
  echo "ALL SMOKE CHECKS PASSED"
else
  echo "SOME CHECKS FAILED (上の FAIL 行を参照)"
  exit 1
fi
