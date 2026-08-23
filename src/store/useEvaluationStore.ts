/**
 * 统一图片评价 store（V4.0.9）：
 *  - 内存缓存全部持久化评价（asset_id → ImageEvaluation），供图库筛选 / 任务行
 *    聚合 / 结果面板消费——所有查询只读这里，绝不现场重新评价；
 *  - pending / failed 是进程内瞬时态（评价中… / 暂无评价 + 重试入口），不持久化。
 */

import { create } from 'zustand';
import { api } from '../services/api';
import type { ImageEvaluation, UserRating } from '../features/evaluation/types';

interface EvaluationState {
  evaluations: Record<string, ImageEvaluation>;
  loaded: boolean;
  /** 评价进行中（asset_id → true）：UI 显示「正在评价…」。 */
  pending: Record<string, true>;
  /** 自动评价失败（asset_id → 错误摘要）：UI 显示「暂无评价」+ 重新评价入口。 */
  failed: Record<string, string>;
  loadAll: () => Promise<void>;
  upsert: (evaluation: ImageEvaluation) => void;
  markPending: (assetId: string) => void;
  clearPending: (assetId: string) => void;
  markFailed: (assetId: string, message: string) => void;
  clearFailure: (assetId: string) => void;
  submitFeedback: (
    assetId: string,
    rating: UserRating | null,
    issueTags: string[],
    comment: string,
  ) => Promise<ImageEvaluation | null>;
  /** 收藏 / 取消收藏（♡ 精选标记；未评价资产先补插最小行再置位）。 */
  setFavorite: (assetId: string, assetPath: string, favorite: boolean) => Promise<void>;
  removeEvaluation: (assetId: string) => void;
}

export const useEvaluationStore = create<EvaluationState>((set, get) => ({
  evaluations: {},
  loaded: false,
  pending: {},
  failed: {},

  loadAll: async () => {
    try {
      const list = await api.getImageEvaluations();
      const map: Record<string, ImageEvaluation> = {};
      for (const item of list) map[item.asset_id] = item;
      set({ evaluations: map, loaded: true });
    } catch {
      // 评价缓存加载失败不阻塞页面：列表为空 = 全部「未评价」展示
      set({ loaded: true });
    }
  },

  upsert: evaluation => {
    set(state => ({
      evaluations: { ...state.evaluations, [evaluation.asset_id]: evaluation },
    }));
  },

  markPending: assetId => set(state => ({ pending: { ...state.pending, [assetId]: true } })),
  clearPending: assetId => set(state => {
    const next = { ...state.pending };
    delete next[assetId];
    return { pending: next };
  }),
  markFailed: (assetId, message) => set(state => ({ failed: { ...state.failed, [assetId]: message } })),
  clearFailure: assetId => set(state => {
    const next = { ...state.failed };
    delete next[assetId];
    return { failed: next };
  }),

  submitFeedback: async (assetId, rating, issueTags, comment) => {
    const saved = await api.updateImageEvaluationFeedback(assetId, rating, issueTags, comment);
    if (saved) get().upsert(saved);
    return saved;
  },

  setFavorite: async (assetId, assetPath, favorite) => {
    // 乐观更新（心形即时反馈），失败回滚
    const prev = get().evaluations[assetId];
    const optimistic: ImageEvaluation = prev
      ? { ...prev, favorite }
      : {
        asset_id: assetId,
        asset_path: assetPath,
        task_id: '',
        task_kind: '',
        evaluation_version: '',
        overall_score: null,
        instruction_adherence: null,
        subject_consistency: null,
        reference_preservation: null,
        style_consistency: null,
        composition_quality: null,
        technical_quality: null,
        strengths: [],
        issues: [],
        suggestion: '',
        preserve: [],
        change: [],
        edit_instruction: '',
        evaluated_by: '',
        evaluated_at: '',
        user_rating: null,
        user_issue_tags: [],
        user_comment: '',
        user_feedback_at: '',
        favorite,
        created_at: '',
        updated_at: '',
      };
    get().upsert(optimistic);
    try {
      const saved = await api.setImageFavorite(assetId, assetPath, favorite);
      get().upsert(saved);
    } catch (error) {
      if (prev) get().upsert(prev);
      else get().removeEvaluation(assetId);
      throw error;
    }
  },

  removeEvaluation: assetId => set(state => {
    const next = { ...state.evaluations };
    delete next[assetId];
    return { evaluations: next };
  }),
}));

/** 便捷 selector：任务层聚合输入（per-asset 评分 → best / average）。 */
export function evaluationsOfTask(
  state: Pick<EvaluationState, 'evaluations'>,
  taskId: string,
): ImageEvaluation[] {
  return Object.values(state.evaluations).filter(item => item.task_id === taskId);
}
