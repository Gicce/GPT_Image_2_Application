/**
 * V6.2 Detail Insert Repair Runner 行为测试（headless 执行体）：
 *  - 成功：逐层串行 → completedRegions 递增 → merging/validating → success；
 *  - 单层失败不清空旧分析（null 占位进合并）；
 *  - 层间诚实取消：已完成层照常合并（status=cancelled）；首层前取消 = 无结果；
 *  - resolveConfig 失败 / 无待识别层 → error，绝不下发 IO；
 *  - applyResults=applied:false（项目切换守卫）→ error，绝不静默写错项目；
 *  - 进度模型无百分比字段（Progress Honesty）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../services/api', () => ({
  api: {
    visionExtractDetailInserts: vi.fn(async () => ({
      ok: true,
      instances: [{
        label: '左上动漫面部特写',
        crop_type: 'face',
        media_type: 'anime_illustration',
        position: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        description: '面部特写',
      }],
    })),
  },
}));

import { api } from '../../../../services/api';
import {
  detailRepairElapsedSeconds,
  runDetailInsertRepair,
  type DetailRepairProgress,
} from '../detailInsertRepairRunner';
import { fixtureProject } from './fixtures';
import type { RenderingContract, VisualProject } from '../types';

const extractMock = api.visionExtractDetailInserts as unknown as ReturnType<typeof vi.fn>;

function projectWithTwoIncompleteLayers(): VisualProject {
  const project = fixtureProject();
  const rendering: RenderingContract = {
    overallMode: 'mixed_media',
    preserveTemplateMediaStructure: true,
    regions: [
      { id: 'photo', label: '真人主体', semanticRole: 'primary_subject', renderingMode: 'photorealistic', identityRelation: 'template_identity' },
      { id: 'layer-a', label: '左上插图层', semanticRole: 'detail_insert', renderingMode: 'anime_illustration', identityRelation: 'same_as_primary', description: '左上多个不同的局部插图画框' },
      { id: 'layer-b', label: '右下插图层', semanticRole: 'detail_insert', renderingMode: 'anime_illustration', identityRelation: 'same_as_primary', description: '右下多个不同的局部插图画框' },
    ],
  };
  return {
    ...project,
    renderingContract: rendering,
    templateSnapshot: project.templateSnapshot
      ? { ...project.templateSnapshot, mediaStructure: rendering }
      : project.templateSnapshot,
  };
}

const OK_CONFIG = { ok: true as const, config: { baseUrl: 'https://api.test', token: 't', model: 'glm-4.6v' } };

function collector() {
  const events: DetailRepairProgress[] = [];
  const onProgress = (progress: DetailRepairProgress) => events.push({ ...progress });
  return { events, onProgress };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runDetailInsertRepair（V6.2 执行体）', () => {
  it('successPathEmitsRealStagesAndCounts：阶段真实推进，层数递增，无百分比字段', async () => {
    const project = projectWithTwoIncompleteLayers();
    const { events, onProgress } = collector();
    const applied: unknown[][] = [];
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => OK_CONFIG,
      onProgress,
      applyResults: results => {
        applied.push(results);
        return { applied: true, summary: '已识别 2 个局部插图。' };
      },
    });
    expect(final.status).toBe('success');
    expect(final.summary).toBe('已识别 2 个局部插图。');
    // 阶段序列：preparing → recognizing（completedRegions 0→2）→ merging → validating
    const stages = events.map(event => event.stage);
    expect(stages[0]).toBe('preparing');
    expect(stages.filter(stage => stage === 'recognizing').length).toBeGreaterThanOrEqual(2);
    expect(events[events.length - 1].stage).toBe('validating');
    const recognizing = events.filter(event => event.stage === 'recognizing');
    expect(recognitionCounts(recognizing)).toEqual([0, 1, 2]); // 进入识别 → 第1层完成 → 第2层完成
    expect(final.totalRegions).toBe(2);
    expect(final.completedRegions).toBe(2);
    // 每层一次 IO（串行），共两层
    expect(extractMock).toHaveBeenCalledTimes(2);
    // 合并结果进入 applyResults：两层的实例映射 + bounds
    expect(applied[0]).toHaveLength(2);
    expect((applied[0] as Array<{ instances: unknown[] | null }>)[0].instances).toHaveLength(1);
    // 进度模型没有百分比字段（Progress Honesty 铁律）
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('percent');
    expect(serialized).not.toContain('progress74');
    // 不修改入参 project
    expect(project.renderingContract?.regions.find(r => r.id === 'layer-a')?.instances).toBeUndefined();
  });

  it('layerFailureKeepsNullPlaceholder：单层失败不清空旧分析，仍合并其余层', async () => {
    extractMock.mockRejectedValueOnce(new Error('layer IO fail'));
    const project = projectWithTwoIncompleteLayers();
    let merged: unknown = null;
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => OK_CONFIG,
      onProgress: () => {},
      applyResults: results => {
        merged = results;
        return { applied: true, summary: 'ok' };
      },
    });
    expect(final.status).toBe('success');
    const results = merged as Array<{ regionId: string; instances: unknown[] | null }>;
    expect(results[0].instances).toBeNull(); // 失败层 null 占位（合并层按未识别处理）
    expect(results[1].instances).toHaveLength(1);
  });

  it('cancelBetweenLayersMergesPartial：层间取消，已完成层照常合并', async () => {
    const project = projectWithTwoIncompleteLayers();
    let merged: unknown = null;
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => OK_CONFIG,
      onProgress: () => {},
      isCancelled: () => extractMock.mock.calls.length >= 1, // 第一层完成后取消
      applyResults: results => {
        merged = results;
        return { applied: true, summary: '已识别 1 个局部插图。' };
      },
    });
    expect(final.status).toBe('cancelled');
    expect(final.summary).toContain('已停止剩余识别');
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(merged).toHaveLength(1); // 已完成的第一层照常合并
  });

  it('cancelBeforeFirstLayerProducesNothing：首层前取消 = 无结果不合并', async () => {
    const project = projectWithTwoIncompleteLayers();
    let applyCalled = false;
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => OK_CONFIG,
      onProgress: () => {},
      isCancelled: () => true,
      applyResults: () => {
        applyCalled = true;
        return { applied: true };
      },
    });
    expect(final.status).toBe('cancelled');
    expect(extractMock).not.toHaveBeenCalled();
    expect(applyCalled).toBe(false);
  });

  it('configErrorShortCircuitsWithoutIO：配置失败不下发任何识别请求', async () => {
    const project = projectWithTwoIncompleteLayers();
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => ({ ok: false, error: '视觉模型未配置' }),
      onProgress: () => {},
      applyResults: () => { throw new Error('must not apply'); },
    });
    expect(final.status).toBe('error');
    expect(final.error).toBe('视觉模型未配置');
    expect(final.stage).toBe('preparing');
    expect(extractMock).not.toHaveBeenCalled();
  });

  it('applyRejectedByProjectGuardSurfacesError：项目切换守卫拒绝合并 → error，不静默丢弃', async () => {
    const project = projectWithTwoIncompleteLayers();
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => OK_CONFIG,
      onProgress: () => {},
      applyResults: () => ({ applied: false, error: '项目已切换，本次识别结果已丢弃（未写入其它项目）。' }),
    });
    expect(final.status).toBe('error');
    expect(final.error).toContain('项目已切换');
  });

  it('noIncompleteRegionsIsHonestError：无待识别层直接 error，不空跑', async () => {
    const project = fixtureProject(); // fixture 无不完整层
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => OK_CONFIG,
      onProgress: () => {},
      applyResults: () => { throw new Error('must not apply'); },
    });
    expect(final.status).toBe('error');
    expect(final.error).toContain('当前没有待识别的局部插图层');
    expect(extractMock).not.toHaveBeenCalled();
  });

  it('elapsedSecondsIsPureClock：已用时来自真实时间戳', () => {
    const startedAt = Date.now() - 65_000;
    expect(detailRepairElapsedSeconds({ startedAt })).toBeGreaterThanOrEqual(65);
    expect(detailRepairElapsedSeconds({ startedAt: Date.now() + 5_000 })).toBe(0); // 时钟倒退钳 0
  });
});

function recognitionCounts(events: DetailRepairProgress[]): number[] {
  return events.map(event => event.completedRegions);
}
