import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizeUserRating,
  readEvaluationSettings,
  writeEvaluationSettings,
} from '../evaluationSettings';

/** vitest 默认 node 环境：装内存 localStorage stub（先例见 useVisionWorkspaceStore.test.ts）。 */
function installLocalStorageStub() {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => { memory.set(key, String(value)); },
    removeItem: (key: string) => { memory.delete(key); },
    clear: () => memory.clear(),
  });
  return memory;
}

describe('评价设置（生成后自动评价开关）', () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  it('默认开启自动评价', () => {
    expect(readEvaluationSettings()).toEqual({ autoEvaluate: true });
  });

  it('写入关闭后读取保持关闭', () => {
    writeEvaluationSettings({ autoEvaluate: false });
    expect(readEvaluationSettings().autoEvaluate).toBe(false);
  });

  it('损坏数据回落默认（不抛错）', () => {
    localStorage.setItem('evaluation_settings_v1', '{broken json');
    expect(readEvaluationSettings().autoEvaluate).toBe(true);
  });

  it('非法字段类型回落默认', () => {
    localStorage.setItem('evaluation_settings_v1', JSON.stringify({ autoEvaluate: 'yes' }));
    expect(readEvaluationSettings().autoEvaluate).toBe(true);
  });

  it('normalizeUserRating 只接受 liked / disliked / null', () => {
    expect(normalizeUserRating('liked')).toBe('liked');
    expect(normalizeUserRating('disliked')).toBe('disliked');
    expect(normalizeUserRating(null)).toBeNull();
    expect(normalizeUserRating('')).toBeNull();
    expect(normalizeUserRating('super')).toBeNull();
    expect(normalizeUserRating(undefined)).toBeNull();
  });
});
