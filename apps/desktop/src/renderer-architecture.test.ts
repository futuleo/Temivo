import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('./renderer/src', import.meta.url));
const layers = ['shared', 'entities', 'features', 'widgets', 'pages', 'app'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(path) && !path.endsWith('.test.ts') ? [path] : [];
  });
}

it('keeps renderer FSD imports downward, slices isolated, and cross-slice imports public', () => {
  const violations: string[] = [];
  for (const path of sourceFiles(root)) {
    const sourcePath = relative(root, path);
    const [layer, slice] = sourcePath.split('/');
    const sourceRank = layers.indexOf(layer ?? '');
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false, path.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const imported = statement.moduleSpecifier.text;
      if (imported.startsWith('@temivo/core/')) violations.push(`${sourcePath}: import core through its package root`);
      if (!imported.startsWith('.')) continue;
      const target = relative(root, resolve(dirname(path), imported));
      if (target.startsWith('..')) {
        if (!target.startsWith('../../shared/')) violations.push(`${sourcePath}: forbidden platform import ${imported}`);
        continue;
      }
      const [targetLayer, targetSlice, ...insideSlice] = target.split('/');
      const targetRank = layers.indexOf(targetLayer ?? '');
      if (sourceRank >= 0 && targetRank > sourceRank) violations.push(`${sourcePath}: upward dependency ${imported}`);
      if (sourceRank >= 0 && sourceRank === targetRank && sourceRank !== layers.indexOf('app') && slice !== targetSlice) {
        violations.push(`${sourcePath}: same-layer cross-slice dependency ${imported}`);
      }
      if (targetRank >= 0 && layer !== targetLayer && targetLayer !== 'app' && insideSlice.length > 0) {
        violations.push(`${sourcePath}: import a slice through its public index, not ${imported}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
