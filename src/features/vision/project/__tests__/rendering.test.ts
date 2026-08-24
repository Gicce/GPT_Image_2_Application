import { describe, it, expect } from 'vitest';
import {
  applyStyleDirection,
  applyUniformRenderingMode,
  deriveRenderingContract,
  inferRenderingModeFromStyle,
  validateRenderingContract,
} from '../rendering';
import type { RenderingContract } from '../types';
import { fixtureAnalysis } from './fixtures';

const photoStyle = { category: '人像摄影', medium: '照片', rendering: '写实' };
const animeStyle = { category: '动漫', medium: '插画', rendering: '二次元' };
const mixedStyle = { category: '真人摄影与动漫拼贴海报', medium: '混合媒介', rendering: '照片 + 动漫插画' };

describe('deriveRenderingContract（媒介契约派生，§12 兜底不伪造混合）', () => {
  it('纯照片 → single_media photorealistic（style 关键词推断）', () => {
    const contract = deriveRenderingContract(fixtureAnalysis({ style: photoStyle }));
    expect(contract.overallMode).toBe('single_media');
    expect(contract.singleMode).toBe('photorealistic');
    expect(contract.regions).toEqual([]);
  });

  it('纯动漫 → single_media anime_illustration', () => {
    const contract = deriveRenderingContract(fixtureAnalysis({ style: animeStyle }));
    expect(contract.singleMode).toBe('anime_illustration');
  });

  it('模型返回 media_structure（新协议）→ 按模型清单建层', () => {
    const contract = deriveRenderingContract(fixtureAnalysis({
      mediaStructure: {
        overall_mode: 'mixed_media',
        regions: [
          { label: '真人主体', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'person_reference' },
          { label: '动漫对应角色', semantic_role: 'anime_counterpart', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        ],
      },
    }));
    expect(contract.overallMode).toBe('mixed_media');
    expect(contract.regions).toHaveLength(2);
    expect(contract.regions[0].renderingMode).toBe('photorealistic');
    expect(contract.regions[1].semanticRole).toBe('anime_counterpart');
    expect(contract.regions[1].identityRelation).toBe('same_as_primary');
  });

  it('模型声明 mixed 但清单不可用 → 保留混合事实、regions 空（不伪造层）', () => {
    const contract = deriveRenderingContract(fixtureAnalysis({
      mediaStructure: { overall_mode: 'mixed_media' },
    }));
    expect(contract.overallMode).toBe('mixed_media');
    expect(contract.regions).toEqual([]);
  });

  it('inferRenderingModeFromStyle：混合文本 → mixed_media', () => {
    expect(inferRenderingModeFromStyle(mixedStyle as never)).toBe('mixed_media');
  });
});

describe('hybridMediaKeepsPhotoSubjectPhotorealistic（混合媒介铁律）', () => {
  const mixed: RenderingContract = deriveRenderingContract(fixtureAnalysis({
    mediaStructure: {
      overall_mode: 'mixed_media',
      regions: [
        { label: '真人主体', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'person_reference' },
        { label: '动漫对应角色', semantic_role: 'anime_counterpart', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        { label: '涂鸦版式', semantic_role: 'graphic_decoration', rendering_mode: 'graphic_design' },
      ],
    },
  }));

  it('hybridMediaAnimeCounterpartUsesSameIdentity：动漫层身份 = same_as_primary', () => {
    const animeLayer = mixed.regions.find(r => r.semanticRole === 'anime_counterpart');
    expect(animeLayer?.renderingMode).toBe('anime_illustration');
    expect(animeLayer?.identityRelation).toBe('same_as_primary');
  });

  it('styleChangeDoesNotChangeRenderingMode：风格修改不改写任何层 renderingMode', () => {
    const styled = applyStyleDirection(mixed, '赛博朋克');
    expect(styled).toBe(mixed); // 契约不可变；风格方向由 Prompt Compiler 叠加
    expect(styled.regions.map(r => r.renderingMode)).toEqual([
      'photorealistic',
      'anime_illustration',
      'graphic_design',
    ]);
    expect(styled.overallMode).toBe('mixed_media');
  });

  it('只有显式统一媒介（applyUniformRenderingMode）才允许改写渲染模式', () => {
    const unified = applyUniformRenderingMode(mixed, 'anime_illustration');
    expect(unified.overallMode).toBe('single_media');
    expect(unified.singleMode).toBe('anime_illustration');
    expect(unified.preserveTemplateMediaStructure).toBe(false);
  });

  it('validateRenderingContract：混合层少于两种模式 → 报错；单一媒介带层 → 报错', () => {
    expect(validateRenderingContract({
      overallMode: 'mixed_media',
      preserveTemplateMediaStructure: true,
      regions: [
        { id: 'a', label: '层1', semanticRole: 'primary_subject', renderingMode: 'photorealistic', identityRelation: 'none' },
        { id: 'b', label: '层2', semanticRole: 'background', renderingMode: 'photorealistic', identityRelation: 'none' },
      ],
    }).length).toBeGreaterThan(0);
    expect(validateRenderingContract({
      overallMode: 'single_media',
      singleMode: 'photorealistic',
      preserveTemplateMediaStructure: true,
      regions: [
        { id: 'a', label: '层1', semanticRole: 'primary_subject', renderingMode: 'photorealistic', identityRelation: 'none' },
      ],
    }).length).toBeGreaterThan(0);
    expect(validateRenderingContract(mixed)).toEqual([]);
  });
});
