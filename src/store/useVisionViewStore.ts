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
import type { ModificationDimension } from '../features/vision/modificationIntent';

export interface VisionViewState {
  /** 项目预览折叠（true = 收起；纯视图，不影响项目数据）。 */
  projectPreviewCollapsed: boolean;
  /** 自定义修改内容折叠（true = 收起；输入内容仍在 workspace）。 */
  customContentCollapsed: boolean;
  /** 人物替换业务卡折叠（true = 收起）。 */
  personReplacementCollapsed: boolean;
  /** 服装更改业务卡折叠（true = 收起）。 */
  clothingChangeCollapsed: boolean;
  /** 动作 / 背景 / 镜头 / 风格配置卡折叠状态。 */
  dimensionEditorCollapsed: Partial<Record<ModificationDimension, boolean>>;
  /** 维度锁定面板折叠（true = 收起）。 */
  dimensionsCollapsed: boolean;
  /** 高级设置折叠（true = 收起）。 */
  advancedCollapsed: boolean;
  /** AI 详细分析折叠（true = 收起）。 */
  analysisDetailCollapsed: boolean;
  /** FinalPromptEditor 显示态：最终版本（可编辑）/ 修改对比（Diff）。 */
  promptView: 'final' | 'diff';
  /** V6.7 四步向导（视图理解/需求描述/素材替换/最终提示词）：当前步骤，可随时回退切换；纯视图。 */
  wizardStep: 1 | 2 | 3 | 4;
  toggleProjectPreview: () => void;
  toggleCustomContent: () => void;
  togglePersonReplacement: () => void;
  toggleClothingChange: () => void;
  toggleDimensionEditor: (dimension: ModificationDimension) => void;
  toggleDimensions: () => void;
  toggleAdvanced: () => void;
  toggleAnalysisDetail: () => void;
  setPromptView: (view: 'final' | 'diff') => void;
  setVisionStep: (step: 1 | 2 | 3 | 4) => void;
  reset: () => void;
}

const INITIAL = {
  projectPreviewCollapsed: false,
  customContentCollapsed: false,
  personReplacementCollapsed: false,
  clothingChangeCollapsed: false,
  dimensionEditorCollapsed: {},
  dimensionsCollapsed: true,
  advancedCollapsed: true,
  analysisDetailCollapsed: true,
  promptView: 'final' as const,
  wizardStep: 1 as const,
};

export const useVisionViewStore = create<VisionViewState>(set => ({
  ...INITIAL,
  toggleProjectPreview: () => set(state => ({ projectPreviewCollapsed: !state.projectPreviewCollapsed })),
  toggleCustomContent: () => set(state => ({ customContentCollapsed: !state.customContentCollapsed })),
  togglePersonReplacement: () => set(state => ({ personReplacementCollapsed: !state.personReplacementCollapsed })),
  toggleClothingChange: () => set(state => ({ clothingChangeCollapsed: !state.clothingChangeCollapsed })),
  toggleDimensionEditor: dimension => set(state => ({
    dimensionEditorCollapsed: {
      ...state.dimensionEditorCollapsed,
      [dimension]: !state.dimensionEditorCollapsed[dimension],
    },
  })),
  toggleDimensions: () => set(state => ({ dimensionsCollapsed: !state.dimensionsCollapsed })),
  toggleAdvanced: () => set(state => ({ advancedCollapsed: !state.advancedCollapsed })),
  toggleAnalysisDetail: () => set(state => ({ analysisDetailCollapsed: !state.analysisDetailCollapsed })),
  setPromptView: view => set({ promptView: view }),
  setVisionStep: step => set({ wizardStep: step }),
  reset: () => set({ ...INITIAL }),
}));
