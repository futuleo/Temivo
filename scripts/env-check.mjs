import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export function requiredEnvironmentKeys(template) {
  const keys = new Set();
  for (const line of template.split(/\r?\n/)) {
    const declaration = line.trim();
    if (!declaration || declaration.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=\s*(?:#.*)?$/.exec(declaration);
    if (!match || keys.has(match[1])) {
      throw new Error('The environment template must contain unique NAME= empty placeholders.');
    }
    keys.add(match[1]);
  }
  return [...keys].sort();
}

export function environmentStatuses(keys, local, inherited) {
  return keys.map((name) => {
    const value = Object.hasOwn(inherited, name) ? inherited[name] : local[name];
    return { name, present: typeof value === 'string' && value.trim().length > 0 };
  });
}

export function checkEnvironment({
  directory = fileURLToPath(new URL('../', import.meta.url)),
  environment = process.env,
  write = (message) => console.log(message),
} = {}) {
  const keys = requiredEnvironmentKeys(readFileSync(resolve(directory, '.env.example'), 'utf8'));
  if (keys.length === 0) {
    write('No application environment variables are required.');
    return true;
  }

  let local = {};
  try {
    local = parseEnv(readFileSync(resolve(directory, '.env'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const statuses = environmentStatuses(keys, local, environment);
  for (const { name, present } of statuses) {
    write(`${name}: ${present ? 'present' : 'missing'}`);
  }
  return statuses.every(({ present }) => present);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = checkEnvironment() ? 0 : 1;
  } catch {
    console.error('Environment check failed. Check template syntax and local file permissions; values were not logged.');
    process.exitCode = 1;
  }
}
