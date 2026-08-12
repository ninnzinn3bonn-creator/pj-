'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_CONFIG = path.join(WORKSPACE_ROOT, '.codex', 'hooks.json');
const HOOK_SCRIPT = path.join(WORKSPACE_ROOT, '.codex', 'hooks', 'project-progress-intent.js');
const PLUGIN_ROOT = path.join(WORKSPACE_ROOT, 'project-manager', 'plugin', 'project-progress-manager');
const PLUGIN_HOOK_SCRIPT = path.join(PLUGIN_ROOT, 'hooks', 'project-progress-intent.cjs');

async function runHookAt(script, prompt, overrides = {}) {
  const input = JSON.stringify({
    session_id: 'hook-test',
    turn_id: 'turn-test',
    cwd: WORKSPACE_ROOT,
    hook_event_name: 'UserPromptSubmit',
    model: 'test-model',
    permission_mode: 'default',
    prompt,
    ...overrides
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: WORKSPACE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function runHook(prompt, overrides = {}) {
  return runHookAt(HOOK_SCRIPT, prompt, overrides);
}

test('フック設定がUserPromptSubmitコマンドを参照する', async () => {
  const config = JSON.parse(await fs.readFile(HOOK_CONFIG, 'utf8'));
  const handler = config.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(handler.type, 'command');
  assert.match(handler.commandWindows, /project-progress-intent\.js/);
  await fs.access(HOOK_SCRIPT);
});

test('「進捗に反映」の完全入力だけが適用コンテキストを返す', async () => {
  const result = await runHook('進捗に反映。');
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /--apply/);
  assert.match(output.hookSpecificOutput.additionalContext, /\$project-progress-update/);

  const mentioned = await runHook('「進捗に反映」というキーフレーズを説明して');
  assert.equal(mentioned.code, 0, mentioned.stderr);
  assert.equal(mentioned.stdout, '');
});

test('「進捗を確認」はプレビュー専用コンテキストを返す', async () => {
  const result = await runHook('進捗を確認');
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /--preview/);
  assert.match(output.hookSpecificOutput.additionalContext, /書き込みは行わない/);
});

test('別イベントや不正な入力ではフックを作動させない', async () => {
  const otherEvent = await runHook('進捗に反映', { hook_event_name: 'Stop' });
  assert.equal(otherEvent.stdout, '');

  const malformed = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout }));
    child.stdin.end('{ invalid');
  });
  assert.equal(malformed.code, 0);
  assert.equal(malformed.stdout, '');
});

test('配布プラグインの概念図キーフレーズは確認と反映を分離する', async () => {
  const preview = await runHookAt(PLUGIN_HOOK_SCRIPT, '概念図を確認');
  assert.equal(preview.code, 0, preview.stderr);
  const previewContext = JSON.parse(preview.stdout).hookSpecificOutput.additionalContext;
  assert.match(previewContext, /\$project-architecture-update/);
  assert.match(previewContext, /--preview/);
  assert.match(previewContext, /書き込み.*行わない/);

  const apply = await runHookAt(PLUGIN_HOOK_SCRIPT, '概念図に反映。');
  assert.equal(apply.code, 0, apply.stderr);
  const applyContext = JSON.parse(apply.stdout).hookSpecificOutput.additionalContext;
  assert.match(applyContext, /\$project-architecture-update/);
  assert.match(applyContext, /--apply/);
  assert.match(applyContext, /進捗値の変更.*行わない/);
  assert.match(applyContext, /自動関連付け/);
  assert.match(applyContext, /手動link.*依頼しない/);

  const applyAlias = await runHookAt(PLUGIN_HOOK_SCRIPT, '概念図を反映');
  assert.equal(applyAlias.code, 0, applyAlias.stderr);
  assert.match(JSON.parse(applyAlias.stdout).hookSpecificOutput.additionalContext, /--apply/);

  const mentioned = await runHookAt(PLUGIN_HOOK_SCRIPT, '「概念図に反映」の意味を説明して');
  assert.equal(mentioned.code, 0, mentioned.stderr);
  assert.equal(mentioned.stdout, '');
});

test('配布プラグインの新規登録キーフレーズは確認と登録を分離する', async () => {
  const preview = await runHookAt(PLUGIN_HOOK_SCRIPT, '新規登録を確認');
  assert.equal(preview.code, 0, preview.stderr);
  const previewContext = JSON.parse(preview.stdout).hookSpecificOutput.additionalContext;
  assert.match(previewContext, /\$register-project/);
  assert.match(previewContext, /--preview/);
  assert.doesNotMatch(previewContext, /--apply/);
  assert.match(previewContext, /台帳への書き込み.*行わない/);
  assert.match(previewContext, /\.project-manager\.jsonの作成・変更.*行わない/);

  const apply = await runHookAt(PLUGIN_HOOK_SCRIPT, '台帳に新規登録。');
  assert.equal(apply.code, 0, apply.stderr);
  const applyContext = JSON.parse(apply.stdout).hookSpecificOutput.additionalContext;
  assert.match(applyContext, /\$register-project/);
  assert.match(applyContext, /--preview.*--apply/);
  assert.match(applyContext, /登録成功後.*\.project-manager\.json/);
  assert.match(applyContext, /既存の関連付けファイルは上書きしない/);

  const mentioned = await runHookAt(PLUGIN_HOOK_SCRIPT, '「台帳に新規登録」という操作を説明して');
  assert.equal(mentioned.code, 0, mentioned.stderr);
  assert.equal(mentioned.stdout, '');
});

test('配布プラグインにmanifestと3つのスキルが含まれる', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'project-progress-manager');
  assert.equal(manifest.version, '0.4.0');
  assert.deepEqual(manifest.interface.defaultPrompt, ['台帳に新規登録', '進捗に反映', '概念図に反映']);
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  await fs.access(path.join(PLUGIN_ROOT, 'skills', 'project-progress-update', 'SKILL.md'));
  const architectureSkill = await fs.readFile(path.join(PLUGIN_ROOT, 'skills', 'project-architecture-update', 'SKILL.md'), 'utf8');
  assert.match(architectureSkill, /name: project-architecture-update/);
  assert.match(architectureSkill, /自動関連付け|automatically linking/);
  assert.doesNotMatch(architectureSkill, /link <project-id>/);
  assert.doesNotMatch(architectureSkill, /\[TODO:/);
  const registrationSkill = await fs.readFile(path.join(PLUGIN_ROOT, 'skills', 'register-project', 'SKILL.md'), 'utf8');
  assert.match(registrationSkill, /name: register-project/);
  assert.doesNotMatch(registrationSkill, /\[TODO:/);
});
