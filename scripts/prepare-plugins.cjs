'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function json(filename, data) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, JSON.stringify(data, null, 2) + '\n');
}
async function main() {
  const source = path.join(root, 'plugin', 'project-progress-manager');
  for (const host of ['codex', 'claude']) {
    const destination = path.join(root, 'distribution', host, 'plugins', 'project-progress-manager');
    await fs.mkdir(destination, { recursive: true });
    await fs.cp(source, destination, { recursive: true });
    if (host === 'codex') {
      const marketplace = JSON.parse(await fs.readFile(path.join(root, 'templates/codex-marketplace.json'), 'utf8'));
      await json(path.join(root, 'distribution/codex/.agents/plugins/marketplace.json'), marketplace);
    } else {
      await json(path.join(destination, '.claude-plugin/plugin.json'), { name: 'project-progress-manager', version: '0.4.0', description: 'Register projects and update verified progress and architecture in the local project register.' });
      await json(path.join(root, 'distribution/claude/.claude-plugin/marketplace.json'), { name: 'project-manager-local', owner: { name: 'Project Manager' }, plugins: [{ name: 'project-progress-manager', source: './plugins/project-progress-manager', description: 'Local project register skills' }] });
      await json(path.join(destination, 'hooks/hooks.json'), { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/project-progress-intent.cjs"', timeout: 10 }] }] } });
    }
  }
  console.log(JSON.stringify({ codex: path.join(root, 'distribution/codex'), claude: path.join(root, 'distribution/claude') }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
