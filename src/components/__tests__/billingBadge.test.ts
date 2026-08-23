import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { getBillingLabel } from '../../features/aiProviders/billing';
import { BILLING_MODE_LABELS } from '../../features/aiProviders/types';

/**
 * 计费文案 + BillingBadge 布局回归守卫（V4.0.9）。
 *
 * 历史事故：模型选择器的计费 Tag 样式定义在 Settings.css（懒加载 chunk），
 * Chat 页复用类名但样式未加载 → 裸 span 在 flex 容器中被压窄，
 * 「API 按量计费」被拆成「API 按量计 / 费」两行。
 * 本测试锁定：Badge 自包含样式、整词不换行、永不收缩。
 */
describe('getBillingLabel —— 计费文案唯一来源', () => {
  test('各计费模式返回完整整词文案', () => {
    expect(getBillingLabel('api')).toBe('API 按量计费');
    expect(getBillingLabel('coding_plan')).toBe('Coding Plan 套餐');
  });

  test('无计费模式返回空串（组件不渲染）', () => {
    expect(getBillingLabel(undefined)).toBe('');
  });

  test('文案与 types.ts 的 BILLING_MODE_LABELS 单一来源一致', () => {
    expect(getBillingLabel('api')).toBe(BILLING_MODE_LABELS.api);
    expect(getBillingLabel('coding_plan')).toBe(BILLING_MODE_LABELS.coding_plan);
  });
});

describe('BillingBadge 布局契约 —— 「API 按量计费」永不拆词', () => {
  const css = readFileSync(resolve(__dirname, '../BillingBadge.css'), 'utf-8');

  test('Badge 自包含样式：不依赖页面级 CSS', () => {
    expect(css).toMatch(/\.billing-badge\s*\{/);
  });

  test('整词单行：white-space nowrap + flex-shrink 0', () => {
    expect(css).toMatch(/white-space:\s*nowrap/);
    expect(css).toMatch(/flex-shrink:\s*0/);
  });
});

describe('ModelPicker 布局契约 —— 只允许模型名截断', () => {
  const css = readFileSync(resolve(__dirname, '../ModelPicker.css'), 'utf-8');

  function rule(selector: string): string {
    const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`);
    const m = css.match(re);
    return m ? m[1] : '';
  }

  test('模型名单行 ellipsis（唯一可截断元素）', () => {
    const body = rule('.model-picker-name-text');
    expect(body).toContain('text-overflow: ellipsis');
    expect(body).toContain('white-space: nowrap');
    expect(body).toContain('overflow: hidden');
  });

  test('能力/状态 Tag 不挤压模型名与计费 Badge（flex-shrink 0）', () => {
    expect(rule('.model-option-tag')).toContain('flex-shrink: 0');
    expect(rule('.model-picker-chevron')).toContain('flex-shrink: 0');
  });

  test('Dropdown 最大高度 + 内部滚动（禁止无限增长覆盖工作区）', () => {
    const body = rule('.model-picker-panel');
    expect(body).toMatch(/max-height:\s*380px/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  test('Chat.css 不再重复定义选择器样式（单一来源防冲突）', () => {
    const chatCss = readFileSync(resolve(__dirname, '../../pages/Chat.css'), 'utf-8');
    expect(chatCss).not.toMatch(/\.model-picker-btn\s*\{/);
    expect(chatCss).not.toMatch(/\.model-option\s*\{/);
    expect(chatCss).not.toMatch(/model-mode-tag/);
  });
});
