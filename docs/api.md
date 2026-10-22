# API 仕様

Base URL: Cloudflare Tunnel で公開した `https://<API_DOMAIN>` (docker-compose の `cloudflared` 経由)。

## 共通

- すべてのレスポンスは JSON。
- エラーは統一形式:
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "...", "extra": "..." } }
  ```
- ステータスコード:
  - `400 VALIDATION_ERROR` — 入力の型・範囲・文字数違反、不正JSON、本文過大(64KB超)
  - `401 UNAUTHORIZED` — 管理APIのトークン不正
  - `403 FORBIDDEN` — 他人のレビューへの編集/削除
  - `404 NOT_FOUND` — 存在しないレビュー/ルート
  - `409 ALREADY_REPORTED` — 同一匿名IDの重複通報
  - `429 RATE_LIMITED` — レート制限超過(レスポンスヘッダに `Retry-After`)
  - `503` — `/healthz` でDB unreachable
- 匿名IDの哈ッシュ、生の匿名IDは**いかなるレスポンスにも含まれない**。
- 一覧・集計は `ETag`(強)と `Cache-Control: public, max-age=60` を返す。`If-None-Match` が一致すると `304`。
- 全リクエスト 64KB ボディ上限。

### 匿名IDの渡し方

| 用途 | 形式 |
|---|---|
| 投稿・通報 | リクエストボディの `anonId` (UUID) |
| 自分のレビュー / 編集 / 削除 | リクエストヘッダ `X-Anon-ID` (UUID) |

サーバーは匿名IDを `HMAC-SHA256(pepper, anonId)` でハッシュ化して `author_hash` にのみ保存する。

---

## GET `/healthz`

ヘルスチェック。DBの疎通を確認する。

```
200 { "status": "ok", "db": "ok" }
503 { "error": { "code": "INTERNAL_ERROR", ... } }
```

---

## GET `/v1/items/{itemId}/reviews`

公開中レビューの一覧(新しい順)。`status=published` のみ。

Query:
- `page` — 1始まり (default 1)
- `perPage` — default 10 / max 50 (.env 変更可)

Response `200`:
```json
{
  "reviews": [
    { "id": 1, "rating": 5, "body": "とても良かった", "createdAt": "...", "updatedAt": "..." }
  ],
  "page": 1, "perPage": 10, "total": 12, "totalPages": 2
}
```

## GET `/v1/items/{itemId}/summary`

平均と件数。`review_stats` 集計テーブルから O(1)。

```json
{ "count": 12, "average": 4.08 }
```
レビュー0件のとき `{ "count": 0, "average": null }`。

## GET `/v1/items/{itemId}/mine`

自分のレビュー(非表示でも取得可能)。ヘッダ `X-Anon-ID` 必須(省略時 400)。

```json
{ "review": { "id": 1, ... } | null }
```

---

## POST `/v1/items/{itemId}/reviews`

投稿。同一 (item_id, 匿名ID) が存在する場合は**更新**として扱う(JSON `created:false`、`200`)。新規は `201`。

Body:
```json
{ "rating": 1..5(整数), "body": "プレーンテキスト", "anonId": "UUID", "shop": "nico25" }
```

- `body`: 制御文字/ゼロ幅文字を除去した後、`MIN_BODY_LEN`(初期10)〜 `MAX_BODY_LEN`(初期2000)文字
- `rating`: 1〜5 の整数
- `shop`: 任意。投稿元URLのショップサブドメイン (BOOTH ショップ集計用)。省略時は既存値を変更しない

注意: 事実上 status は変更しない(管理者/通報により非表示にされたレビューは投稿で復活しない)。

## PATCH `/v1/reviews/{id}`

編集。ヘッダ `X-Anon-ID` で本人確認。他人のレビュー → `403 FORBIDDEN`。存在しない / 削除済み → `404`。

Body (どちらか最低1項目)：
```json
{ "rating": 3?, "body": "..."?, "shop": "nico25"? }
```
- `shop`: 任意。旧レビューをショップ集計に紐付ける場合などに付与する (省略時は変更しない)

Response `{ "review": { ... } }`

## DELETE `/v1/reviews/{id}`

削除は `status='deleted'` への論理削除(物理削除はしない)。他人 → `403`。存在しない → `404`。

## POST `/v1/reviews/{id}/report`

通報。Body: `{"anonId": "UUID"}`。

- 同一匿名IDからの重複 → `409 ALREADY_REPORTED`
- 非表示中のレビュー → `400`、存在しない/削除済み → `404`
- 通報数が `REPORT_AUTOHIDE_THRESHOLD`(初期5)に達すると、自動で `status='hidden'`(`hidden_reason='auto_report'`)

Response `{ "ok": true }`(通報数は応答しない)

---

## 管理用 API

すべて `Authorization: Bearer <ADMIN_TOKEN>` 必須。不足 → `401`。

### GET `/v1/admin/reviews`

Query: `status`(`published|hidden|deleted`)、`itemId`、`query`(本文部分一致, 最大200文字)、`order`(`created`=既定 / `reports`=通報数の多い順)、`page`、`perPage`。

```json
{
  "reviews": [
    { "id": 1, "itemId": 123, "rating": 5, "body": "...", "status": "published",
      "hiddenReason": null, "reportCount": 0, "createdAt": "...", "updatedAt": "..." }
  ],
  "page": 1, "perPage": 10, "total": 1, "totalPages": 1
}
```

### PATCH `/v1/admin/reviews/{id}`

非表示・復活・削除(物理削除はしない)。

Body:
```json
{ "status": "published" | "hidden" | "deleted" }
```
- `hidden` を付けると `hidden_reason='admin'`
- `published` に戻すと `hidden_reason=null`

Response: 更新後のレビュー(通報数を含む)。

### GET `/v1/admin/stats`

管理ダッシュボード用の集計 (JSON)。IP あたり `RATE_LIMIT_ADMIN_PER_IP_PER_MINUTE`(既定20回/分)。

- `counts`: レビュー件数 (total / published / hidden / deleted)
- `avgRating`: 公開レビューの平均評価 (null 許容)
- `ratingDistribution`: 星1〜5 の分布 (公開レビューのみ)
- `reportTotal` / `topReported`: 通報の総数と、通報が多いレビュー TOP10 (本文・status・通報数付き)
- `trend`: 直近30日の日次投稿数 (ゼロ埋め, UTC 日付)
- `topItems`: 公開レビューの多いアイテム TOP10
- `dbSizeBytes` / `tableSizes`: DB キャパシティ (`pg_database_size` / テーブル別)
- `disk`: ディスク合計・空き (取得できない環境では `null`)
- `backups`: バックアップディレクトリのファイル一覧とサイズ (`BACKUPS_DIR`, read-only マウント)

### GET `/admin/dashboard`

管理ダッシュボードの HTML (ブラウザで開く)。このページ自体はデータを含まず、
ページ内で `ADMIN_TOKEN` を入力すると `GET /v1/admin/stats` を Bearer 認証付きで呼び出して描画する。
トークンは sessionStorage に保持され、タブを閉じると消える。

### GET `/v1/shops/:shop/summary`

ショップ集計 (例: `/v1/shops/nico25/summary`)。投稿時に URL から採取したサブドメイン付きの公開レビューのみ対象。

```json
{ "count": 2, "average": 4 }
```

> 旧データ (投稿時に shop を記録していないレビュー) は商品ページのみで扱い、ショップ集計には含まれない。

### GET `/v1/shops/:shop/reviews`

ショップの公開レビュー一覧。`page` / `perPage` に対応。item 側の一覧と異なり、各レビューに元商品へのリンク用 `itemId` が付く。

```json
{ "reviews": [{ "id": 5, "itemId": 9955501, "rating": 4, "body": "...", "createdAt": "..." }],
  "page": 1, "perPage": 10, "total": 1, "totalPages": 1 }
```

---

## レート制限(初期値、`.env` で調整)

| 区分 | 上限 |
|---|---|
| IP あたり POST | 10回/時間 |
| 匿名ID あたり POST | 5回/時間 |
| IP あたり通報 | 20回/時間 |
| 匿名ID あたり通報 | 10回/時間 |
| IP あたり一覧・集計のGET | 120回/分 |
| IP あたり mine | 30回/分 |

IP は `CF-Connecting-IP` から取得するが、**リクエスト元が信頼する CIDR(docker 内部ネットワーク + loopback)の場合のみ** 採用され、それ以外でこのヘッダーを送っても無視する。IP はレート制限判定のみに利用し、永続保存しない。レート制限カウンタは API プロセスのメモリ内にあるため、再起動でリセットされる。
