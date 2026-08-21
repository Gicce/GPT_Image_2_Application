import { describe, it, expect } from 'vitest';
import {
  INVALID_IMAGE_DROP_TOAST,
  canonicalImagePath,
  fileNameOfPath,
  isDroppableImagePath,
  mergeSourceImages,
  splitDroppedPaths,
} from '../imageDropFiles';

/**
 * 拖拽图片统一入口（V4.0.8）：
 * 图片生成参考图 / AI 对话附件 / 视觉理解共用同一套路径判定与去重。
 */

describe('isDroppableImagePath', () => {
  it('接受 PNG / JPG / JPEG / WebP（大小写不敏感）', () => {
    for (const path of ['a.png', 'b.JPG', 'c.Jpeg', 'd.webp', 'E.PNG', 'f.WebP']) {
      expect(isDroppableImagePath(path)).toBe(true);
    }
  });

  it('拒绝非图片与目录路径', () => {
    for (const path of ['notes.txt', 'setup.exe', 'pack.zip', 'C:/some/folder', 'archive.tar.gz', '']) {
      expect(isDroppableImagePath(path)).toBe(false);
    }
  });
});

describe('splitDroppedPaths（混拖：合法图片与非法文件分流）', () => {
  it('2 张图片 + 1 个 txt → 图片全部保留，非法文件单独报告', () => {
    const { images, invalid } = splitDroppedPaths([
      'D:/pics/a.png',
      'D:/pics/b.jpg',
      'D:/notes.txt',
    ]);
    expect(images.map(item => item.name)).toEqual(['a.png', 'b.jpg']);
    expect(invalid).toEqual(['D:/notes.txt']);
  });

  it('解析出的 name 取路径最后一段（含反斜杠路径）', () => {
    const { images } = splitDroppedPaths(['C:\\Users\\me\\照片.webp']);
    expect(images[0]).toEqual({ path: 'C:\\Users\\me\\照片.webp', name: '照片.webp' });
  });

  it('全部非法 → images 为空，不抛异常', () => {
    const { images, invalid } = splitDroppedPaths(['x.exe', 'y.txt']);
    expect(images).toHaveLength(0);
    expect(invalid).toHaveLength(2);
  });
});

describe('canonicalImagePath（身份判定唯一逻辑）', () => {
  it('反斜杠 / 正斜杠、大小写差异归一为同一身份（本地选择 vs 图库记录）', () => {
    expect(canonicalImagePath('D:\\Pics\\Ref.PNG')).toBe(canonicalImagePath('d:/pics/ref.png'));
    expect(fileNameOfPath('D:\\a\\b\\c.jpg')).toBe('c.jpg');
  });
});

describe('mergeSourceImages（三个入口共用合并 / 去重）', () => {
  it('同一张图连续拖两次 → 第二次判定重复，不产生重复条目', () => {
    const first = mergeSourceImages([], [{ path: 'D:/pics/a.png', name: 'a.png' }]);
    const second = mergeSourceImages(first.images, [{ path: 'D:/pics/a.png', name: 'a.png' }]);
    expect(second.images).toHaveLength(1);
    expect(second.added).toHaveLength(0);
    expect(second.duplicates).toEqual(['D:/pics/a.png']);
  });

  it('本地反斜杠路径与图库正斜杠路径指向同一文件 → 判定重复', () => {
    const base = mergeSourceImages([], [{ path: 'D:\\gallery\\out.png', name: 'out.png' }]);
    const merged = mergeSourceImages(base.images, [{ path: 'D:/gallery/out.png', name: 'out.png' }]);
    expect(merged.images).toHaveLength(1);
    expect(merged.duplicates).toHaveLength(1);
  });

  it('多文件追加保持顺序：已有在前、新图按拖入顺序', () => {
    const base = mergeSourceImages([], [{ path: 'a.png', name: 'a.png' }]);
    const merged = mergeSourceImages(base.images, [
      { path: 'b.png', name: 'b.png' },
      { path: 'c.png', name: 'c.png' },
    ]);
    expect(merged.images.map(item => item.name)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(merged.added.map(item => item.name)).toEqual(['b.png', 'c.png']);
  });

  it('混拖中重复 + 新图并存：只追加新图，重复被记录', () => {
    const base = mergeSourceImages([], [{ path: 'a.png', name: 'a.png' }]);
    const merged = mergeSourceImages(base.images, [
      { path: 'A.PNG', name: 'A.PNG' },
      { path: 'new.webp', name: 'new.webp' },
    ]);
    expect(merged.images.map(item => item.name)).toEqual(['a.png', 'new.webp']);
    expect(merged.duplicates).toEqual(['A.PNG']);
  });
});

describe('提示文案常量', () => {
  it('非法拖入提示列出全部支持格式', () => {
    expect(INVALID_IMAGE_DROP_TOAST).toBe('仅支持 PNG、JPG、JPEG、WebP 图片。');
  });
});
