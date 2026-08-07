# 開発プロジェクト台帳

複数のアプリ、Webアプリ、開発プロジェクトを、Web画面・CLI・Codexから一元管理するローカルアプリです。Codexからの新規登録や進捗更新に加えて、コードから生成した概念図（アーキテクチャ図）をプロジェクトごとに保存・閲覧できます。

外部CDN、外部フォント、データベースは使用しません。Node.js標準機能だけで動作し、データはローカルJSONへ保存します。

## 必要環境

- Node.js 18以上
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

`apply`は必ずサーバー側のプレビューを通してから保存します。同じ内容の再送、異なるプロジェクトID、古いrevisionによる競合を検出します。

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
  artifacts/
    <project-id>/
      architecture.json
```

概念図をプロジェクト一覧JSONへ埋め込まないため、概念図が増えても一覧取得は重くなりません。書込みは一時ファイルを利用し、概念図単位で置き換えます。

バックアップ形式v2はプロジェクトと概念図を含みます。従来のv1バックアップも概念図なしとして読み込めます。

`data`内の実データ、ログ、PID、ポート情報、`.project-manager.json`はGit管理対象外です。

## テスト

```powershell
npm test
npm run test:server
npm run test:integration
```

サーバーAPI、CLI、Codexスキル、フック、冪等性、バックアップ、Windowsランチャーを一括確認します。

## 公開時の注意

このアプリは信頼できるPCまたはプライベートLANでの利用を想定しています。初期状態では認証、HTTPS、利用者ごとの権限管理を備えていません。ルーターのポート開放やインターネットへの直接公開は行わないでください。
