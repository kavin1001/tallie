import { access, copyFile, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const target of ['.env', 'apps/web/.env.local']) {
  try {
    await access(resolve(root, target));
  } catch {
    if (target === '.env') await copyFile(resolve(root, '.env.example'), resolve(root, target));
    else {
      const example = await readFile(resolve(root, '.env.example'), 'utf8');
      const core = example
        .split('\n')
        .filter((line) => /^(APP_MODE|APP_ORIGIN|DATABASE_URL)=/.test(line));
      await writeFile(resolve(root, target), `${core.join('\n')}\n`, { mode: 0o600 });
    }
  }
}
const configurationPath = resolve(root, '.env');
let configuration = await readFile(configurationPath, 'utf8');
const values = parse(configuration);
for (const key of [
  'BETTER_AUTH_SECRET',
  'IDENTITY_ENCRYPTION_KEY',
  'MESSAGING_ENCRYPTION_KEY',
  'SENDBLUE_PHONE_ENCRYPTION_KEY',
  'SENDBLUE_MESSAGE_WEBHOOK_SECRET',
]) {
  if (values[key]) continue;
  const line = `${key}=${randomBytes(32).toString('hex')}`;
  const existing = new RegExp(`^${key}=.*$`, 'm');
  configuration = existing.test(configuration)
    ? configuration.replace(existing, line)
    : `${configuration.trimEnd()}\n${line}\n`;
}
await writeFile(configurationPath, configuration, { mode: 0o600 });
await chmod(configurationPath, 0o600);
for (const [command, args] of [
  ['docker', ['compose', 'up', '-d', '--wait']],
  ['npm', ['run', 'db:migrate']],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('\nTallie is ready. Run npm run dev, then open http://localhost:3000.');
