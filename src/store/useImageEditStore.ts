import { create } from 'zustand';

/**
 * 图库 → 图片编辑的一次性入口上下文。
 *
 * 跨页面传递（图库 / 其他页面 → 图片生成工作台的图生图模式）。
 * 内存级、一次性消费（consume 后清空）：
 *  - 不写 localStorage / 持久设置，重启即清；
 *  - 消费后残留为 null，不会污染下一次普通文生图。
 */
export interface ImageEditEntry {
  /** 源图本地路径（图片生成工作台据此挂载参考图） */
  sourcePath: string;
  fileName: string;
  /** 来源图库记录 ID */
  sourceImageId?: string;
  /** 来源任务 ID（查看任务 / 详情追溯） */
  sourceTaskId?: string;
  /** 原始需求（带入新需求输入框作参考，不自动提交） */
  prefillRequirement?: string;
}

interface ImageEditEntryState {
  pending: ImageEditEntry | null;
  begin: (entry: ImageEditEntry) => void;
  /** 挂载时消费一次；无上下文返回 null */
  consume: () => ImageEditEntry | null;
  clear: () => void;
}

export const useImageEditStore = create<ImageEditEntryState>((set, get) => ({
  pending: null,
  begin: entry => set({ pending: entry }),
  consume: () => {
    const entry = get().pending;
    if (entry) set({ pending: null });
    return entry;
  },
  clear: () => set({ pending: null }),
}));
