import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

function runDeploy(databaseExists, failMigration = false) {
  const directory = mkdtempSync(join(tmpdir(), 'derekflare-deploy-'));
  const script = join(directory, 'scripts', 'deploy.mjs');
  const wrangler = join(directory, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const log = join(directory, 'commands.log');
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(dirname(wrangler), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url)), script);
  writeFileSync(wrangler, `const fs = require('node:fs');
const command = process.argv.slice(2).join(' ');
fs.appendFileSync(process.env.COMMAND_LOG, command + '\\n');
if (command === 'd1 list --json') process.stdout.write(process.env.DB_EXISTS === 'true' ? '[{"name":"dns-delegation-panel"}]' : '[]');
if (command === 'd1 migrations apply DB --remote' && process.env.FAIL_MIGRATION === 'true') process.exit(1);
`);
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        COMMAND_LOG: log,
        DB_EXISTS: String(databaseExists),
        FAIL_MIGRATION: String(failMigration),
      },
    });
    return { result, commands: readFileSync(log, 'utf8').trim().split('\n') };
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true });
  }
}

it('provisions D1 once, then migrates before the final deployment', () => {
  const { result, commands } = runDeploy(false);
  expect(result.status).toBe(0);
  expect(commands).toEqual(['d1 list --json', 'deploy', 'd1 migrations apply DB --remote', 'deploy']);
});

it('migrates before deployment when D1 already exists', () => {
  const { result, commands } = runDeploy(true);
  expect(result.status).toBe(0);
  expect(commands).toEqual(['d1 list --json', 'd1 migrations apply DB --remote', 'deploy']);
});

it('does not deploy new code after a migration failure', () => {
  const { result, commands } = runDeploy(true, true);
  expect(result.status).not.toBe(0);
  expect(commands).toEqual(['d1 list --json', 'd1 migrations apply DB --remote']);
});
