import { create } from 'zustand';

/** V4.0.6 视觉理解 → 图片生成 的单向草稿（带入即清空，绝不自动提交生成） */
export interface VisionCarryDraft {
  prompt: string;
  negativePrompt: string;
  size?: string;
  quality?: string;
  /** 生成数量（复刻页「生成参数」选择；默认 1） */
  count?: number;
  /**
   * V4.0.8 生成方式：图生图 = 视觉理解原图自动成为参考图（复刻 / 人物锁定优先）；
   * 文生图 = 只借鉴画面重新创作。未指定时按「有原图 → 图生图」规则由 carryApply 判定。
   */
  generationMode?: 't2i' | 'i2i';
  /** V4.0.8 图生图参考图：视觉理解工作区原图路径（复用既有素材，不复制不重复导入）。 */
  sourceImagePath?: string;
  sourceAssetId?: string;
  /** V4.1 人物替换参考图（i2i 时作为第二张参考图；身份 / 脸部 / 发型 / 体型）。 */
  personReferencePath?: string;
  sourceVisionSessionId?: string;
  /** V4.0.7 复刻链路：来源视觉理解任务 id（写入生成任务 source_task_id，任务中心显示来源关系） */
  sourceVisionTaskId?: string;
  /** 任务摘要（生成任务的 task_plan_summary，如"基于视觉理解复刻方案已将人物替换为…生成"） */
  taskPlanSummary?: string;
  /** Prompt 已在视觉理解链路优化过：ImageStudio 提交时冻结快照，禁止再次自动优化 */
  optimization?: {
    providerName?: string;
    modelName?: string;
    originalPrompt: string;
    optimizedAt: string;
  };
}

// 内存级草稿，重启应用清空
interface DraftState {
  textToImagePrompt: string;
  textToImageNegative: string;
  imageEditPrompt: string;
  imageEditSourceImages: string[];
  /** 视觉理解页「带入图片生成」写入；ImageStudio 挂载时 consume 一次 */
  visionCarry: VisionCarryDraft | null;
  setTextToImagePrompt: (v: string) => void;
  setTextToImageNegative: (v: string) => void;
  setImageEditPrompt: (v: string) => void;
  setImageEditSourceImages: (v: string[]) => void;
  setVisionCarry: (draft: VisionCarryDraft | null) => void;
  /** 取出并清空（一次性消费语义） */
  consumeVisionCarry: () => VisionCarryDraft | null;
}

export const useDraftStore = create<DraftState>((set, get) => ({
  textToImagePrompt: '',
  textToImageNegative: '',
  imageEditPrompt: '',
  imageEditSourceImages: [],
  visionCarry: null,
  setTextToImagePrompt: (v) => set({ textToImagePrompt: v }),
  setTextToImageNegative: (v) => set({ textToImageNegative: v }),
  setImageEditPrompt: (v) => set({ imageEditPrompt: v }),
  setImageEditSourceImages: (v) => set({ imageEditSourceImages: v }),
  setVisionCarry: (draft) => set({ visionCarry: draft }),
  consumeVisionCarry: () => {
    const current = get().visionCarry;
    if (current) set({ visionCarry: null });
    return current;
  },
}));
