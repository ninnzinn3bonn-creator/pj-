'use strict';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function additionalContext(action) {
  if (action === 'apply') {
    return [
      'ユーザーは入力全体を「進捗に反映」とし、このターンでプロジェクト台帳への更新を明示的に承認した。',
      'Project Progress Managerプラグインのproject-progress-updateスキルを使用すること。',
      '現在位置に対応する.project-manager.jsonを必須とし、README・ソース・設定・TODO・Git状態・テスト結果を実際に調査すること。',
      'mode=updateかつ関連付け済みproject_idのproject-status JSONを生成し、スキル付属スクリプトの--applyで検証後に1回だけ反映すること。',
      '対象を推測せず、関連付けがない場合は更新しないこと。削除操作は行わないこと。'
    ].join(' ');
  }
  return [
    'ユーザーは入力全体を「進捗を確認」とし、プロジェクト台帳向けの進捗分析とプレビューを求めている。',
    'Project Progress Managerプラグインのproject-progress-updateスキルを使用すること。',
    '実際のファイルとテスト結果からproject-status JSONを生成し、スキル付属スクリプトの--previewまで実行すること。',
    '台帳への書き込みは行わないこと。'
  ].join(' ');
}

function architectureContext(action) {
  if (action === 'apply') {
    return [
      'ユーザーは入力全体を「概念図に反映」とし、このターンでプロジェクト台帳への概念図保存を明示的に承認した。',
      'Project Progress Managerプラグインの$project-architecture-updateスキルを使用すること。',
      '現在位置に対応する.project-manager.jsonを必須とし、実際のREADME・ソース・設定・テスト・主要フローを調査すること。',
      'architecture-graph JSONを生成し、スキル付属スクリプトの--applyでプレビュー検証後に1回だけ反映すること。',
      '対象を推測せず、関連付けがない場合は保存しないこと。進捗値の変更や削除操作は行わないこと。'
    ].join(' ');
  }
  return [
    'ユーザーは入力全体を「概念図を確認」とし、関連付け済みプロジェクトの概念図分析とプレビューを求めている。',
    'Project Progress Managerプラグインの$project-architecture-updateスキルを使用すること。',
    '実際のファイルとテスト結果からarchitecture-graph JSONを生成し、スキル付属スクリプトの--previewまで実行すること。',
    '台帳への書き込みや進捗値の変更は行わないこと。'
  ].join(' ');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (payload?.hook_event_name !== 'UserPromptSubmit' || typeof payload.prompt !== 'string') return;

  const prompt = payload.prompt.trim();
  const apply = /^進捗に反映[。！!]?$/u.test(prompt);
  const preview = /^進捗を確認[。！!]?$/u.test(prompt);
  const architectureApply = /^概念図に反映[。！!]?$/u.test(prompt);
  const architecturePreview = /^概念図を確認[。！!]?$/u.test(prompt);
  if (!apply && !preview && !architectureApply && !architecturePreview) return;

  const context = architectureApply || architecturePreview
    ? architectureContext(architectureApply ? 'apply' : 'preview')
    : additionalContext(apply ? 'apply' : 'preview');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context
    }
  }));
}

main().catch(() => {
  process.exitCode = 0;
});
