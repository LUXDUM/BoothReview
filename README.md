# BoothReview — BOOTH 商品ページ用 第三者レビュー (Chrome拡張 + 自前サーバー)

BOOTH (booth.pm) の商品ページ上に、このサービス独自のレビューを表示・投稿できる Chrome 拡張 (Manifest V3) と、そのレビューを保存・配信するバックエンド (API / PostgreSQL / Cloudflare Tunnel / 日次バックアップ) です。

- ログイン機能はなし。匿名のUUIDだけで利用できます
- BOOTH 本体へは何も送信しません。商品情報の取得や複製・保存もせず、扱うのは商品IDだけです
- 公開 Web サイトは作りません。閲覧は拡張機能からのみで、公開しているのはプライバシーポリシー等の案内ページだけです
- 現状はテキストレビューのみ。将来の画像添付は DB 構造側で対応済みです (docs/db.md)

Chrome 拡張のソースコードは、別リポジトリの [BoothReviewExtension](https://github.com/LUXDUM/BoothReviewExtension) にあります。

```
BoothReview/
├─ server/           APIサーバ (Node 20/22 + Hono + Drizzle ORM + PostgreSQL)
├─ docs/             api.md / db.md / ops.md (運用手順)
└─ docker-compose.yml / .env.example / 本README
```

## 技術選定

### 拡張: WXT
- MV3 専用のビルドツール。manifest 自動生成・dev 自動リロード・`defineContentScript` や `defineBackground` の helper で、MV3 特有のボイラープレートが消えます
- Vite 単体 (CRXJS 等) より拡張向けの DX が良く、型も強い。本拡張は DOM 注入が主体なのでフレームワークは使いません
- 詳細は BoothReviewExtension リポジトリを参照してください

### サーバー: Node.js + Hono + Drizzle ORM
- Hono は軽量で起動が速く、セルフホストの Ubuntu Server (RAM 2GB程度) でも余裕を持って動きます。ミドルウェアは bodyLimit 程度の最小構成で、型検査が厳格でテストしやすい
- Drizzle ORM は SQL がすべてパラメータ化され、マイグレーション (drizzle-kit) 付きで型安全です。将来の VPS/Supabase への移行は `DATABASE_URL` の差し替えで済みます
- レート制限は軽量な固定窓をメモリ内に実装しています。単一 API プロセスが前提で、再起動でカウンタがリセットされる点は既知の事項です

## 1. サーバー起動 (docker compose up)

```bash
cp .env.example .env
# .env の全 "change-me" を書き換える
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Cloudflare Tunnel (docs/ops.md も参照)
# 1) Cloudflare Dash → Zero Trust → Networks → Tunnels → Create a tunnel
# 2) 発行したトークンを .env の TUNNEL_TOKEN に
# 3) Public hostname: Service http://api:8080 / 例 reviews.example.com

docker compose up -d --build
curl http://127.0.0.1:8080/healthz     # {"status":"ok","db":"ok"}
curl https://reviews.example.com/healthz   # Tunnel 経由
```

- ポートは `127.0.0.1` にのみ bind します。外部は Tunnel 経由のみで、受信ポートは開けません
- PostgreSQL は docker 内部ネットワークの外に出ません
- 日次バックアップ (`BACKUP_TIME`) の概要と復元手順は docs/ops.md、ログは全コンテナで 10MB × 3世代 のローテーションです

### 環境変数の一覧

すべての設定は [.env.example](.env.example) をコピーして使います。主要なもの:

| 変数 | 意味 |
|---|---|
| `PEPPER` | 匿名IDのハッシュ化用秘密値(運用開始後は変更不可) |
| `ADMIN_TOKEN` | 管理APIの Bearer トークン |
| `POSTGRES_*` | DBのユーザー/パスワード/DB名 |
| `MIN_BODY_LEN` / `MAX_BODY_LEN` | レビュー本文の文字数範囲 (初期 10 / 2000) |
| `REPORT_AUTOHIDE_THRESHOLD` | 通報による自動非表示の閾値 (初期 5) |
| `RATE_LIMIT_*` | IP/匿名IDごとの投稿・通報・閲覧上限 |
| `BACKUP_DIR` / `BACKUP_TIME` / `BACKUP_KEEP_DAYS` | 日次ダンプの保存先/時刻/保持日数 |

## 2. 拡張のビルドと読み込み

Chrome 拡張のソースは [BoothReviewExtension](https://github.com/LUXDUM/BoothReviewExtension) リポジトリにあります。

```bash
cd BoothReviewExtension
# 1) 自分の API ドメインを設定する (ビルド時に host_permissions に焼き込まれる)
#    src/shared/config.ts の API_ORIGIN を書き換える
npm install
npm run build        # .output/chrome-mv3 に出力
npm run test         # 商品ID抽出など純粋ロジックのテスト
npm run typecheck
```

Chrome で `chrome://extensions` を開き、デベロッパーモードで「パッケージ化されていない拡張機能を読み込む」から `.output/chrome-mv3` を選びます。BOOTH の商品ページ (`.../items/<id>`) を開くとレビューパネルが表示されます。

> URLパターンは実機で確認してください (booth.pm 直下とショップのサブドメインの両方)。対象判定は BoothReviewExtension リポジトリの `src/core/booth-dom.ts` に集約されているので、仕様変更時はこの1ファイルを直すだけで済みます。

## 3. 使い方 / API

- 閲覧: 平均評価・件数、レビュー一覧(新しい順)、「もっと見る」でページ送り
- 投稿: 星1〜5 + 本文(10〜2000文字)。同一匿名IDが同一商品に再投稿すると更新になります
- 編集・削除: 同じ匿名IDで投稿したレビューのみ
- 通報: 各レビューの「通報」から。一定数(初期5)で自動非表示
- 投稿禁止 (BAN): 管理ダッシュボードから匿名IDを禁止 (`author_blocks` テーブル)。BANされた匿名IDの投稿・編集・通報は 403
- スパム本文フィルタ: 本文に含められる URL は最大1個。同一匿名IDが32分以内に同一本文を再投稿すると 409 (別商品へのコピペ連投対策)
- バーストレート: 新規投稿は直近5分あたり IP 単位で上限 (既定2件)。自分のレビューの書き直しには適用されません
- 管理者: docs/ops.md の管理 curl (一覧検索 / 非表示・復活・削除)

詳細な API 仕様: [docs/api.md](docs/api.md)。DB設計: [docs/db.md](docs/db.md)。

## 4. セキュリティ & プライバシーの要点

- 匿名IDはサーバー側の秘密値 (PEPPER) で HMAC-SHA256 ハッシュ化し、`author_hash` にのみ保存します。生の匿名IDやそのフルハッシュが API レスポンスに含まれることはありません
- IP は `CF-Connecting-IP` から取得しますが、リクエスト元が信頼済み CIDR (docker 内部) のときだけ採用します (偽装対策)。IP はレート制限の判定だけに使い、永続保存しません
- 入力はサーバー側で厳密に検証します (型・範囲・文字数、制御文字とゼロ幅文字の除去)
- SQL は全パラメータ化、依存は最小構成、リクエストボディの上限は 64KB
- レビュー本文は拡張側で `textContent` のみで表示します (HTML として解釈しない)
- CORS は `CORS_ORIGINS` で許可したオリジンのみに限定します (既定は空 = 拡張からの通信のみを許可)

### Cloudflare Turnstile について

現時点では未導入です。Chrome 拡張から Turnstile を利用するのは、Turnstile のホスト名検証に `chrome-extension://` 起源を登録できず、MV3 の「リモートコード禁止」ポリシーとも相性が悪いため、非推奨と判断しました。

代替として、投稿・通報には IP×匿名IDのレート制限、通報の重複防止 + 自動非表示、管理APIによるモデレーションを備えています。Web サイトを公開する将来や、拡張を Chrome ウェブストアに公開する段階で再評価してください。

### 匿名IDについての既知の制約

匿名IDは拡張が生成して `chrome.storage.local` に保存しています。そのため次の場合に、過去の自分のレビューを編集・削除できなくなります (レビュー自体は残ります)。

- 別の端末や別ブラウザに拡張を入れた
- 拡張を再インストールした、または Chrome のユーザーデータを削除した
- `chrome.storage.local` を手動で消した

対策として匿名IDのエクスポート/インポート機能を将来検討しています (今回は未実装)。

### その他の既知の事項

- レート制限のカウンタはAPIプロセスのメモリ内にあり、再起動でリセットされます
- BOOTH 側の DOM/URL 変更でパネルの挿入位置が壊れる可能性があります (対象箇所は BoothReviewExtension リポジトリの `src/core/booth-dom.ts` に集中)
- 公開一覧のキャッシュは 60 秒 (`CACHE_MAX_AGE_SECONDS`) です。削除や非表示が反映されるまで最大 60 秒かかります

## 5. 開発

```bash
# サーバー (型チェック + テスト)
cd server && npm install && npm run typecheck && npm test

# 拡張は BoothReviewExtension リポジトリにて (dev モードで自動リロード)
cd BoothReviewExtension && npm install && npm run dev && npm run test

# docker で実 DB を動かす場合 (本ポート確認用)
docker compose up -d db
# .env の DATABASE_URL をローカル用に上書きして `npm run dev` (server/)
```

- APIの主要処理 (投稿/更新/削除・所有権・レート制限・通報・管理・ETag) は `server/test/routes.test.ts` が網羅しています
- 商品ID抽出と DOM アンカー選定は BoothReviewExtension リポジトリの `test/booth-dom.test.ts`

## 6. 将来の拡張 (今回は実装しない)

画像の添付 (DB構造は準備済み)、公開 Web サイト、ログイン、購入確認、匿名IDの引き継ぎ、Chrome ウェブストアへの公開、Turnstile 導入の再評価。
