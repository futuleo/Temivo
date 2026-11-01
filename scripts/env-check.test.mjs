import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkEnvironment, environmentStatuses, requiredEnvironmentKeys } from './env-check.mjs';

test('only accepts unique, empty public placeholders', () => {
  assert.deepEqual(requiredEnvironmentKeys('# comment\nTOKEN=\nURL= # required\n'), ['TOKEN', 'URL']);
  for (const template of ['TOKEN=actual-value', 'TOKEN=\nTOKEN=', 'not a declaration']) {
    assert.throws(() => requiredEnvironmentKeys(template));
  }
});

test('reports presence without returning values and honors the inherited environment', () => {
  const statuses = environmentStatuses(
    ['TOKEN', 'URL', 'MISSING'],
    { TOKEN: 'local-fixture', URL: 'local-fixture' },
    { TOKEN: '', URL: 'inherited-fixture' },
  );
  assert.deepEqual(statuses, [
    { name: 'TOKEN', present: false },
    { name: 'URL', present: true },
    { name: 'MISSING', present: false },
  ]);
});

test('handles an unconfigured app without reading a local environment file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'temivo-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, '.env.example'), '# no settings yet\n');
  const output = [];
  assert.equal(checkEnvironment({ directory, environment: {}, write: (line) => output.push(line) }), true);
  assert.deepEqual(output, ['No application environment variables are required.']);
});

test('reads local configuration through the helper without revealing its contents', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'temivo-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, '.env.example'), 'TOKEN=\nMISSING=\n');
  writeFileSync(join(directory, '.env'), 'TOKEN=fixture-do-not-use\nUNDECLARED=private-fixture\n');
  const output = [];
  assert.equal(checkEnvironment({ directory, environment: {}, write: (line) => output.push(line) }), false);
  assert.deepEqual(output, ['MISSING: missing', 'TOKEN: present']);
  assert.equal(output.join('\n').includes('fixture'), false);
});

test('reports missing values when there is no local file and surfaces missing templates', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'temivo-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => checkEnvironment({ directory, environment: {} }));
  writeFileSync(join(directory, '.env.example'), 'TOKEN=\n');
  const output = [];
  assert.equal(checkEnvironment({ directory, environment: {}, write: (line) => output.push(line) }), false);
  assert.deepEqual(output, ['TOKEN: missing']);
});
