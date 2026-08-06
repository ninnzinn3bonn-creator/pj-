'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');

async function runPowerShell(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', arguments_, {
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Windowsランチャーが黒いサーバー画面なしで起動しヘルスチェックに成功する', {
  skip: process.platform !== 'win32'
}, async () => {
  const result = await runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(APP_ROOT, 'launch.ps1'),
    '-NoBrowser'
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);

  const port = (await fs.readFile(path.join(APP_ROOT, 'data', 'server.port'), 'utf8')).trim();
  assert.match(port, /^\d+$/);
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.service, 'local-project-manager');
  assert.equal(health.status, 'ok');

  const startBatch = await fs.readFile(path.join(APP_ROOT, 'start.bat'), 'utf8');
  assert.match(startBatch, /launch\.ps1/);
  assert.doesNotMatch(startBatch, /npm start/);
});
