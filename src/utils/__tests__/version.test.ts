import { describe, it, expect } from 'vitest';
import { compareSemver, isNewerVersion, normalizeVersion, parseSemver } from '../version';

describe('normalizeVersion', () => {
  it('剥离 V/v 前缀与空白', () => {
    expect(normalizeVersion('V4.0.2')).toBe('4.0.2');
    expect(normalizeVersion('v4.0.2')).toBe('4.0.2');
    expect(normalizeVersion('  4.0.2 ')).toBe('4.0.2');
  });
});

describe('parseSemver', () => {
  it('解析标准三段版本', () => {
    expect(parseSemver('4.0.2')).toEqual({ major: 4, minor: 0, patch: 2 });
    expect(parseSemver('V4.0.2')).toEqual({ major: 4, minor: 0, patch: 2 });
  });

  it('拒绝非法格式', () => {
    expect(parseSemver('4.0')).toBeNull();
    expect(parseSemver('4.0.2-release')).toBeNull();
    expect(parseSemver('')).toBeNull();
    expect(parseSemver('abc')).toBeNull();
    expect(parseSemver('4.0.x')).toBeNull();
  });
});

describe('compareSemver（数值比较，非字符串比较）', () => {
  it('4.0.0 < 4.0.1', () => expect(compareSemver('4.0.0', '4.0.1')).toBe(-1));
  it('4.0.0 < 4.0.2', () => expect(compareSemver('4.0.0', '4.0.2')).toBe(-1));
  it('4.0.1 < 4.0.2', () => expect(compareSemver('4.0.1', '4.0.2')).toBe(-1));
  it('4.0.9 < 4.0.10（字符串比较会得出错误结果）', () => {
    expect(compareSemver('4.0.9', '4.0.10')).toBe(-1);
    expect(compareSemver('4.0.10', '4.0.9')).toBe(1);
  });
  it('4.0.2 == 4.0.2', () => expect(compareSemver('4.0.2', '4.0.2')).toBe(0));
  it('V4.0.2 == 4.0.2（前缀归一化）', () => expect(compareSemver('V4.0.2', '4.0.2')).toBe(0));
  it('主版本号优先：4.1.0 > 4.0.99', () => expect(compareSemver('4.1.0', '4.0.99')).toBe(1));
  it('5.0.0 > 4.9.9', () => expect(compareSemver('5.0.0', '4.9.9')).toBe(1));
  it('不可比较时返回 null', () => {
    expect(compareSemver('bad', '4.0.2')).toBeNull();
    expect(compareSemver('4.0.2', '')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('candidate 严格大于 current 时为 true', () => {
    expect(isNewerVersion('4.0.2', '4.0.0')).toBe(true);
    expect(isNewerVersion('4.0.10', '4.0.9')).toBe(true);
  });
  it('相等或更小为 false', () => {
    expect(isNewerVersion('4.0.2', '4.0.2')).toBe(false);
    expect(isNewerVersion('4.0.1', '4.0.2')).toBe(false);
  });
  it('不可比较为 false（不得猜测）', () => {
    expect(isNewerVersion('4.0', '4.0.2')).toBe(false);
    expect(isNewerVersion('x.y.z', '4.0.2')).toBe(false);
  });
});
