import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEvaluationStore, evaluationsOfTask } from '../useEvaluationStore';
import type { ImageEvaluation } from '../../features/evaluation/types';

function makeEvaluation(overrides: Partial<ImageEvaluation>): ImageEvaluation {
  return {
    asset_id: 'asset-1',
    asset_path: '',
    task_id: 'task-1',
    task_kind: 'i2i',
    evaluation_version: 'image-eval-v1',
    overall_score: 90,
    instruction_adherence: 92,
    subject_consistency: null,
    reference_preservation: 88,
    style_consistency: 85,
    composition_quality: 90,
    technical_quality: 95,
    strengths: [],
    issues: [],
    suggestion: '',
    preserve: [],
    change: [],
    edit_instruction: '',
    evaluated_by: 'glm-5v-turbo',
    evaluated_at: '',
    user_rating: null,
    user_issue_tags: [],
    user_comment: '',
    user_feedback_at: '',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('useEvaluationStore', () => {
  beforeEach(() => {
    useEvaluationStore.setState({ evaluations: {}, pending: {}, failed: {}, loaded: false });
  });

  it('loadAll：api 返回的列表转 asset_id 索引', async () => {
    const { api } = await import('../../services/api');
    vi.spyOn(api, 'getImageEvaluations').mockResolvedValue([
      makeEvaluation({ asset_id: 'a', overall_score: 91 }),
      makeEvaluation({ asset_id: 'b', overall_score: 72 }),
    ]);
    await useEvaluationStore.getState().loadAll();
    expect(Object.keys(useEvaluationStore.getState().evaluations).sort()).toEqual(['a', 'b']);
    expect(useEvaluationStore.getState().loaded).toBe(true);
  });

  it('loadAll 失败不抛错（评价缓存不可用不阻塞页面）', async () => {
    const { api } = await import('../../services/api');
    vi.spyOn(api, 'getImageEvaluations').mockRejectedValue(new Error('db locked'));
    await expect(useEvaluationStore.getState().loadAll()).resolves.toBeUndefined();
    expect(useEvaluationStore.getState().loaded).toBe(true);
  });

  it('pending / failed 瞬时态：标记与清除', () => {
    const store = useEvaluationStore.getState();
    store.markPending('a');
    expect(useEvaluationStore.getState().pending['a']).toBe(true);
    store.clearPending('a');
    expect(useEvaluationStore.getState().pending['a']).toBeUndefined();
    store.markFailed('a', '视觉模型服务限流');
    expect(useEvaluationStore.getState().failed['a']).toBe('视觉模型服务限流');
    useEvaluationStore.getState().clearFailure('a');
    expect(useEvaluationStore.getState().failed['a']).toBeUndefined();
  });

  it('submitFeedback：liked / disliked / null 独立落库并更新缓存', async () => {
    const { api } = await import('../../services/api');
    const saved = makeEvaluation({ asset_id: 'a', user_rating: 'disliked', user_issue_tags: ['人物不像'], user_comment: '脸不像' });
    const spy = vi.spyOn(api, 'updateImageEvaluationFeedback').mockResolvedValue(saved);
    useEvaluationStore.getState().upsert(makeEvaluation({ asset_id: 'a' }));
    const result = await useEvaluationStore.getState().submitFeedback('a', 'disliked', ['人物不像'], '脸不像');
    expect(spy).toHaveBeenCalledWith('a', 'disliked', ['人物不像'], '脸不像');
    expect(result?.user_rating).toBe('disliked');
    expect(useEvaluationStore.getState().evaluations['a'].user_issue_tags).toEqual(['人物不像']);
  });

  it('evaluationsOfTask：按 task_id 过滤（任务聚合输入）', () => {
    useEvaluationStore.getState().upsert(makeEvaluation({ asset_id: 'a', task_id: 't1', overall_score: 91 }));
    useEvaluationStore.getState().upsert(makeEvaluation({ asset_id: 'b', task_id: 't2', overall_score: 55 }));
    const state = useEvaluationStore.getState();
    expect(evaluationsOfTask(state, 't1').map(e => e.asset_id)).toEqual(['a']);
    expect(evaluationsOfTask(state, 'missing')).toEqual([]);
  });

  it('removeEvaluation：资产删除联动清理缓存', () => {
    useEvaluationStore.getState().upsert(makeEvaluation({ asset_id: 'a' }));
    useEvaluationStore.getState().removeEvaluation('a');
    expect(useEvaluationStore.getState().evaluations['a']).toBeUndefined();
  });
});
