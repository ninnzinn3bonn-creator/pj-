import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const teamUrl = new URL(process.argv[2] || '');
if (teamUrl.protocol !== 'https:') throw new Error('公開済みのHTTPS URLを指定してください。');
// Resume an interrupted callback without creating a duplicate GitHub App.
const resumeState = process.argv[3];
if (resumeState && !/^[a-f0-9]{48}$/.test(resumeState)) throw new Error('Invalid resume state');
const state = resumeState || randomBytes(24).toString('hex');
const port = 8792;
let completed = false;
let busy = false;
let appConfig;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const manifest = {
  name: `Project Register ${randomBytes(3).toString('hex')}`,
  url: teamUrl.origin, redirect_url: `http://127.0.0.1:${port}/callback`,
  callback_urls: [`${teamUrl.origin}/auth/callback`],
  hook_attributes: { url: `${teamUrl.origin}/unused-webhook`, active: false },
  public: false, default_permissions: { contents: 'write' }, default_events: []
};
async function configure() {
  const secrets = { GITHUB_CLIENT_ID: appConfig.client_id, GITHUB_CLIENT_SECRET: appConfig.client_secret, SESSION_SECRET: randomBytes(48).toString('base64url') };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'secret', 'bulk'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', code => code === 0 || /3 secrets successfully uploaded|Success! Uploaded 3 secrets/i.test(output) ? resolve() : reject(new Error('Cloudflareへの設定に失敗しました。ページを再読み込みすると再試行します。')));
    child.stdin.end(JSON.stringify(secrets));
  });
}
const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(403); return response.end('Forbidden'); }
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/') return response.end(`<h1>チームログイン設定</h1><p>GitHub Appを作成します。インストール先は共有データ用リポジトリだけを選択してください。</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>GitHubで作成内容を確認</button></form>`);
  if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) { response.writeHead(400); return response.end('Invalid state'); }
  if (busy) return response.end('設定処理中です。');
  try {
    busy = true;
    if (!completed) {
      if (!appConfig) {
        const code = url.searchParams.get('code');
        if (!code || !/^[a-zA-Z0-9]+$/.test(code)) throw new Error('GitHubコードがありません。');
        const result = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'project-manager-setup' } });
        if (!result.ok) throw new Error('GitHub App情報を取得できません。');
        appConfig = await result.json();
      }
      await configure();
      completed = true;
      console.log(`GitHub App configured: ${appConfig.slug}`);
    }
    response.end(`<h1>設定完了</h1><p>次にGitHub Appをインストールします。「Only select repositories」で project-manager-team-data だけを選んでください。</p><a href="https://github.com/apps/${escape(appConfig.slug)}/installations/new">インストールの承認へ</a><p><a href="${teamUrl.origin}">チーム台帳</a></p>`);
  } catch (error) { response.writeHead(500); response.end(escape(error.message)); }
  finally { busy = false; }
});
server.listen(port, '127.0.0.1', () => console.log(`Setup page: http://127.0.0.1:${port}`));
setTimeout(() => server.close(), 60 * 60 * 1000).unref();
