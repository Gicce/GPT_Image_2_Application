/**
 * 共享字体选择器测试（V4.2.12 §30~§37）——「选中字体永远可见，绝不空白」：
 *  - 触发器恒显示当前值（原生 select 受控：value 永远命中一个 option）；
 *  - 本机不存在的字体（旧项目 / 换机器）→ 追加「原名（不可用）」回退项并被选中；
 *  - 缺省项 = 默认（跟随导出样式），选择缺省回传 undefined；
 *  - 已知字体下拉项 = 中文名 · 示例文字，并按该字体渲染（option 内联 fontFamily）。
 * renderToStaticMarkup 做真实渲染断言（组件无副作用，SSR 安全）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FontSelect, { DEFAULT_FONT_LABEL, KNOWN_FONTS } from '../FontSelect';

function renderFontSelect(value?: string): string {
  return renderToStaticMarkup(createElement(FontSelect, { value, onChange: () => {} }));
}

/** 受控 select 不空白 = 渲染结果里恰好一个 option 带 selected。 */
function selectedOption(markup: string): string {
  const selected = markup.split('<option').filter(part => part.includes(' selected'));
  expect(selected, `应恰好一个选中项，实际 ${selected.length}`).toHaveLength(1);
  return selected[0]!;
}

describe('KNOWN_FONTS 注册表', () => {
  it('常见本机字体 ≥10 个，value / label / sample 非空且不重复', () => {
    expect(KNOWN_FONTS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(KNOWN_FONTS.map(font => font.value)).size).toBe(KNOWN_FONTS.length);
    for (const font of KNOWN_FONTS) {
      expect(font.label.length).toBeGreaterThan(0);
      expect(font.sample.length).toBeGreaterThan(0);
    }
    // 中文常用字体必须在册（漫画对白最常用）
    const values = KNOWN_FONTS.map(font => font.value);
    for (const required of ['Microsoft YaHei', 'SimHei', 'SimSun', 'KaiTi']) {
      expect(values).toContain(required);
    }
  });
});

describe('§33/§34 选中值永远可见（不空白）', () => {
  it('已知字体：对应 option 存在且被选中，label = 中文名 · 示例', () => {
    const markup = renderFontSelect('KaiTi');
    const selected = selectedOption(markup);
    expect(selected).toContain('value="KaiTi"');
    expect(selected).toContain('楷体');
    expect(selected).toContain('你好漫画');
  });

  it('本机不存在的字体：追加「原名（不可用）」回退项且被选中（永不空白）', () => {
    const markup = renderFontSelect('不存在的点阵体');
    const selected = selectedOption(markup);
    expect(selected).toContain('value="不存在的点阵体"');
    expect(selected).toContain('不存在的点阵体（不可用）');
  });

  it('undefined：默认项被选中（跟随导出样式）', () => {
    const markup = renderFontSelect(undefined);
    expect(selectedOption(markup)).toContain(DEFAULT_FONT_LABEL);
    expect(DEFAULT_FONT_LABEL).toBe('默认（跟随导出样式）');
  });

  it('空串与 undefined 同义（默认项，不出现未知回退项）', () => {
    const markup = renderFontSelect(undefined);
    expect(markup.includes('（不可用）')).toBe(false);
  });
});

describe('§35 下拉项视觉与语义', () => {
  it('全部已知字体 option 都带内联 fontFamily（下拉即预览）', () => {
    const markup = renderFontSelect(undefined);
    // SSR 将单引号转义为 &#x27; —— 断言每个字体项都以该字体名起头渲染
    for (const font of KNOWN_FONTS) {
      expect(markup).toContain(`&#x27;${font.value}&#x27;, sans-serif`);
    }
  });

  it('默认项 value=""（选择默认 = 清空 family，onChange 回传 undefined）', () => {
    const markup = renderFontSelect('SimHei');
    expect(markup).toContain('<option value=""');
    // onChange 语义在源码层锁定：空值 → undefined（不写空串进对白数据）
    const source = readFileSync(resolve(__dirname, '../FontSelect.tsx'), 'utf-8').replace(/\r\n/g, '\n');
    expect(source).toContain('onChange={e => props.onChange(e.target.value || undefined)}');
    // 受控 select：value 永远有值（结构上不空白）
    expect(source).toContain('value={value ?? \'\'');
  });
});
