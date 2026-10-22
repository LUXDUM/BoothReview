# DB 設計

PostgreSQL 16。マイグレーションは drizzle-kit (`server/drizzle/`) で管理し、API 起動時に自動適用される。

## テーブル

### `reviews`

| カラム | 型 | 説明 |
|---|---|---|
| id | bigserial PK | |
| item_id | bigint NOT NULL | BOOTH 商品ID |
| author_hash | char(64) NOT NULL | `HMAC-SHA256(pepper, 匿名ID)` の hex。生の匿名IDやIPは保存しない |
| rating | smallint NOT NULL | CHECK (1..5) |
| body | text NOT NULL | CHECK (長さ 1..20000)。実運用上の上限は .env (`MIN_/MAX_BODY_LEN`) |
| status | text NOT NULL DEFAULT 'published' | CHECK (`published` / `hidden` / `deleted`)。**物理削除はしない** |
| hidden_reason | text NULL | `admin` / `auto_report` / NULL |
| created_at / updated_at | timestamptz | |

制約・インデックス:
- `UNIQUE (item_id, author_hash)` — 1つの商品につき 1匿名IDが投稿できるレビューは1件
- `INDEX (item_id, status, created_at)` — 一覧クエリ用

### `reports`

| カラム | 型 | 説明 |
|---|---|---|
| id | bigserial PK | |
| review_id | bigint FK → reviews.id | |
| reporter_hash | char(64) NOT NULL | 通報者の匿名IDハッシュ (同一人物の重複通報対策) |
| created_at | timestamptz | |

制約・インデックス:
- `UNIQUE (review_id, reporter_hash)`
- `INDEX (review_id)`

### `review_stats`(集計テーブル)

| カラム | 型 |
|---|---|
| item_id | bigint PK |
| review_count | integer |
| rating_sum | integer |
| updated_at | timestamptz |

`reviews` の INSERT/UPDATE(rating・status)/DELETE のトリガー (`review_stats_maintain`) がメンテナンスするため、
`GET /v1/items/{id}/summary` は行数が増えても O(1)。再計算が必要になった場合のマニュアル:

```sql
INSERT INTO review_stats (item_id, review_count, rating_sum, updated_at)
SELECT item_id, COUNT(*), COALESCE(SUM(rating),0), now()
FROM reviews WHERE status = 'published'
GROUP BY item_id
ON CONFLICT (item_id) DO UPDATE
  SET review_count = EXCLUDED.review_count,
      rating_sum = EXCLUDED.rating_sum,
      updated_at = now();
```

(レビューが全件いなくなった item の stats 行は DELETE トリガーで消える)

## 将来の画像添付 (今回未実装)

`reviews` 側に画像の列を持たせず、後から次のようなテーブルを追加するだけで拡張できる構造にしてある:

```sql
CREATE TABLE review_assets (
  id bigserial PRIMARY KEY,
  review_id bigint NOT NULL REFERENCES reviews(id),
  -- 後日決める (URL/フォーマット/サイズ など)
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## マイグレーション

- スキーマ変更は `server/src/db/schema.ts` を編集 → `npm run db:generate`(server/ 内)で SQL を生成
- トリガー・CHECK など drizzle-kit が出力しないものは手書き SQL を追加している (`0001_review_checks_and_stats_trigger.sql`)
- 適用は API コンテナ起動時 (drizzle `migrate()`)

## 保持方針 (個人情報)

- 匿名ID: 生のまま保存しない (HMAC-SHA256 ハッシュのみ)
- IP: 永続保存しない (レート制限のメモリカウンタのみ)
- レビュー本文・商品IDのみを DB に保持
