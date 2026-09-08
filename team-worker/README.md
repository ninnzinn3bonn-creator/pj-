# チーム共有版

公開URL: https://project-manager-team.ninnzinn-3bonn.workers.dev

通常のメンバーは [AI用導入手順](../docs/AI-SETUP.md) を利用してください。以下は管理者だけが実施する手順です。このリポジトリのCloudflare account_idと共有先は管理者の設定なので、別チームで独立運用する場合は自身のものへ変更してください。

## 管理者向けの承認アシスタント

Workerを配置した後、`node scripts/setup-github-app.mjs <公開HTTPS URL>` を実行すると、`http://127.0.0.1:8792` に初回設定ページが開きます。GitHubで作成を承認すると、発行されたClient ID・Client secretとランダムなセッション鍵をCloudflare secretsへ送信します。秘密値をチャットやGitへコピーする必要はありません。続いてGitHub Appを共有データ用リポジトリだけにインストールしてください。

このツールは初回専用です。すでに設定済みの場合は実行せず、既存Appの管理画面から設定を確認してください。ローカル補助サーバーは1時間で終了します。GitHub App作成後、コールバック処理の前に補助サーバーだけが停止した場合は、コールバックURLの `state` を第2引数として同じコマンドを再実行し、元のコールバックURLを再読み込みできます。Appを重複作成しないでください。

```powershell
node scripts/setup-github-app.mjs <公開HTTPS URL> <元のstate>
```

既存のローカル台帳に追加するCloudflare Workers製のチームサイトです。個人用のデータや設定を移行・削除する処理はありません。共有するプロジェクトを選び、非公開GitHubリポジトリに保存します。メンバー全員に閲覧・編集権限を付けます。

## 管理者の初回設定

1. アプリのソースとは別に、**非公開**のデータリポジトリを作成し、README付きでmainブランチを初期化します。チーム全員をWrite権限で招待してください。
2. GitHub Appを作成します。Repository permissionsのContentsをRead and writeにし、データリポジトリだけにインストールしてください。Webhookは不要です。ログインのCallback URLは `https://<チームサイト>/auth/callback` です。
3. `wrangler.jsonc` の `GITHUB_REPOSITORY`、`GITHUB_BRANCH`、`TEAM_SLUG` を設定します。ローカル台帳のポートが4170以外なら `ALLOWED_LOCAL_ORIGINS` に実際のOriginを追加します。
4. このディレクトリで `npm ci`、`npx wrangler login` を実行します。次の値は `npx wrangler secret put <名前>` で設定してください。値をGitへコミットしないでください。
   - `GITHUB_CLIENT_ID`: GitHub AppのClient ID
   - `GITHUB_CLIENT_SECRET`: GitHub AppのClient secret
   - `SESSION_SECRET`: 暗号学的にランダムな32文字以上の秘密値
5. `npm run deploy` でデプロイし、GitHub AppのCallback URLを実際のサイトURLに合わせます。

セッションはGitHubトークンの期限内、最長7日です。期限切れでは再ログインします。メンバーを外す場合はデータリポジトリのアクセスを解除してください。共有データの読み書きごとにアクセスを確認します。

## 利用方法

チームサイトでGitHubログインし「ローカル台帳と接続」を選びます。ローカル台帳の「台帳ツール → チーム連携設定」にURLと接続トークンを入力し、プロジェクト詳細の「チームへ共有・更新」を押してください。

進捗、タスク、URLなどが共有されます。個人用履歴とプロジェクトフォルダ設定は共有されません。概念図は追加確認で選択した場合に共有します。概念図内のパスや説明に共有したくない情報がないか確認してください。

チームサイトでは一覧の再読み込みで最新情報を取得し、編集・概念図閲覧ができます。共有後のローカル変更は共有ボタンを押した時に送信します。チームでの変更はローカルへ自動適用しません。競合時は上書きを止め、チームサイトで最新の内容を読み込んで再編集します。GitHubのコミット履歴から変更を追跡できます。

## CLI / Codexからの共有

固定CLIを利用できます。認証情報は環境変数 `PROJECT_MANAGER_TEAM_URL` と `PROJECT_MANAGER_TEAM_TOKEN` に設定します。トークンをプロジェクトのJSONやスキルへ保存しないでください。

```powershell
node team-worker/scripts/team-cli.mjs list
node team-worker/scripts/team-cli.mjs share status.json
node team-worker/scripts/team-cli.mjs share status.json <確認済みのrevision>
```

新規共有はrevisionなし、更新は一覧取得で確認したrevisionを指定します。JSONはローカルAPIのcamelCase形式またはproject-statusのsnake_case形式です。概念図は `architecture` フィールドに指定できます。競合時はCLIが失敗終了し、最新内容を返します。最新revisionだけを自動で取り直して再送せず、内容を比較して更新JSONを作り直してください。

既存の「進捗に反映」スキルは従来どおりローカルを更新します。チーム共有まで行う場合は、このCLIへの明示的な共有操作を追加してください。

## 検証と運用

```powershell
npm test
npm run deploy:check
```

テストはモックGitHubで認証、競合、同時登録、期限切れを確認します。本番導入時には別々のGitHubアカウント3つでログイン・共有・編集・競合・メンバー解除を確認してください。

保存先は `teams/<TEAM_SLUG>/projects.json`（schemaVersion: 1）です。ファイルSHAによる競合検知と、プロジェクトrevisionによる古い内容の上書き防止を行います。大人数・高頻度更新向けではありません。GitHub APIのレート制限に達した場合は時間を置いて再試行します。データリポジトリを公開に変更するとAPIはアクセスを拒否します。

既存ローカル台帳へのロールバックは、旧バージョンで起動するだけです。チーム側のデータはGitHubに残ります。ローカルの `data` ディレクトリはアップデート前に別フォルダへバックアップしておくと復元できます。
