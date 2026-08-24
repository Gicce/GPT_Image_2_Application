/**
 * 人物替换参考预览 hook（本地重读，不持久化）。
 *
 * 两级加载：先读缓存缩略图（秒开占位），再读真实原图数据替换——
 * 用户需要看清人物的脸、发型、服装与姿势，小裁切缩略图不够用。
 * 原图读取失败（文件被移动等）时保留缩略图，不阻塞面板。
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';

export function useThumb(path: string | undefined): string {
  const [thumbUrl, setThumbUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    // stage=1 表示原图已到位，迟到的缩略图不得覆盖
    let realLoaded = false;
    if (!path) {
      setThumbUrl('');
      return;
    }
    // 第一级：缓存缩略图立即显示
    void api.readThumbnail(path)
      .then(url => { if (!cancelled && !realLoaded) setThumbUrl(url); })
      .catch(() => { if (!cancelled && !realLoaded) setThumbUrl(''); });
    // 第二级：真实原图数据替换（预览要能看清人物细节）
    void api.readImageData(path)
      .then(url => { if (!cancelled) { realLoaded = true; setThumbUrl(url); } })
      .catch(() => { /* 原图读取失败保留缩略图 */ });
    return () => { cancelled = true; };
  }, [path]);
  return thumbUrl;
}
