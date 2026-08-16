// 共享 TS loader —— 用 esbuild bundle 把 TS 源码（含相对依赖）转译后 import，
// 保证 smoke test 测的是真实实现而不是镜像拷贝。
//
// 用法：
//   import { loadTs } from './_ts_loader.mjs';
//   const mod = await loadTs('../src/utils/agent/chatExecutionContext.ts');
//   mod.detectChatExecutionIntent(...)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cacheDir = mkdtempSync(join(tmpdir(), 'cyimage-smoke-'));
const cache = new Map();

/**
 * Bundle + 加载一个 TS 模块。返回其 ESM namespace（命名导出直接访问）。
 * 限制：被测模块只能依赖相对路径 / node 内置 —— 纯 util 模块满足此约束。
 */
export async function loadTs(relativePath) {
  const absPath = resolve(scriptDir, relativePath);
  const key = createHash('md5').update(absPath + ':' + readFileSync(absPath, 'utf8').length).digest('hex');
  if (cache.has(key)) return cache.get(key);

  const outPath = join(cacheDir, `${key}.mjs`);
  const esbuildBin = join(scriptDir, '..', 'node_modules', '.bin', 'esbuild');
  const bin = process.platform === 'win32' ? `${esbuildBin}.cmd` : esbuildBin;
  execFileSync(bin, [
    absPath,
    `--outfile=${outPath}`,
    '--bundle',
    '--format=esm',
    '--platform=node',
  ], { stdio: 'pipe' });

  const mod = await import(pathToFileURL(outPath).href);
  cache.set(key, mod);
  return mod;
}
