#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GENERATED_PATH =
  /(^|\/)node_modules\/|(^|\/)pnpm-lock\.yaml$|^(apps|packages)\/[^/]+\/(out|dist|coverage)\//;
const NON_PNPM_INSTALL =
  /(^|[\s;&|(])(npm\s+(install|i|ci|add|uninstall|remove|rm|update)|yarn(\s+(add|install|remove))?)(\s|$)/;
const EDIT_TOOLS = new Set([
  'edit', 'create', 'write', 'edit_file', 'create_file', 'write_file',
  'str_replace', 'str_replace_editor', 'apply_patch',
]);
const SECRET_PATH =
  /(^|\/)(\.env(?:[.*?][^/]*)?|\.ssh|id_rsa|id_ed25519|credentials(?:\.[^/]*)?|secrets?)(\/|$)|\.(pem|key|p12|pfx)$/i;

function isSecretPath(path) {
  const normalized = path.replaceAll('\\', '/').replace(/(^|\/)\.env\.example$/, '$1public-env-template');
  return SECRET_PATH.test(normalized);
}

function parseArgs(toolArgs) {
  if (typeof toolArgs === 'string') {
    try {
      const parsed = JSON.parse(toolArgs);
      return parsed && typeof parsed === 'object' ? parsed : { input: toolArgs };
    } catch {
      return { input: toolArgs };
    }
  }
  return toolArgs && typeof toolArgs === 'object' ? toolArgs : {};
}

function deny(reason) {
  return { permissionDecision: 'deny', permissionDecisionReason: reason };
}

function pathsFromArgs(args) {
  const paths = [];
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'target_file', 'glob']) {
    if (typeof args[key] === 'string') paths.push(args[key]);
  }
  if (typeof args.paths === 'string') paths.push(args.paths);
  if (Array.isArray(args.paths)) paths.push(...args.paths.filter((path) => typeof path === 'string'));
  for (const key of ['input', 'patch', 'patchText']) {
    if (typeof args[key] !== 'string') continue;
    for (const match of args[key].matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)) {
      paths.push(match[1]);
    }
  }
  return paths;
}

function dumpsEnvironment(command) {
  return /(^|[;&|(\n])\s*(printenv|env)(\s|$)/i.test(command)
    || /(^|[;&|(\n])\s*(set|export\s+-p)\s*($|[;&|\n])/i.test(command)
    || /process\s*(\.\s*env|\[\s*['"]env['"]\s*\])|os\.(environ|getenv)|Get-(ChildItem|Item)\s+(-Path\s+)?Env:/i.test(command)
    || /\$(env:|\{)?[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*/i.test(command);
}

function mentionsSecretFile(command) {
  const withoutTemplate = command.replaceAll(/\.env\.example(?![\w.*?-])/g, 'public-env-template');
  return /(^|[/\\\s'"`=:(])\.env(?=$|[.\s'"`;|&)*?])/i.test(withoutTemplate)
    || /(^|[/\\\s'"`=:(])(\.ssh|id_rsa|id_ed25519|credentials(?:\.[\w.-]+)?|secrets?)(?=$|[/\\\s'"`;|&)])/i.test(command)
    || /\.(pem|key|p12|pfx)(?=$|[\s'"`;|&)])/i.test(command);
}

export function evaluateToolCall(input) {
  if (!input || typeof input !== 'object') return undefined;
  const toolName = String(input.toolName ?? '').split(/[./]/).at(-1);
  const args = parseArgs(input.toolArgs);
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();

  if (toolName === 'parallel' && Array.isArray(args.tool_uses)) {
    for (const call of args.tool_uses) {
      const decision = evaluateToolCall({
        toolName: call?.recipient_name,
        toolArgs: call?.parameters,
        cwd,
      });
      if (decision) return decision;
    }
  }

  for (const path of pathsFromArgs(args)) {
    const absolute = resolve(cwd, path);
    if (isSecretPath(path) || isSecretPath(absolute)) {
      return deny('Do not access secret files. Use .env.example and pnpm env:check; ask the user to supply real values.');
    }
    let canonical = absolute;
    try {
      canonical = realpathSync(absolute);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    if (isSecretPath(canonical)) {
      return deny('Do not access secret files. Use .env.example and pnpm env:check; ask the user to supply real values.');
    }
    if (EDIT_TOOLS.has(toolName) && [absolute, canonical].some(
      (target) => GENERATED_PATH.test(relative(cwd, target).replaceAll('\\', '/')),
    )) {
      return deny('This file is generated. Change sources or package manifests and use pnpm install/build instead.');
    }
  }

  if (['bash', 'powershell', 'execute', 'shell'].includes(toolName) && typeof args.command === 'string') {
    if (mentionsSecretFile(args.command) || dumpsEnvironment(args.command)) {
      return deny('Do not read secret files or expose environment values. Use pnpm env:check for status only.');
    }
    if (NON_PNPM_INSTALL.test(args.command)) {
      return deny('This is a pnpm workspace. Use pnpm instead of npm or yarn.');
    }
  }
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    const decision = evaluateToolCall(JSON.parse(data));
    if (decision) process.stdout.write(JSON.stringify(decision));
  } catch {
    // Unknown payloads and hook failures must not block every tool call.
    process.exitCode = 0;
  }
}
