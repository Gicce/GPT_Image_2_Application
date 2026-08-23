import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 视觉理解页「复刻方案」UI 回归守卫（CSS / 源码文本断言，先例见 confirmButtons.test.ts）：
 * - 主状态栏五色调（灰 / 绿 / 橙 / 蓝 / 红）必须引用主题表真实存在的变量；
 * - 确认生成 / 高复刻 / 图库对话框必须使用统一结构（header / desc / body / footer）；
 * - 统一「调整要求」输入框与「生成参数」控件区存在；
 * - 禁止旧入口（替换人物 / 自由微调）以任何形式回到页面。
 */

const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');

describe('复刻方案主状态栏样式', () => {
  const css = readFileSync(resolve(__dirname, '../VisionUnderstanding.css'), 'utf-8');

  test('五色调状态栏齐全：gray / green / orange / blue / red', () => {
    for (const tone of ['tone-gray', 'tone-green', 'tone-orange', 'tone-blue', 'tone-red']) {
      expect(css).toContain(`.vision-status-bar.${tone} {`);
    }
  });

  test('状态栏颜色引用主题真实变量（accent / badge 系列）', () => {
    const appCss = readFileSync(resolve(__dirname, '../../App.css'), 'utf-8');
    const required = [
      '--accent-success', '--accent-orange', '--accent-primary', '--accent-danger',
      '--badge-success-text', '--badge-warn-text', '--badge-info-text', '--badge-danger-text',
    ];
    for (const name of required) {
      expect(css).toContain(`var(${name}`);
      expect(appCss).toMatch(new RegExp(`${name}\\s*:`));
    }
  });

  test('状态栏文案元素存在（标签加粗 + 引导语次级色）', () => {
    expect(css).toContain('.vision-status-label');
    expect(css).toContain('.vision-status-note');
  });
});

describe('统一「调整要求」输入框（替代替换人物 / 自由微调弹窗）', () => {
  const css = readFileSync(resolve(__dirname, '../VisionUnderstanding.css'), 'utf-8');

  test('页面不再渲染「替换人物」「自由微调」按钮与弹窗', () => {
    expect(pageSrc).not.toContain('替换人物');
    expect(pageSrc).not.toContain('自由微调');
    expect(pageSrc).not.toContain('replaceOpen');
    expect(pageSrc).not.toContain('freeEditOpen');
  });

  test('统一输入框结构存在（标题 + 说明 + textarea + 优化按钮）', () => {
    expect(pageSrc).toContain('ADJUST_INPUT');
    expect(pageSrc).toContain('vision-adjust-textarea');
    expect(pageSrc).toContain('onFreeTextChange');
    expect(pageSrc).toContain('优化复刻 Prompt');
    expect(css).toContain('.vision-adjust-box');
    expect(css).toContain('.vision-adjust-textarea');
  });

  test('「生成参数」为可选控件区（比例 / 尺寸 / 质量 / 数量，V4.0.7 起随工作区持久化）', () => {
    expect(pageSrc).toContain('vision-genparams');
    expect(pageSrc).toContain('RATIO_OPTIONS');
    expect(pageSrc).toContain('genParams.quality');
    expect(pageSrc).toContain('genParams.count');
    expect(pageSrc).toContain('setGenParams');
    expect(pageSrc).not.toContain('vision-recommended');
  });
});

describe('保留对话框统一结构（确认生成 / 高复刻 / 图库）', () => {
  const css = readFileSync(resolve(__dirname, '../VisionUnderstanding.css'), 'utf-8');

  test('标准结构类齐全：header / desc / body / footer', () => {
    for (const cls of ['.vision-modal-header', '.vision-modal-desc', '.vision-modal-body', '.vision-modal-footer']) {
      expect(css).toContain(cls);
    }
    // 旧弹窗专用表单样式已随入口一并清理
    expect(css).not.toContain('.vision-form-field');
    expect(css).not.toContain('.vision-form-checks');
  });

  test('对话框使用主题背景 / 标题变量（与项目弹窗规范一致）', () => {
    const appCss = readFileSync(resolve(__dirname, '../../App.css'), 'utf-8');
    expect(css).toContain('background: var(--bg-dialog');
    expect(css).toContain('color: var(--text-dialog-title');
    expect(appCss).toMatch(/--bg-dialog\s*:/);
    expect(appCss).toMatch(/--text-dialog-title\s*:/);
  });
});

describe('主题变量引用卫生', () => {
  const css = readFileSync(resolve(__dirname, '../VisionUnderstanding.css'), 'utf-8');

  test('不再引用未定义的 var(--accent, …)（主题不跟随根因）', () => {
    expect(css).not.toMatch(/var\(--accent,/);
  });

  test('方案摘要卡片与锁定角标存在（哪些会变 / 哪些保留）', () => {
    expect(css).toContain('.vision-plan-field-head');
    expect(css).toContain('.vision-lock-badge.is-locked');
    expect(css).toContain('.vision-lock-badge.is-unlocked');
  });
});
