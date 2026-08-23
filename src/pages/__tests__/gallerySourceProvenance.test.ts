import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 图库来源 provenance 接入守卫（源码文本断言）：
 * - Gallery 归类 / 筛选全部走 resolveImageSource（禁止页面内重写 classify）；
 * - 筛选 Tab 来自 IMAGE_SOURCE_FILTER_TABS（含视觉复刻）；
 * - 全项目禁止 source 缺失回退本地（?? 'local' / || 'local' / 硬编码「本地导入」）。
 */

const gallerySrc = readFileSync(resolve(__dirname, '../Gallery.tsx'), 'utf-8');

describe('Gallery 来源接入', () => {
  test('卡片 / 筛选走 resolveImageSource，详情 / Viewer 走统一 detail resolver + 集中 Tab', () => {
    expect(gallerySrc).toContain("from '../utils/imageSource'");
    expect(gallerySrc).toMatch(/resolveImageSource\(img, task, taskById\)/);
    expect(gallerySrc).toMatch(/resolveImageSource\(image, task, taskById\)\.filterKey !== filter/);
    expect(gallerySrc).toMatch(/resolveImageDetailMetadata\(image, task, props\.taskById\)/);
    expect(gallerySrc).toContain('IMAGE_SOURCE_FILTER_TABS.map');
  });

  test('详情不再有「类型」混用标签（来源 / 用途两个概念分开）', () => {
    expect(gallerySrc).not.toContain("label: '类型'");
    expect(gallerySrc).not.toContain("label: '执行模型'");
    expect(gallerySrc).not.toContain("label: '创建时间'");
  });

  test('页面内不再有本地归类实现（旧 classifyImage 已删除）', () => {
    expect(gallerySrc).not.toContain('classifyImage');
    expect(gallerySrc).not.toContain("typeLabel: '本地导入'");
  });

  test('「本地」角标只由 resolver 的 isLocal 决定', () => {
    expect(gallerySrc).toMatch(/cls\.isLocal && <span className="gallery-kind-badge">本地<\/span>/);
  });
});

describe('禁止 local 兜底（业务源码扫描）', () => {
  function collectFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectFiles(full));
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  test('无 source ?? / || 回退 local，无硬编码「本地导入」', () => {
    const srcRoot = resolve(__dirname, '../..');
    // 白名单：recreationCopy.ts 的「本地导入」是人物替换来源 Tab 的 UI 文案（V4.1
    // Person Replacement），不参与图库 source_kind 分类，不属于本守卫禁止的兜底场景。
    const allowlist = new Set([resolve(srcRoot, 'features/vision/recreationCopy.ts')]);
    const offenders: string[] = [];
    for (const dir of ['pages', 'features', 'store', 'utils', 'components']) {
      const root = join(srcRoot, dir);
      if (!existsSync(root)) continue;
      for (const file of collectFiles(root)) {
        const text = readFileSync(file, 'utf-8');
        if (/\?\?\s*'local'|\|\|\s*'local'/.test(text)) offenders.push(`${file}: source fallback 'local'`);
        if (text.includes("'本地导入'") && !allowlist.has(resolve(file))) offenders.push(`${file}: hard-coded 本地导入`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('详情 / Viewer metadata 禁止「类型」标签（来源 / 用途两概念分开）', () => {
    const srcRoot = resolve(__dirname, '../..');
    const offenders: string[] = [];
    for (const dir of ['pages', 'features', 'components']) {
      const root = join(srcRoot, dir);
      if (!existsSync(root)) continue;
      for (const file of collectFiles(root)) {
        const text = readFileSync(file, 'utf-8');
        if (/label:\s*['"]类型['"]/.test(text)) offenders.push(`${file}: metadata label '类型'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
