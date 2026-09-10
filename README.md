# 開発プロジェクト台帳

## はじめての方へ

個人のPCで使う台帳と、チーム全員で編集する共有台帳を組み合わせて利用できます。AIへ渡す手順は、このリポジトリ内に用意しています。

**[チーム接続ポータル](https://project-manager-team.ninnzinn-3bonn.workers.dev)** · **[AI用の導入手順](docs/AI-SETUP.md)** · **[管理者の初回設定](team-worker/README.md)**

| 順番 | やること | 完了すると |
|---|---|---|
| 1 | このリポジトリをクローン | 台帳アプリがPCに入る |
| 2 | AIへ下の依頼文を送る | 起動とプラグイン導入を進められる |
| 3 | 開発プロジェクトをAIで開き「台帳に新規登録」 | ローカル一覧に登録される |
| 4 | 「進捗に反映」「概念図に反映」 | コードを分析してローカル台帳を更新できる |
| 5 | メールのワンタイムコードでログインし、ローカル台帳を接続 | 個人用と共有プロジェクトが同じ一覧に表示される |

```powershell
git clone https://github.com/ninnzinn3bonn-creator/pj-.git
cd pj-
```

クローンしたフォルダをCodexまたはClaude Codeで開き、次を送ってください。

```text
このプロジェクトを私のPCにセットアップしてください。
AGENTS.md / CLAUDE.md と docs/AI-SETUP.md を読み、順番に実行してください。
ローカル台帳の起動、私が使っているAIのプラグイン導入、動作確認まで進めてください。
既存のデータと設定は保持し、ログイン・アクセス許可が必要な箇所だけ私に操作を求めてください。
チーム接続も希望します。未完了の項目を完了扱いにせず、実測した確認結果を報告してください。
```

個人用台帳はログイン不要で、ローカルだけでもすべての基本機能を利用できます。チーム共有を使う人だけが接続ポータルへメールのワンタイムコードでログインします。初回ログイン時には本人専用チームが自動作成され、別のチーム作成・切り替え・メンバー追加もポータルから行えます。

Claude Codeでは**プラグイン（スキル＋フック）**として導入します。Codex用とは別の形式を準備スクリプトが生成します。既存の進捗更新はローカル向けで、チームへの送信は共有ボタンまたは共有CLIから行います。

> 接続ポータルのURLは公開されていますが、プロジェクト一覧は表示しません。共有データはCloudflare Accessのメール認証とチームメンバー照合を通過したローカル台帳だけがD1から取得できます。

## アプリについて

チーム共有版を追加しました。個人用データを維持したまま、選択したプロジェクトをチーム全員へ共有できます。セットアップは [チーム共有版の手順](team-worker/README.md) を参照してください。

複数のアプリ、Webアプリ、開発プロジェクトを、Web画面・CLI・Codexから一元管理するローカルアプリです。Codexからの新規登録や進捗更新に加えて、コードから生成した概念図（アーキテクチャ図）をプロジェクトごとに保存・閲覧できます。

ローカル台帳は外部CDNや外部フォントを使わず、Node.js標準機能だけで動作します。個人データはローカルJSON、明示的に共有したデータはCloudflare D1へ保存します。

## 必要環境

- Node.js 22または24（`.node-version`は24）
- Windows 10または11（ランチャー利用時）
- Edge、Chrome、Firefoxなどの新しいブラウザ

## Windowsですぐ起動する

1. `start.bat`をダブルクリックします。
2. サーバーがバックグラウンドで起動し、ブラウザで台帳が開きます。
3. 終了するときは`stop.ps1`を右クリックし、PowerShellで実行します。

標準ポートは4170です。使用中の場合は4171～4180から空きポートを自動選択します。選択したポートは`data/server.port`へ保存されます。

手動起動もできます。

```powershell
npm install
npm start
```

ブラウザで `http://localhost:4170` を開いてください。

サーバーは常に`127.0.0.1`へ待ち受けます。`HOST`環境変数を変更してもLANやインターネットには公開されません。ブラウザからの変更APIは同一Originだけを受け付け、CLIはlocalhostの管理URLだけへ接続します。

## 主な機能

- プロジェクトの登録、編集、削除、検索、絞り込み
- 進捗率、状態、現在の作業、次の作業、課題、更新履歴の管理
- アプリURL、管理者サイトURL、リポジトリURL、開発URLの管理
- `project-status` JSONのプレビューと反映
- プロジェクトIDのコピー
- バックアップJSONの書き出し、確認、復元
- プロジェクト別の概念図JSONの保存と閲覧
- 概念図の検索、フィルター、フロー強調、ズーム、パン、詳細表示

プロジェクト詳細の「概念図を作成／見る」から、専用画面 `#/project/{projectId}/architecture` を開けます。概念図がない場合はCodex用プロンプトのコピーまたはJSON読込を選べます。

## CLI

このフォルダーではWindows用ラッパーを利用できます。

```powershell
.\project-manager.cmd doctor
.\project-manager.cmd list
.\project-manager.cmd show local-project-register
```

任意のフォルダーから`project-manager`として使う場合は、一度次を実行します。

```powershell
npm link
```

対象リポジトリを台帳のプロジェクトへ関連付けます。

```powershell
project-manager link <project-id> --url http://127.0.0.1:4170
```

これにより対象フォルダーへ`.project-manager.json`が作成されます。CodexスキルとCLIは、この関連付けと異なるプロジェクトIDへの反映を拒否します。

関連付けの保存先は実体パスで確認したProject Root直下に固定されます。シンボリックリンクの`.project-manager.json`は拒否し、Codexの3スキルは用意された固定ランナー以外でファイルやGit状態を変更しません。

Windows、特にWindows PowerShell 5.1では、日本語を含むJSONは`--file`で渡すことを推奨します。標準入力を使う場合は、ネイティブコマンドへ渡す文字コードを先にUTF-8へ設定してください。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

### 進捗JSON

```powershell
project-manager preview --file status.json
project-manager apply --file status.json
Get-Content -Raw -Encoding UTF8 status.json | project-manager apply --stdin
```

### 概念図JSON

```powershell
project-manager architecture status
project-manager architecture show
project-manager architecture preview --file architecture.json
project-manager architecture apply --file architecture.json
Get-Content -Raw -Encoding UTF8 architecture.json | project-manager architecture apply --stdin
project-manager architecture export --output architecture.json
```

Web画面の概念図ページでは「空の概念図を作成」からJSONテンプレートを生成し、その場で貼り付け・編集して内容確認後に保存できます。初期テンプレートは`human-stack-battle-20260715`を基準に、左→右レイアウトと`Actors / Client / Services / Data / Operations`のグループ順を使用します。

`apply`は必ずサーバー側のプレビューを通してから保存します。同じ内容の再送、異なるプロジェクトID、古いrevisionによる競合を検出します。

概念図スキルは、登録済みプロジェクトの`.project-manager.json`が未作成でも、台帳と対象IDを検証して適用時に自動関連付けします。新規概念図と継続更新は同じ「概念図に反映」（または「概念図を反映」）操作で完了します。

### 新規登録JSON

プラグイン同梱の登録ランナーは、`mode=create`の`project-status` JSONを台帳へ登録し、成功後に対象ルートを関連付けます。

```powershell
$runner = ".\plugin\project-progress-manager\skills\register-project\scripts\register-project.mjs"
node $runner --preview --file status.json --url http://127.0.0.1:4170 --root "<project-root>"
node $runner --apply --file status.json --url http://127.0.0.1:4170 --root "<project-root>"
```

`--file`を省略すると標準入力を使用でき、`--request-id <id>`も指定できます。プレビューでは台帳と`.project-manager.json`を変更しません。適用時は既存の関連付けがあれば登録前に中止し、上書きしません。新しい`.project-manager.json`は台帳登録の成功後にだけ原子的に作成されます。登録後に関連付け作成が失敗した場合は、機械可読エラーの`registrationSucceeded`と`recoveryLink`に従って復旧し、同じ登録を再送しないでください。

## Codexプラグイン

配布可能なプラグインソースは`plugin/project-progress-manager`にあります。次の3つのスキルを含みます。

- `register-project`
  - `新規登録を確認`: 実ファイルを分析し、保存せず登録内容をプレビュー
  - `台帳に新規登録`: 重複と関連付けを検証後、台帳へ登録して関連付け
- `project-progress-update`
  - `進捗を確認`: 実ファイルを分析し、保存せずプレビュー
  - `進捗に反映`: 分析・検証後に台帳へ反映
- `project-architecture-update`
  - `概念図を確認`: 実ファイルを分析し、概念図JSONをプレビュー
  - `概念図に反映`: 分析・検証後に概念図を台帳へ反映

3つのスキルはいずれも対象プロジェクト内のREADME、ソースコード、設定、TODO、テスト、Git状態を実際に確認します。進捗と概念図は`.project-manager.json`で関連付けられた台帳だけを更新し、新規登録は成功後にその関連付けを安全に作成します。

## 保存データ

```text
data/
  projects.json
  projects.json.bak
  artifacts/
    <project-id>/
      architecture.json
      architecture.json.bak
```

概念図をプロジェクト一覧JSONへ埋め込まないため、概念図が増えても一覧取得は重くなりません。プロジェクト一覧と概念図は`temp → rename`で原子的に置き換え、既存データを更新する直前に`.bak`へ1世代だけ保存します。

バックアップ形式v2はプロジェクトと概念図を含みます。従来のv1バックアップも概念図なしとして読み込めます。

保存データには形式バージョンがあります。プロジェクト一覧は`schemaVersion: 1`、概念図本体は`schema_version: 1`、概念図保存エンベロープは`storageSchemaVersion`で互換性を検証します。

`data`内の実データ、ログ、PID、ポート情報、`.project-manager.json`はGit管理対象外です。

## テスト

```powershell
npm test
npm run test:server
npm run test:integration
npm run test:fresh-clone
```

サーバーAPI、CLI、Codexスキル、フック、冪等性、バックアップ、Windowsランチャーを一括確認します。

`test:fresh-clone`は現在のGitリモートとブランチをOSの一時フォルダーへ新規クローンし、`npm ci`、全テスト、初回起動、手動登録、スキル登録、関連付け確認までを実行します。成功時は検証用フォルダーを安全確認後に削除し、失敗時は調査できるよう保持します。

## GitHub Release

配布版は`v1.1.0`のようなタグをpushすると、GitHub ActionsがNode.js 22と24の両方で全テストを実行し、成功時だけZIP付きGitHub Releaseを作成します。利用者はReleaseのZIPを展開し、Node.js 22または24で`start.bat`を起動してください。実データと`.project-manager.json`はGitに含まれません。

## 公開時の注意

このアプリは信頼できる1台のPC内での利用を想定しています。認証、HTTPS、利用者ごとの権限管理は備えていません。localhost限定を解除したり、リバースプロキシ経由でLAN・インターネットへ公開したりしないでください。
