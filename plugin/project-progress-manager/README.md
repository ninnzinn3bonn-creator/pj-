# Project Progress Manager

Codexから開発プロジェクトの実態を調査し、ローカルのプロジェクト管理台帳へ進捗と概念図を安全に反映する個人用プラグインです。

## キーフレーズ

- `進捗を確認`: リポジトリを分析し、更新内容をプレビューします。
- `進捗に反映`: リポジトリを再分析し、検証済みの更新を台帳へ反映します。
- `概念図を確認`: リポジトリを分析し、概念図JSONを検証・プレビューします。
- `概念図に反映`: リポジトリを再分析し、検証済みの概念図を台帳へ反映します。

## プロジェクトの関連付け

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
```

標準入力も利用できますが、Windows PowerShell 5.1ではネイティブコマンドへ渡す前に`$OutputEncoding`をUTF-8へ設定してください。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 "<status.json>" | node "<skill-dir>\scripts\update-project.mjs" --preview
```
