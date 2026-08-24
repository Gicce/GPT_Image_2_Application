import { describe, it, expect } from 'vitest';
import {
  createRegion,
  describeRectPosition,
  enabledRasterRegions,
  normalizeRegion,
  normalizeShape,
  validateRegionContract,
} from '../region';
import { normalizePersonReplacementContract, validatePersonReplacement } from '../personContract';
import { normalizeModificationContract, setProjectPersonContract } from '../project';
import { validateGenerationContract } from '../validators';
import { fixtureProject } from './fixtures';

describe('regionCoordinatesAreNormalized（归一化坐标铁律）', () => {
  it('矩形越界坐标被钳制 0..1（不存 CSS pixel）', () => {
    const shape = normalizeShape({ kind: 'rect', x: -0.5, y: 0.2, w: 1.8, h: 0.4 });
    expect(shape).toEqual({ kind: 'rect', x: 0, y: 0.2, w: 1, h: 0.4 });
  });

  it('画笔点列与半径归一化；空笔触被剔除', () => {
    const shape = normalizeShape({
      kind: 'brush',
      naturalWidth: 1920,
      naturalHeight: 1080,
      strokes: [
        { points: [{ x: -1, y: 0.5 }, { x: 1.5, y: 2 }], radius: 9 },
        { points: [], radius: 0.01 },
      ],
    });
    expect(shape.kind).toBe('brush');
    if (shape.kind === 'brush') {
      expect(shape.strokes).toHaveLength(1);
      expect(shape.strokes[0].points).toEqual([{ x: 0, y: 0.5 }, { x: 1, y: 1 }]);
      expect(shape.strokes[0].radius).toBeLessThanOrEqual(0.5);
    }
  });

  it('未归一化（>1）的矩形被校验层拒绝', () => {
    const errors = validateRegionContract([
      {
        id: 'r1',
        name: '区域 1',
        shape: { kind: 'rect', x: 120, y: 80, w: 300, h: 200 },
        replaceType: 'custom',
        constraintStrength: 'balanced',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(errors.some(e => e.includes('未归一化'))).toBe(true);
  });
});

describe('customRegionRequiresValidRegion（人物合同 × 区域联动）', () => {
  it('custom_region 指向不存在的区域 → 归一化回落 whole_person', () => {
    const person = normalizePersonReplacementContract({
      enabled: true,
      source: 'gallery',
      path: 'D:/imgs/person.png',
      strength: 'strict',
      replaceScope: 'custom_region',
      targetRegionId: 'missing-region',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'primary_subject_only',
    });
    expect(person?.replaceScope).toBe('whole_person');
    expect(person?.targetRegionId).toBeUndefined();
  });

  it('custom_region 指向存在且启用的区域 → 通过', () => {
    const region = createRegion({ shape: { kind: 'rect', x: 0, y: 0.1, w: 0.4, h: 0.8 }, replaceType: 'person' });
    const person = normalizePersonReplacementContract({
      enabled: true,
      source: 'gallery',
      path: 'D:/imgs/person.png',
      strength: 'strict',
      replaceScope: 'custom_region',
      targetRegionId: region.id,
      preserveTemplateIdentity: false,
      applyIdentityTo: 'primary_subject_only',
    }, [region]);
    expect(person?.replaceScope).toBe('custom_region');
    expect(person?.targetRegionId).toBe(region.id);
  });

  it('custom_region 区域停用 → 生成门禁拦截', () => {
    const region = { ...createRegion({ shape: { kind: 'rect', x: 0, y: 0, w: 0.3, h: 0.6 }, replaceType: 'person' }), enabled: false };
    const base = fixtureProject();
    // 归一化必须与 regions 同批（region 已在项目内 → custom_region 保留）
    const withRegion = {
      ...base,
      regions: [region],
      modification: normalizeModificationContract({
        ...base.modification,
        person: {
          enabled: true,
          source: 'gallery',
          path: 'D:/imgs/person.png',
          strength: 'strict',
          replaceScope: 'custom_region',
          targetRegionId: region.id,
          preserveTemplateIdentity: false,
          applyIdentityTo: 'primary_subject_only',
        },
      }, [region]),
    };
    expect(validateGenerationContract(withRegion).some(e => e.includes('区域'))).toBe(true);
  });

  it('人物区域未绑定参考 → 校验报错（§9.5）', () => {
    const region = normalizeRegion(createRegion({ shape: { kind: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.5 }, replaceType: 'person' }));
    const errors = validateRegionContract([region]);
    expect(errors.some(e => e.includes('未绑定人物参考'))).toBe(true);
  });

  it('停用区域不参与校验 / 不计入栅格 mask 输入', () => {
    const disabled = { ...createRegion({ shape: { kind: 'rect', x: 0, y: 0, w: 0.2, h: 0.2 } }), enabled: false, maskPath: 'D:/masks/a.png' };
    expect(validateRegionContract([disabled])).toEqual([]);
    expect(enabledRasterRegions([disabled])).toEqual([]);
  });
});

describe('personContract 默认与校验', () => {
  it('绑定参考图默认 strict（§7.2），用户显式选择被保留', () => {
    const defaulted = normalizePersonReplacementContract({
      enabled: true,
      source: 'gallery',
      path: 'D:/imgs/person.png',
      strength: undefined,
      replaceScope: undefined,
      preserveTemplateIdentity: false,
      applyIdentityTo: undefined,
    } as never);
    expect(defaulted?.strength).toBe('strict');
    expect(defaulted?.replaceScope).toBe('whole_person');
    expect(defaulted?.preserveTemplateIdentity).toBe(false);
    const explicit = normalizePersonReplacementContract({
      enabled: true,
      source: 'gallery',
      path: 'D:/imgs/person.png',
      strength: 'natural',
      replaceScope: 'face',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'all_corresponding_subjects',
    });
    expect(explicit?.strength).toBe('natural');
    expect(explicit?.applyIdentityTo).toBe('all_corresponding_subjects');
  });

  it('preserveTemplateIdentity !== false 被拒绝（模板身份永不保留）', () => {
    const errors = validatePersonReplacement({
      enabled: true,
      source: 'gallery',
      path: 'D:/imgs/person.png',
      strength: 'strict',
      replaceScope: 'whole_person',
      preserveTemplateIdentity: true,
      applyIdentityTo: 'primary_subject_only',
    } as never);
    expect(errors.some(e => e.includes('preserveTemplateIdentity'))).toBe(true);
  });

  it('normalizeModificationContract：人物合同强制激活 subject 维度', () => {
    const contract = normalizeModificationContract({
      freeText: '',
      activeDimensions: [],
      person: {
        enabled: true,
        source: 'gallery',
        path: 'D:/imgs/person.png',
        strength: 'strict',
        replaceScope: 'whole_person',
        preserveTemplateIdentity: false,
        applyIdentityTo: 'primary_subject_only',
      },
      clothingPolicy: 'preserve_original',
      customClothing: '',
      replicationBoost: false,
      mentions: [],
      extraImageRefs: [],
    });
    expect(contract.activeDimensions).toContain('subject');
  });
});

describe('describeRectPosition（归一化矩形 → 画面位置语言）', () => {
  it('左上 / 中央 / 大小描述', () => {
    expect(describeRectPosition({ kind: 'rect', x: 0.02, y: 0.05, w: 0.25, h: 0.3 })).toContain('左侧');
    expect(describeRectPosition({ kind: 'rect', x: 0.35, y: 0.35, w: 0.3, h: 0.3 })).toContain('画面中央');
    expect(describeRectPosition({ kind: 'rect', x: 0, y: 0, w: 0.95, h: 0.95 })).toContain('大部分');
  });
});
