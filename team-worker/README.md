# チーム同期サービス

公開URL: https://project-manager-team.ninnzinn-3bonn.workers.dev

Cloudflare Workerを認証付きAPI、D1を共有データの正本として使います。個人用台帳はログイン不要です。チーム機能を選んだ人だけがメール認証し、本人専用チームの作成、複数チームの切り替え、メンバー管理を行えます。公開URLにはプロジェクト一覧を表示しません。

通常のメンバーは [AI用導入手順](../docs/AI-SETUP.md) を利用してください。CloudflareへのデプロイやAccess設定は管理者だけが行います。

## 管理者の初回設定

1. `wrangler.jsonc`の`TEAM_SLUG`、`TEAM_NAME`、`TEAM_ADMIN_EMAIL`を設定します。
2. `npx wrangler d1 create <database-name>`でD1を作り、`DB` bindingへdatabase IDを設定します。
3. `npm ci`と`npx wrangler login`を実行します。
4. `npx wrangler d1 migrations apply <database-name> --remote`でマイグレーションを適用します。
5. `SESSION_SECRET`を`npx wrangler secret put`で設定します。秘密値をGitへ保存しません。
6. Cloudflare Accessで`<Worker URL>/auth/access`だけを保護し、許可メールとOne-time PINを設定します。
7. AccessのチームドメインとApplication Audienceを`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`へ設定します。
8. `npm run deploy`で公開します。

## 既存GitHub共有データの移行

旧版の非公開GitHub JSONがある場合、D1へ非破壊で取り込めます。既存D1行は上書きしません。

```powershell
node scripts/migrate-github-to-d1.mjs
```

移行後もGitHubリポジトリは削除せず、読み取り専用の退避データとして残してください。

## メンバーと認証

既存`my-team`の最初の管理者は`TEAM_ADMIN_EMAIL`と一致するメール利用者です。それ以外の利用者は初回ログイン時に本人専用チームが作成され、そのチームの管理者になります。各管理者はポータルからメンバーのメールアドレスを追加・解除できます。

WorkerのURLを知っているだけでは共有データを取得できません。未ログインは401、チーム外ユーザーは403、変更APIの許可Origin不一致も403になります。接続トークンは最長7日です。

## 同期と競合

ローカル台帳は個人JSONをそのまま保持します。共有一覧はD1から取得して同じ画面へ合成し、取得失敗時はブラウザに保存した最後の共有キャッシュを表示します。

共有プロジェクトはプロジェクト単位の整数`revision`で更新します。古いrevisionによる更新は409で拒否され、最新データを返します。別メンバーの変更を確認せずに強制上書きしません。概念図はプロジェクト本体と別テーブルへ保存します。

CLIでは従来のコマンドを利用できます。

```powershell
node scripts/team-cli.mjs list
node scripts/team-cli.mjs share status.json
node scripts/team-cli.mjs share status.json <確認済みrevision>
```

## 検証と運用

```powershell
npm test
npm run types
npm run deploy:check
```

D1はTime Travelによる復元が利用できます。本番移行前後には旧GitHub JSONとD1のプロジェクト数・ID・概念図数を照合し、ローカル`data/`は変更・削除しません。
