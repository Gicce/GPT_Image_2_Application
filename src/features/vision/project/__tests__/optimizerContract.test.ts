import { describe, it, expect } from 'vitest';
import { buildOptimizerHardContractLines } from '../optimizerContract';
import { setProjectPersonContract, updateVisualProjectSemanticState } from '../project';
import { fixtureAnalysis, fixtureProject } from './fixtures';

describe('buildOptimizerHardContractLines（§14 优化器收权：合同行生成）', () => {
  it('人物 strict 替换 + 模板服装：合同行明示身份来源与服装来源分离', () => {
    const project = setProjectPersonContract(fixtureProject(), {
      enabled: true,
      source: 'gallery',
      assetId: 'asset-person',
      path: 'D:/imgs/person.png',
      label: '人物参考',
      strength: 'strict',
      replaceScope: 'whole_person',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'primary_subject_only',
    });
    const lines = buildOptimizerHardContractLines(project);
    expect(lines.some(line => line.includes('人物替换：启用（强度=严格') && line.includes('身份主来源=@人物参考'))).toBe(true);
    expect(lines.some(line => line.includes('服装来源：沿用画面模板服装') && line.includes('绝不因此保留模板人物'))).toBe(true);
  });

  it('显式维度 / 区域 / 混合媒介全部进入合同行', () => {
    let project = fixtureProject();
    project = updateVisualProjectSemanticState(project, 'regions', draft => ({
      ...draft,
      renderingContract: {
        overallMode: 'mixed_media',
        preserveTemplateMediaStructure: true,
        regions: [
          { id: 'r1', label: '真人主体', semanticRole: 'primary_subject', renderingMode: 'photorealistic', identityRelation: 'person_reference' },
          { id: 'r2', label: '动漫对应角色', semanticRole: 'anime_counterpart', renderingMode: 'anime_illustration', identityRelation: 'same_as_primary' },
        ],
      },
      regions: [{
        id: 'region-1', name: '区域 1',
        shape: { kind: 'rect', x: 0, y: 0, w: 0.3, h: 0.6 },
        replaceType: 'person', constraintStrength: 'strict', replaceScope: 'face',
        enabled: true, createdAt: new Date().toISOString(),
      }],
      modification: {
        ...draft.modification,
        activeDimensions: ['pose' as const, 'scene' as const],
      },
    }));
    const lines = buildOptimizerHardContractLines(project);
    expect(lines.some(line => line.includes('动作、背景') && line.includes('必须真实修改'))).toBe(true);
    expect(lines.some(line => line.includes('区域替换：1 个区域已启用') && line.includes('你无权取消任何区域'))).toBe(true);
    expect(lines.some(line => line.includes('媒介结构：混合媒介') && line.includes('禁止整图统一成单一媒介'))).toBe(true);
    expect(lines.some(line => line.includes('动漫对应角色=动漫插画') && line.includes('与主体同一人物'))).toBe(true);
  });

  it('空项目（无人物 / 无维度 / 单一媒介）：仅剩单一媒介合同行（防媒介漂移）', () => {
    const lines = buildOptimizerHardContractLines(fixtureProject({ analysis: fixtureAnalysis() }));
    expect(lines).toEqual(['媒介结构：单一媒介（真人摄影），全图保持一致']);
  });
});
