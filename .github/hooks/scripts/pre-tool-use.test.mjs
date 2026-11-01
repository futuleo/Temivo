import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { evaluateToolCall } from './pre-tool-use.mjs';

function evaluate(toolName, toolArgs) {
  return evaluateToolCall({ toolName, toolArgs, cwd: '/repo' });
}

test('denies secret-file reads and edits in supported payload shapes', () => {
  for (const path of ['.env', '.env.local', 'apps/desktop/.env.production', 'private.key', 'secrets/key.txt']) {
    assert.equal(evaluate('functions.view', { path })?.permissionDecision, 'deny');
    assert.equal(evaluate('edit', JSON.stringify({ file_path: path }))?.permissionDecision, 'deny');
  }
  assert.equal(evaluate('rg', { paths: ['src', '.env'] })?.permissionDecision, 'deny');
  assert.equal(evaluate('rg', { glob: '.env*' })?.permissionDecision, 'deny');
  assert.equal(evaluate('view', { path: 'apps/desktop/../desktop/.env' })?.permissionDecision, 'deny');
  assert.equal(evaluate('view', { path: 'C:\\repo\\.env.local' })?.permissionDecision, 'deny');
});

test('checks patches including raw freeform payloads and renamed destinations', () => {
  const patch = '*** Begin Patch\n*** Update File: .env\n@@\n-old\n+new\n*** End Patch';
  assert.equal(evaluate('apply_patch', patch)?.permissionDecision, 'deny');
  assert.equal(evaluate('apply_patch', { input: patch })?.permissionDecision, 'deny');
  assert.equal(evaluate('apply_patch', {
    patch: '*** Begin Patch\n*** Update File: public.txt\n*** Move to: .env.local\n*** End Patch',
  })?.permissionDecision, 'deny');
});

test('retains generated-file and package-manager safeguards', () => {
  for (const path of ['pnpm-lock.yaml', 'node_modules/pkg/index.js', 'apps/desktop/out/main/index.js']) {
    assert.equal(evaluate('edit', { path })?.permissionDecision, 'deny');
  }
  assert.equal(evaluate('apply_patch', { input: '*** Update File: pnpm-lock.yaml\n' })?.permissionDecision, 'deny');
  for (const command of ['npm install', 'npm ci', 'yarn add react', 'echo ok && npm i']) {
    assert.equal(evaluate('bash', { command })?.permissionDecision, 'deny');
  }
});

test('denies obvious secret reads and environment dumps through shells', () => {
  for (const command of [
    'cat .env', 'cat ".env.local"', 'cat .env*', 'cat /repo/.env',
    'Get-Content .env', 'cat private.pem', 'cat .ssh/id_rsa',
    'printenv', 'env | sort', 'set', 'export -p',
    'node -e "console.log(process.env)"',
    'node -e "console.log(process[\'env\'])"',
    'python -c "import os; print(os.environ)"',
    'Get-ChildItem Env:', 'echo $TEMIVO_AI_API_KEY',
  ]) {
    assert.equal(evaluate('bash', { command })?.permissionDecision, 'deny', command);
  }
});

test('allows public templates, helpers, source work, and normal validation', () => {
  for (const command of [
    'pnpm env:check', 'pnpm lint && pnpm typecheck && pnpm test && pnpm build',
    'cat .env.example', 'pnpm install', 'pnpm --filter @temivo/desktop add -D vitest@catalog:',
    'set -e; pnpm test',
  ]) {
    assert.equal(evaluate('bash', { command }), undefined, command);
  }
  assert.equal(evaluate('view', { path: '.env.example' }), undefined);
  assert.equal(evaluate('view', { path: 'src/env.d.ts' }), undefined);
  assert.equal(evaluate('view', { path: 'secrets/.env.example' })?.permissionDecision, 'deny');
  assert.equal(evaluate('edit', { path: 'src/main.ts' }), undefined);
});

test('checks nested tool calls', () => {
  assert.equal(evaluate('multi_tool_use.parallel', {
    tool_uses: [{ recipient_name: 'functions.view', parameters: { path: '.env' } }],
  })?.permissionDecision, 'deny');
});

test('resolves existing symlinks before allowing file access', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'temivo-hook-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, '.env'), 'fixture');
  symlinkSync(join(cwd, '.env'), join(cwd, 'innocent.txt'));
  assert.equal(evaluateToolCall({
    cwd, toolName: 'view', toolArgs: { path: 'innocent.txt' },
  })?.permissionDecision, 'deny');
});

test('unknown payloads fail open and the command emits valid decisions', () => {
  assert.equal(evaluateToolCall(null), undefined);
  assert.equal(evaluateToolCall({ toolName: 'future-tool' }), undefined);
  const script = fileURLToPath(new URL('./pre-tool-use.mjs', import.meta.url));
  const malformed = spawnSync(process.execPath, [script], { input: 'not-json', encoding: 'utf8' });
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');
  const denied = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ toolName: 'view', toolArgs: { path: '.env' } }),
    encoding: 'utf8',
  });
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
});
