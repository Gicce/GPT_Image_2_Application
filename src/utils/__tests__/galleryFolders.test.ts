import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { matchesGalleryFolder, normalizeGalleryPath } from '../galleryIdentity';

/**
 * V6.6 图库自定义文件夹（ADR-029）：
 * - matchesGalleryFolder：图片按 local_path 归一化前缀归属文件夹（'' = 全部恒真）；
 * - OutputPathPicker：全库唯一输出位置选择器（默认路径 / 图库文件夹 / 浏览）；
 * - Gallery：文件夹筛选下拉 + 新建文件夹入口，创建后切到该文件夹筛选。
 */

describe('matchesGalleryFolder 归属判定', () => {
  test('空文件夹路径 = 全部文件夹恒真', () => {
    expect(matchesGalleryFolder('D:/out/a.png', '')).toBe(true);
    expect(matchesGalleryFolder('D:/out/a.png', null)).toBe(true);
    expect(matchesGalleryFolder(undefined, '')).toBe(true);
  });

  test('文件夹内 / 边界外 / 文件夹本身的文件', () => {
    expect(matchesGalleryFolder('D:/Images/电商主图/a.png', 'D:\\Images\\电商主图')).toBe(true);
    expect(matchesGalleryFolder('d:/images/电商主图/sub/b.png', 'D:/Images/电商主图/')).toBe(true);
    expect(matchesGalleryFolder('D:/Images/电商主图2/c.png', 'D:/Images/电商主图')).toBe(false);
    expect(matchesGalleryFolder('D:/Images/电商主图', 'D:/Images/电商主图')).toBe(true);
  });

  test('与 normalizeGalleryPath 同一归一化规则（分隔符 / 盘符大小写）', () => {
    expect(normalizeGalleryPath('D:\\A\\B.PNG')).toBe(normalizeGalleryPath('d:/a/b.png'));
  });
});

describe('OutputPathPicker 唯一实现契约', () => {
  const pickerSrc = readFileSync(resolve(__dirname, '../../components/OutputPathPicker.tsx'), 'utf8');

  test('默认路径 / 图库文件夹 / 浏览三入口齐备，选择即 onChange 磁盘路径', () => {
    expect(pickerSrc).toContain('默认路径');
    expect(pickerSrc).toContain('useGalleryFolderStore');
    expect(pickerSrc).toContain('props.onChange(hit.path)');
    expect(pickerSrc).toContain('props.onChange(defaultDir)');
    expect(pickerSrc).toContain('api.selectDirectory');
    // 当前值不在选项中时兜底显示自定义目录，不伪造归属
    expect(pickerSrc).toContain('自定义：');
  });
});

describe('Gallery 文件夹筛选与新建入口', () => {
  const gallerySrc = readFileSync(resolve(__dirname, '../../pages/Gallery.tsx'), 'utf8');

  test('工具栏含文件夹下拉 + 新建按钮；筛选走 matchesGalleryFolder 并重置分页', () => {
    expect(gallerySrc).toContain('全部文件夹');
    expect(gallerySrc).toContain('gallery-folder-create');
    expect(gallerySrc).toContain('matchesGalleryFolder(image.local_path, folderPath)');
    expect(gallerySrc).toMatch(/setVisibleCount\(PAGE_SIZE\).*folderPath/);
  });

  test('新建对话框：创建走 store.createFolder（Rust 真实建目录），成功后切到该文件夹', () => {
    expect(gallerySrc).toContain('新建图片库文件夹');
    expect(gallerySrc).toContain('await createFolder(name)');
    expect(gallerySrc).toContain('setFolderPath(folder.path)');
  });
});
