import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const databaseName = 'dns-delegation-panel';
const databaseBinding = 'DB';

function run(args, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed (${result.status})`);
  return result.stdout;
}

// A fresh Git deployment has no D1 database yet. Wrangler creates the binding on
// its first deploy; subsequent deployments migrate before replacing active code.
const databases = JSON.parse(run(['d1', 'list', '--json'], true));
if (!Array.isArray(databases)) throw new Error('Unexpected response from wrangler d1 list --json');
if (!databases.some((database) => database.name === databaseName)) {
  console.log(`Provisioning D1 database ${databaseName} with an initial Worker deployment...`);
  run(['deploy']);
}

run(['d1', 'migrations', 'apply', databaseBinding, '--remote']);
run(['deploy']);
