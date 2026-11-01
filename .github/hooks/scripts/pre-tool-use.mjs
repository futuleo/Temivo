#!/usr/bin/env node
// Copilot preToolUse hook: keeps agents on the repository's conventions.
// Reads the hook payload from stdin and prints a single JSON decision to stdout.
// Printing nothing lets the tool call proceed normally.
import { isAbsolute, relative } from 'node:path';

const GENERATED_PATH =
  /(^|\/)node_modules\/|(^|\/)pnpm-lock\.yaml$|^(apps|packages)\/[^/]+\/(out|dist|coverage)\//;
const NON_PNPM_INSTALL =
  /(^|[\s;&|(])(npm\s+(install|i|ci|add|uninstall|remove|rm|update)|yarn(\s+(add|install|remove))?)(\s|$)/;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function parseArgs(toolArgs) {
  if (typeof toolArgs === 'string') {
    try {
      return JSON.parse(toolArgs);
    } catch {
      return {};
    }
  }
  return toolArgs && typeof toolArgs === 'object' ? toolArgs : {};
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }));
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  // Unknown payload: stay out of the way rather than blocking every tool call.
  process.exit(0);
}
const toolName = String(input?.toolName ?? '');
const args = parseArgs(input?.toolArgs);
const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();

if (['edit', 'create', 'str_replace_editor', 'apply_patch'].includes(toolName) && typeof args.path === 'string') {
  const filePath = (isAbsolute(args.path) ? relative(cwd, args.path) : args.path).replaceAll('\\', '/');
  if (GENERATED_PATH.test(filePath)) {
    deny(
      `${filePath} is generated. Edit package.json and run \`pnpm install\`, or change sources and rebuild, instead of editing it directly.`,
    );
  }
} else if (['bash', 'powershell'].includes(toolName) && typeof args.command === 'string') {
  if (NON_PNPM_INSTALL.test(args.command)) {
    deny('This repository is a pnpm workspace. Use pnpm (for example `pnpm install` or `pnpm --filter <pkg> add <dep>`) instead of npm or yarn.');
  }
}
