import { create } from 'zustand';

// 内存级草稿，重启应用清空
interface DraftState {
  textToImagePrompt: string;
  textToImageNegative: string;
  imageEditPrompt: string;
  imageEditSourceImages: string[];
  setTextToImagePrompt: (v: string) => void;
  setTextToImageNegative: (v: string) => void;
  setImageEditPrompt: (v: string) => void;
  setImageEditSourceImages: (v: string[]) => void;
}

export const useDraftStore = create<DraftState>((set) => ({
  textToImagePrompt: '',
  textToImageNegative: '',
  imageEditPrompt: '',
  imageEditSourceImages: [],
  setTextToImagePrompt: (v) => set({ textToImagePrompt: v }),
  setTextToImageNegative: (v) => set({ textToImageNegative: v }),
  setImageEditPrompt: (v) => set({ imageEditPrompt: v }),
  setImageEditSourceImages: (v) => set({ imageEditSourceImages: v }),
}));
