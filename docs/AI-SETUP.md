# AI向けセットアップ手順（Codex / Claude Code）

このファイルは、利用者が「このアプリをセットアップして」と依頼した際の実行手順です。各チェックポイントを順番に実行し、実際の結果を確認してください。ログイン・権限承認を本人に代わって完了したと推測しないでください。

## 0. 対象と前提を確認する

- 台帳アプリのクローン先を絶対パスで確定する。README、package.json、Git状態を読む。
- `node --version` は22または24。Gitと、利用者が使う `codex` または `claude` のCLIが必要。CLIがない場合は公式の導入方法を案内し、その工程を未完了と記録する。
- 登録する開発プロジェクトのフォルダは台帳のクローン先とは別の場合がある。対象を取り違えない。
- 新規利用者はmainをクローンする。既存クローンは `git status --short` を確認し、変更があれば保護してから `git pull --ff-only`。`reset --hard`、`clean`、force pushは禁止。
- 通常のチームメンバーはCloudflareへのデプロイ、GitHub App作成、秘密鍵設定を行わない。

## 1. ローカル台帳を起動する

台帳クローン先で実行:

```powershell
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1
```

`launch.ps1` の利用可能な引数はファイルを確認する。起動に失敗した場合はエラーを調べてから再試行し、同じポートに別サーバーを重ねて起動しない。

`data/server.port` があればそのポートを読む。なければ4170〜4180の `/api/health` と `/api/meta` を確認する。互換サービスが一つだけあることを確かめ、実際のURLを記録する。複数見つかった場合は対象を利用者に確認する。

```powershell
node bin/project-manager.js doctor --url http://127.0.0.1:<実際のポート> --json
```

合格条件: health、meta、CLI doctorが成功し、ブラウザで一覧を開ける。既存データを初期化しない。

## 2. AI用プラグインを準備・インストールする

```powershell
node scripts/prepare-plugins.cjs
```

生成先は `distribution/codex` と `distribution/claude`。同じソースからホスト別のmanifestとhookを作る。元の `plugin/project-progress-manager` は変更しない。

### Codex

まず `codex plugin --help` と `codex plugin marketplace add --help` を確認する。対応CLIで次を実行する（相対パスは台帳クローン先基準）。

```powershell
codex plugin marketplace add ./distribution/codex
codex plugin add project-progress-manager@project-manager-local
codex plugin list
```

既に同名marketplaceが別フォルダを参照している場合は、設定を上書きせず、`codex plugin marketplace list` で参照先を調べて対応する。導入後は新しいタスクを開いてスキルが表示されるか確認する。

### Claude Code

`claude plugin --help` を確認して実行:

```powershell
claude plugin marketplace add ./distribution/claude
claude plugin install project-progress-manager@project-manager-local --scope user
claude plugin list
```

Claude Code内なら `/plugin marketplace add <distribution/claudeの絶対パス>`、`/plugin install project-progress-manager@project-manager-local` も使える。再起動後、`/project-progress-manager:register-project`、`/project-progress-manager:project-progress-update`、`/project-progress-manager:project-architecture-update` を確認する。自動選択されない場合はこの名前で明示的にスキルを呼ぶ。

合格条件: インストール一覧に表示され、新規セッションで3つのスキルを認識する。設定ファイルへコピーしただけで合格にしない。Claude CodeがこのPCにない場合は「配布形式検証済み・Claude Code実機未検証」と報告する。

## 3. 開発プロジェクトを新規登録する

利用者が登録したい開発プロジェクトをAIで開く。既存の `.project-manager.json` があれば、新規登録せず紐付け先を検証する。

初回は「新規登録を確認」で実ファイル・テスト・Git状態を分析し、プレビューする。利用者が登録を依頼済みなら「台帳に新規登録」に対応する同梱runnerの `--apply` を実行する。スキルの `SKILL.md` を全文読んでから引数を組み立てる。IDを推測して既存プロジェクトを上書きしない。

合格条件: CLI showで対象IDが取得でき、対象フォルダの `.project-manager.json` のID・URLが一致する。続いて「進捗を確認」のプレビューが成功する。差分なしは正常であり、テストのために偽の進捗を記録しない。

概念図は「概念図に反映」で作成・更新できる。未登録のプロジェクトは先に新規登録する。

## 4. チームへ接続する

チームサイト: https://project-manager-team.ninnzinn-3bonn.workers.dev

1. 管理者がチーム接続ポータルのメンバー管理で、利用者のGitHubユーザー名を追加していることを確認する。
2. チームサイトで本人のGitHubアカウントにログインする。管理者用Client secretやSESSION_SECRETをメンバーへ配らない。
3. 「接続情報を表示」で本人用の接続トークンを取得する。
4. ローカル台帳の「台帳ツール → チーム連携設定」へURLとトークンを入力し、接続確認を行う。トークンをチャット、Git、プロジェクトJSONに記録しない。
5. ローカル一覧の「チームと同期」で、共有プロジェクトが同じ一覧に色付きで表示されることを確認する。
6. 利用者が指定したローカルプロジェクトだけ「チームへ共有」を実行する。以後は共有行の編集がrevision付きでD1へ反映される。

HTTP 503で「設定中」の場合は管理者のGitHub App設定待ち。401はログイン期限切れ、403は権限・Originを調べる。ポートが4170以外なら管理者が許可Originへ追加する必要がある。本人が許可していないリポジトリへ接続先を変更しない。

## 5. 日常の更新

「進捗に反映」はローカル台帳の更新。「概念図に反映」はローカル概念図の更新。共有開始は明示的な共有ボタン、または `team-worker/scripts/team-cli.mjs` を使う。共有済みプロジェクトは同じローカル一覧へ取り込まれ、編集時にD1へrevision付きで反映される。

CLI共有は `PROJECT_MANAGER_TEAM_URL` と `PROJECT_MANAGER_TEAM_TOKEN` がプロセス環境にあるときに実行する。GUIに保存した接続情報はCLIへ自動転送されない。読み取り `list` → 内容比較 → `share <JSON> <確認済みrevision>` の順。409で最新revisionだけ取り直して同じJSONを送信しない。最新の他メンバーの変更を取り込んだJSONを作るか、利用者へ差分を提示する。

## 6. 完了報告

次を実測値で報告する: ローカルURL、台帳バージョン、AIホストとプラグインのインストール結果、登録したID、進捗プレビュー結果、チームへの認証結果、共有結果、残っている本人操作。認証未完了・未インストール・未実機検証を「完了」に含めない。

## 更新・復旧

アップデート前に `data/` 全体を別フォルダへコピーする。Git pullでユーザーデータを削除しない。プラグインの更新は準備スクリプトを再実行し、各CLIのmarketplace更新コマンドを `--help` で確認して適用する。利用者のグローバル設定全体を置き換えない。

参考: [Codex plugins](https://developers.openai.com/codex/plugins)、[Claude Code marketplace](https://code.claude.com/docs/en/plugin-marketplaces)、[Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
