/**
 * 视觉理解页 View State（V4.1）—— 折叠 / 展开 / Tab 等「纯 UI 状态」唯一载体。
 *
 * 铁律：本 store 只描述视图（折叠、Tab、选中展示），绝不影响生成语义；
 * 禁止把任何字段并入 RecreationPlan / Prompt Provenance / GenerationCarry，
 * 也禁止本 store 的任何变化触发 workspace.recreation 的 revision 变化。
 * （语义状态唯一载体 = useVisionWorkspaceStore；needsOptimization 由
 *   recreationPlan.needsOptimization（semanticRevision !== optimizedRevision）派生。）
 * 进程内状态，刻意不持久化（重进页面回到默认视图，语义数据不受影响）。
 */

import { create } from 'zustand';

export interface VisionViewState {
  /** 维度锁定面板折叠（true = 收起）。 */
  dimensionsCollapsed: boolean;
  /** 高级设置折叠（true = 收起）。 */
  advancedCollapsed: boolean;
  /** AI 详细分析折叠（true = 收起）。 */
  analysisDetailCollapsed: boolean;
  /** FinalPromptEditor 显示态：最终版本（可编辑）/ 修改对比（Diff）。 */
  promptView: 'final' | 'diff';
  toggleDimensions: () => void;
  toggleAdvanced: () => void;
  toggleAnalysisDetail: () => void;
  setPromptView: (view: 'final' | 'diff') => void;
  reset: () => void;
}

const INITIAL = {
  dimensionsCollapsed: true,
  advancedCollapsed: true,
  analysisDetailCollapsed: true,
  promptView: 'final' as const,
};

export const useVisionViewStore = create<VisionViewState>(set => ({
  ...INITIAL,
  toggleDimensions: () => set(state => ({ dimensionsCollapsed: !state.dimensionsCollapsed })),
  toggleAdvanced: () => set(state => ({ advancedCollapsed: !state.advancedCollapsed })),
  toggleAnalysisDetail: () => set(state => ({ analysisDetailCollapsed: !state.analysisDetailCollapsed })),
  setPromptView: view => set({ promptView: view }),
  reset: () => set({ ...INITIAL }),
}));
