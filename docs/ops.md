# 運用手順 (Ubuntu Server / Docker Compose)

> 結合確認 (全機能の curl スモークテスト) は `server/docker/smoke.sh` を参照。


## 1. 初期セットアップ

サーバー要件目安: セルフホストの Ubuntu Server / Docker Compose。API + PostgreSQL + cloudflared + backup でメモリ ~300MB 程度なので、RAM 2GB程度のマシンでも余裕を持って動く。

```bash
# リポジトリを配置
git clone <repo> /opt/boothreview && cd /opt/boothreview

# .env を作成
cp .env.example .env
nano .env   # 全ての change-me を書き換え

# 秘密値の生成例
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### .env の必須項目

| 変数 | 説明 |
|---|---|
| `POSTGRES_PASSWORD` | DBのパスワード |
| `PEPPER` | 匿名IDハッシュ化の秘密値。**一度運用を始めたら変更しない** |
| `ADMIN_TOKEN` | 管理APIの Bearer トークン |
| `TUNNEL_TOKEN` | Cloudflare Tunnel のトークン (後述) |
| `BACKUP_DIR` | バックアップ保存先。別ディスクなら `/mnt/backup/boothreview` など |
| `API_PORT` | サーバー内のAPIポート (127.0.0.1 のみに bind) |

### バックアップ先ディレクトリ

```bash
# 別ディスクのマウント例
sudo mkdir -p /mnt/backup/boothreview && sudo chown -R $USER /mnt/backup/boothreview
# .env の BACKUP_DIR=/mnt/backup/boothreview
```

## 2. Cloudflare Tunnel (ルーターのポート開放なし)

外部公開には Cloudflare Tunnel を使う。サーバーはクラウドflareへの送信接続のみで、受信ポートは不要。

1. Cloudflare ダッシュボード → Zero Trust → **Networks → Tunnels → Create a tunnel** でトークンを取得
2. `.env` の `TUNNEL_TOKEN` に貼り付け
3. 同ダッシュボードで Public hostname を設定:
   - Service: `http://api:8080`
   - 例: `reviews.example.com` (自分の Cloudflare ゾーンのドメイン)
4. 次に [Extension](../README.md#3-拡張機能のビルド) 側の `API_ORIGIN` に同じドメインを設定する

### 動作確認

```bash
docker compose up -d --build
docker compose ps              # api, db, cloudflared, backup が Up
curl https://reviews.example.com/healthz
# {"status":"ok","db":"ok"}
```

### 代替: config.yml 方式 (トークン無し)

Tunnel を Token ではなく証明書ベースで運ぶ方法は、

1. `cloudflared tunnel login` (サーバー内)
2. `cloudflared tunnel create boothreview`
3. `cloudflared tunnel route dns boothreview reviews.example.com`
4. config.yml に `service: http://api:8080` を書いて `cloudflared tunnel run` する形。
   token 方式 (ダッシュボード管理) を推奨。

## 3. 日次バックアップ

`backup` サービスが毎日 `BACKUP_TIME` (既定 03:30) に `pg_dump -Fc` を実行し、

`$BACKUP_DIR/<db名>_<日時>.dump` を作成、`BACKUP_KEEP_DAYS` 日分を保持する。

```bash
# 現在のバックアップを確認
ls -lh /mnt/backup/boothreview

# 手動実行
docker compose exec db pg_dump -U $POSTGRES_USER -Fc $POSTGRES_DB > manual_backup.dump
# (POSTGRES_USER/POSTGRES_DB は .env の値に置き換え)
```

### 復元手順

```bash
# 1) コンテナ群の停止 (DBの書き込みを止める)
docker compose stop api backup

# 2) DB内容を入れ替える (DB コンテナは生きたまま、指定DBを drop -> merge)
docker compose exec db psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
  'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

# 3) リストア
cat <latest>.dump | docker compose exec -T db pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --no-owner --clean --if-exists

# 4) 起動 (マイグレーションが起動時に再適用される)
docker compose up -d api backup
```

復元後は `curl http://127.0.0.1:$API_PORT/healthz` と最新ページの確認を推奨。

## 4. ログ

すべてのコンテナで `json-file` ドライバーに **10MB × 3世代のローテーション** を設定済み (docker-compose.yml `x-logging`)。

```bash
docker compose logs -f api     # フォロー
docker compose logs --since 1h api
```

API 自体は pino による構造化ログ (`{"level":30,"msg":"request","method":"GET",..., "path":"/v1/items/1/reviews"}`) を出す。

## 5. モニタリング (Uptime Kuma 等)

- エンドポイント: `https://reviews.example.com/healthz`
- 正常条件: HTTP 200, body に `"status":"ok"` を含む
- (サーバー内部での監視なら `http://127.0.0.1:$API_PORT/healthz` も可)

## 6. 管理 (モデレーション) 用 CLI

```bash
TOKEN=<ADMIN_TOKEN の値>
BASE=https://reviews.example.com

# 1) 一覧 (status で絞り込み、通報数が見える)
curl -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/reviews?status=published&perPage=20"

# 2) 非表示
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"status":"hidden"}' "$BASE/v1/admin/reviews/<id>"

# 3) 復活
curl -X PATCH ... -d '{"status":"published"}' "$BASE/v1/admin/reviews/<id>"

# 4) 削除 (status='deleted' として論理削除)
curl -X PATCH ... -d '{"status":"deleted"}' "$BASE/v1/admin/reviews/<id>"
```

## 7. アップデート / メンテ

```bash
git pull
docker compose up -d --build   # ビルド + マイグレーション適用 + ローリング
```

- DBスキーマを変える場合: `server/src/db/schema.ts` を編集 → `npm run db:generate` → SQL をコミット
- `restart: unless-stopped` のためサーバー再起動後も自動で立ち上がる

### 将来のVPS/Supabase移行

- `DATABASE_URL` を外部の PostgreSQL に向ける (例: `postgres://user:pass@host/db?sslmode=require`)
- `docker-compose.yml` から `db` と `backup` を外す
- 移行データはこのリポジトリの backup dump をそのまま `pg_restore` 先へ流す

## 8. トラブルシュート

| 症状 | 確認点 |
|---|---|
| `healthz` が 503 | `docker compose logs db`、DBの起動とパスワード |
|留意された cloudflared の再起動 | `docker compose logs cloudflared` — Token が正しく .env に置かれているか |
| 429 が異常に多い | `.env` のレート制限値と本拠地の IP 変動 |
| 予約POSTが 400 | `MIN_BODY_LEN` と本文の文字数、匿名IDの形式 (UUID) |
