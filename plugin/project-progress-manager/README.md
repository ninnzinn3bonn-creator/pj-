# Project Progress Manager

Codexから開発プロジェクトの実態を調査し、ローカルのプロジェクト管理台帳への新規登録、進捗更新、概念図更新を安全に行う個人用プラグインです。

## キーフレーズ

- `新規登録を確認`: リポジトリを分析し、新規登録内容を保存せずプレビューします。
- `台帳に新規登録`: リポジトリを再分析し、検証済みのプロジェクトを台帳へ登録して関連付けます。
- `進捗を確認`: リポジトリを分析し、更新内容をプレビューします。
- `進捗に反映`: リポジトリを再分析し、検証済みの更新を台帳へ反映します。
- `概念図を確認`: リポジトリを分析し、概念図JSONを検証・プレビューします。
- `概念図に反映`: リポジトリを再分析し、検証済みの概念図を台帳へ反映します。

## 新規登録ランナー

`mode=create`の`project-status` JSONを用意すると、新規登録スキルと同じ安全確認をCLIでも実行できます。`--root`は登録対象のプロジェクトルートです。省略時は現在位置を使用します。

```powershell
$runner = "$env:USERPROFILE\plugins\project-progress-manager\skills\register-project\scripts\register-project.mjs"
node $runner --preview --file "<status.json>" --url http://127.0.0.1:4170 --root "<project-root>"
node $runner --apply --file "<status.json>" --url http://127.0.0.1:4170 --root "<project-root>"
```

`--file`を省略した場合は標準入力からJSONを受け取ります。必要に応じて`--request-id <id>`も指定できます。`--preview`は台帳と関連付けファイルのどちらにも書き込みません。

`--apply`は登録前に`<project-root>/.project-manager.json`が存在しないことを確認します。既存ファイルは内容が一致していても上書きせず、台帳へ送信する前に中止します。新しい関連付けはサーバーで登録が成功した後にだけ一時ファイルから原子的に作成します。サーバー登録後に関連付けの作成だけが失敗した場合は、`registrationSucceeded`と`recoveryLink`を含むエラーに従って復旧し、登録を再送しないでください。

ステータスは`idea`、`planning`、`development`、`testing`、`release_ready`、`published`、`update_pending`、`blocked`、`paused`、`archived`へ正規化されます。`in_progress`、`completed`、`release-ready`、一般的な日本語ラベルも受け付け、保存時は正規の値になります。

## 既存プロジェクトの関連付け

管理サイトを起動してから、対象プロジェクトのルートで次を実行します。

```powershell
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" link <project-id> --url http://127.0.0.1:4170
```

これにより `.project-manager.json` が作成されます。スキルは現在位置から上位へこのファイルを検索し、対象IDを推測せずに更新します。

## CLI

```powershell
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" doctor
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" list
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" show <project-id>
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" architecture status <project-id>
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" architecture show <project-id>
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" architecture export <project-id> --output architecture.json
```

管理サイトが停止している場合、CLIは自動起動せず、接続エラーを返します。

## WindowsでJSONを送信する

日本語を含むJSONはUTF-8で保存し、各スキルの同梱スクリプトへ`--file`で渡してください。特にWindows PowerShell 5.1では、標準入力より`--file`を推奨します。

```powershell
node "<skill-dir>\scripts\update-project.mjs" --preview --file "<status.json>"
node "<skill-dir>\scripts\update-architecture.mjs" --preview --file "<architecture.json>"
node "<register-skill-dir>\scripts\register-project.mjs" --preview --file "<status.json>" --root "<project-root>"
```

標準入力も利用できますが、Windows PowerShell 5.1ではネイティブコマンドへ渡す前に`$OutputEncoding`をUTF-8へ設定してください。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 "<status.json>" | node "<skill-dir>\scripts\update-project.mjs" --preview
```
