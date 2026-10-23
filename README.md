# BoothReview — BOOTH 商品ページ用 第三者レビュー(Chrome拡張 + 自前サーバー)

BOOTH (booth.pm) の商品ページ上に、**このサービス独自のレビュー**を表示・投稿できる Chrome 拡張(MV3)と、
レビューを保存・配信するバックエンド(API / PostgreSQL / Cloudflare Tunnel / 日次バックアップ)です。

- ログイン機能なし(匿名・UUIDのみ)
- BOOTH 本体へは**何も送信しない**(商品情報の取得・複製・保存もしない。扱うのは商品IDだけ)
- 公開 Web サイトは作らない(閲覧は拡張機能のみ。プライバシーポリシー等の案内ページのみ公開)
- 現状はテキストレビューのみ(将来の画像添付に DB 構造は対応済み: docs/db.md)

**Chrome 拡張のソースコードは別リポジトリ [BoothReviewExtension](https://github.com/LUXDUM/BoothReviewExtension) に移設しました。**

```
BoothReview/
├─ server/           APIサーバ (Node 20/22 + Hono + Drizzle ORM + PostgreSQL)
├─ docs/             api.md / db.md / ops.md(運用手順)
├─ docker-compose.yml / .env.example / 本README
```

## 技術選定

### 拡張: WXT
- MV3 専用のビルドツール。manifest 自動生成・dev 自動リロード・`defineContentScript` / `defineBackground` の helper で MV3 特有のボイラープレートが消える。
- Vite 単体(CRXJS等)より拡張向けの DX が良く、型も強い。本拡張は DOM 注入が主体のためフレームワークは使わない。
- 詳細は BoothReviewExtension リポジトリを参照。

### サーバー: Node.js + Hono + Drizzle ORM
- **Hono**: 軽量・起動が速く、セルフホストの Ubuntu Server (RAM 2GB程度) で余裕を持って動く。ミドルウェア(bodyLimit)は最小限のみのプロジェクト。型検査が厳格でテストしやすい。
- **Drizzle ORM**: SQL はすべてパラメータ化。マイグレーション (drizzle-kit) 付きで型安全。将来的な VPS/Supabase 移行は `DATABASE_URL` 差し替えで済む。
- **Rate 制限**: 軽量の固定窓をメモリ内に実装(単一 API プロセス前提。再起動でリセットされる点は既知事項)。

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

- ポートは `127.0.0.1` にのみ bind。外部は Tunnel 経由のみで、受信ポートは開けない。
- PostgreSQL は docker 内部ネットワークの外には出ない。
- 日次バックアップ (`BACKUP_TIME`) と概要・復元手順は docs/ops.md、ログは全コンテナ 10MB × 3世代でローテーション。

### 環境変数の一覧

すべての設定は [.env.example](.env.example) をコピーして使う。主要なもの:

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

Chrome → `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」→ `.output/chrome-mv3` を選択。

BOOTH の商品ページ (`.../items/<id>`) を開くとレビューパネルが表示される。

> **URLパターンは実機で確認してください** (booth.pm 直下とショップのサブドメインの両方)。
> 対象判定は BoothReviewExtension リポジトリの `src/core/booth-dom.ts` に集約しているため、仕様変更時はこの1ファイルを直すだけです。

## 3. 使い方 / API

- 閲覧: 平均評価・件数、レビュー一覧(新しい順)、「もっと見る」でページ送り
- 投稿: 星1〜5 + 本文(10〜2000文字)。**同一匿名IDが同一商品に再投稿すると更新になる**
- 編集・削除: 同じ匿名IDで投稿したレビューのみ
- 通報: 各レビューの「通報」→ 一定数(初期5)で自動非表示
- 投稿禁止 (BAN): 管理ダッシュボードから匿名IDを禁止 (`author_blocks` テーブル)。BANされた匿名IDの投稿・編集・通報は 403
- スパム本文フィルタ: 本文の URL は最大1個。同一匿名IDが32分以内に同一本文を再投稿すると 409 (別商品へのコピペ連投対策)
- バーストレート: 新規投稿は直近5分あたり IP 単位で上限 (既定2件)。自分のレビューの書き直しには適用されない
- 管理者: `docs/ops.md` の管理 curl (= 一覧検索 / 非表示・復活・削除)

詳細な API 仕様: [docs/api.md](docs/api.md)。DB設計: [docs/db.md](docs/db.md)。

## 4. セキュリティ & プライバシーの要点

- 匿名IDはサーバー側の秘密値 (PEPPER) で HMAC-SHA256 ハッシュ化して `author_hash` にのみ保存。**生の匿名ID・そのハッシュは API レスポンスに一切含まれない**
- IP は `CF-Connecting-IP` から取得するが、**リクエスト元が信頼済み CIDR (docker 内部) のときのみ採用**(偽装対策)。IP はレート制限の判定だけに使い、永続保存しない
- 入力はサーバー側で厳密に検証(型・範囲・文字数、制御文字/ゼロ幅文字の除去)
- SQL は全パラメータ化、依存は最小構成、ボディ上限 64KB
- レビュー本文は拡張側で `textContent` のみで表示 (HTML として解釈しない)
- CORS は `CORS_ORIGINS` で許可したオリジンのみ(既定は空 = 拡張からの通信のみで供用)

### Cloudflare Turnstile について

**現時点では未導入**。Chrome 拡張から Turnstile を利用するのは、
Turnstile のホスト名検証に `chrome-extension://` 起源が載せられず、
また MV3 の「リモートコード禁止」ポリシーとの相性が悪いため、非推奨と判断しました。

代替として、投稿・通報に **IP×匿名IDのレート制限** と **通報の重複防止 + 自動非表示**、
**管理APIによるモデレーション**を備えています。Web サイトを公開する将来や、
拡張機能をChromeウェブストアに公開する段階で再評価してください。

### 匿名IDについての既知の制約 (仕様 5.2)

匿名IDは拡張が生成し `chrome.storage.local` に保存しています。そのため以下の場合に、
**過去の自分のレビューを編集・削除できなくなります**(レビュー自体は残ります)。

- 別の端末 / 別ブラウザで拡張を入れた
- 拡張の再インストール / Chrome のユーザーデータを削除した
- `chrome.storage.local` を手動で消した

対策として匿名IDのエクスポート/インポート機能を将来検討します(今回は未実装)。

### その他の既知の事項

- レート制限のカウンタはAPIプロセスのメモリ内にあり、**再起動でリセット**されます
- BOOTH 側の DOM/URL 変更でパネルの挿入位置が壊れる可能性があります(対象箇所は BoothReviewExtension リポジトリの `src/core/booth-dom.ts` に集中)
- 公開一覧のキャッシュは 60 秒(`CACHE_MAX_AGE_SECONDS`)です。削除・非表示が反映されるまで最大 60 秒かかります

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

- APIの主要処理(投稿/更新/削除・所有権・レート制限・通報・管理・ETag)は `server/test/routes.test.ts` が網羅
- 商品ID抽出 / DOM アンカー選定は BoothReviewExtension リポジトリの `test/booth-dom.test.ts`

## 6. 将来の拡張(今回は実装しない)

画像の添付(DB構造は準備済み)、公開 Web サイト、ログイン、購入確認、匿名IDの引き継ぎ、
Chrome ウェブストアへの公開、Turnstile 導入の再評価。
