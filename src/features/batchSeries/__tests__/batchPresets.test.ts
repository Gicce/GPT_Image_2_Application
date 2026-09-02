import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { getBatchPreset, listBatchPresets } from '../batchPresets';

/**
 * V4.2.4 TEST 12 —— 通用预设引擎 + 十二生肖预设。
 *
 * 预设是纯数据注册表：组件绝不硬编码生肖内容；
 * 新预设 = 注册表加一条，零组件改动（源守卫锁定）。
 */

const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'] as const;

describe('预设注册表', () => {
  test('TEST 12：十二生肖预设恰好 12 项、顺序正确', () => {
    const preset = getBatchPreset('chinese-zodiac');
    expect(preset).not.toBeNull();
    expect(preset!.items.map(item => item.value)).toEqual([...ZODIAC]);
    expect(preset!.items.map(item => item.label)).toEqual([...ZODIAC]);
    expect(preset!.variableKey).toBe('zodiac');
    expect(preset!.variableLabel).toBe('生肖');
    expect(preset!.name).toBe('十二生肖');
  });

  test('item id 预设内唯一且稳定（历史 variables 追溯依赖）', () => {
    const preset = getBatchPreset('chinese-zodiac')!;
    const ids = new Set(preset.items.map(item => item.id));
    expect(ids.size).toBe(12);
    expect(preset.items[0].id).toBe('zodiac-rat');
    expect(preset.items[11].id).toBe('zodiac-pig');
  });

  test('listBatchPresets 包含生肖预设；未知 id 返回 null', () => {
    const presets = listBatchPresets();
    expect(presets.some(p => p.id === 'chinese-zodiac')).toBe(true);
    expect(getBatchPreset('nonexistent')).toBeNull();
  });
});

describe('组件零硬编码（源守卫）', () => {
  const readText = (p: string): string =>
    readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');

  /** 引擎文件的文档注释里允许用生肖举例（说明反模式），但活代码零引用。 */
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('TEST 12：生肖 12 字只允许出现在 batchPresets.ts；组件活代码 / 引擎活代码零硬编码', () => {
    const component = readText(resolve(__dirname, '../../../components/BatchSeriesDialog.tsx'));
    for (const word of ZODIAC) {
      expect(component, `BatchSeriesDialog.tsx 不得硬编码生肖「${word}」`).not.toContain(word);
    }
    const engineFiles = [
      resolve(__dirname, '../seriesTemplate.ts'),
      resolve(__dirname, '../buildSeriesTask.ts'),
    ];
    for (const file of engineFiles) {
      const code = stripComments(readText(file));
      for (const word of ZODIAC) {
        expect(code, `${file} 活代码不得硬编码生肖「${word}」`).not.toContain(word);
      }
    }
  });

  test('BatchSeriesDialog 一律经注册表取预设（禁止 if presetId === 硬编码分支）', () => {
    const source = readText(resolve(__dirname, '../../../components/BatchSeriesDialog.tsx'));
    expect(source).toContain('listBatchPresets');
    expect(source).toContain('getBatchPreset');
    expect(source).not.toContain("'chinese-zodiac'");
  });
});
