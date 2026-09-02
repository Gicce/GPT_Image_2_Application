/**
 * 漫画面板缩略图加载（展示专用，readThumbnail）：
 * 按 panel.imageAsset.path 批量取缩略图，缺图 / 读失败静默为空（占位由 UI 兜底）。
 * 纯展示辅助——不进 store、不触碰语义状态。
 */

import { useEffect, useState } from 'react';
import { api } from '../../../services/api';
import type { ComicPanel } from '../types';

export function useComicPanelThumbs(panels: ComicPanel[]): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const wanted = panels.filter(panel => panel.imageAsset?.path);
    if (wanted.length === 0) return;
    void Promise.all(wanted.map(async panel => {
      try {
        return [panel.id, await api.readThumbnail(panel.imageAsset!.path)] as const;
      } catch {
        return [panel.id, ''] as const;
      }
    })).then(entries => {
      if (!alive) return;
      setThumbs(Object.fromEntries(entries.filter(([, data]) => data)));
    });
    return () => { alive = false; };
  }, [panels]);

  return thumbs;
}
