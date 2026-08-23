import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 图片库拖拽导入（V4.1）接入守卫（源码文本断言）：
 * - 拖拽导入必须复用唯一入库 Pipeline（Rust import_images_to_library → sync_images），
 *   页面 / Overlay 组件内禁止出现第二套导入或来源判定逻辑；
 * - Modal（详情 / 全局 ImageViewer）打开时 Gallery 拖拽必须停用；
 * - Gallery 作用域：只有 Gallery 页挂载 useGalleryFileDrop。
 */

const gallerySrc = readFileSync(resolve(__dirname, '../Gallery.tsx'), 'utf-8');
const overlaySrc = readFileSync(resolve(__dirname, '../../components/GalleryDropOverlay.tsx'), 'utf-8');
const hookSrc = readFileSync(resolve(__dirname, '../../hooks/useGalleryFileDrop.ts'), 'utf-8');
const controllerSrc = readFileSync(resolve(__dirname, '../../features/gallery/galleryFileDrop.ts'), 'utf-8');

describe('Gallery 拖拽导入接入', () => {
  test('Gallery 页挂载 useGalleryFileDrop 并渲染 GalleryDropOverlay', () => {
    expect(gallerySrc).toContain("from '../hooks/useGalleryFileDrop'");
    expect(gallerySrc).toContain("from '../components/GalleryDropOverlay'");
    expect(gallerySrc).toMatch(/<GalleryDropOverlay state=\{dropState\} \/>/);
  });

  test('Modal 优先级：详情 Modal / 全局 ImageViewer 打开时停用拖拽', () => {
    expect(gallerySrc).toMatch(/useGalleryFileDrop\(\{ enabled: !preview && !viewerOpen \}\)/);
    expect(gallerySrc).toMatch(/useImageViewerStore\(s => s\.open\)/);
  });

  test('页面不写导入 / 来源逻辑：无 invoke、无 source_kind、无拖拽来源硬编码', () => {
    expect(gallerySrc).not.toContain("invoke('import_images_to_library'");
    expect(gallerySrc).not.toContain('source_kind');
    expect(gallerySrc).not.toMatch(/dragged.*本地/);
    expect(gallerySrc).not.toContain("'library_input'");
  });

  test('Overlay 是纯 UI：不调用 api / invoke、不持有导入状态机', () => {
    expect(overlaySrc).not.toMatch(/\bapi\./);
    expect(overlaySrc).not.toContain('invoke(');
    expect(overlaySrc).not.toMatch(/import.*useGalleryFileDrop/);
    // 文案全部来自 galleryDropOverlayCopy（禁止组件内拼中文提示）
    expect(overlaySrc).toMatch(/galleryDropOverlayCopy\(props\.state\)/);
    expect(overlaySrc).not.toContain('释放即可导入');
  });

  test('导入通道唯一：Hook 只经 api.importImagesToLibrary，controller 只调用注入的 importImages', () => {
    expect(hookSrc).toMatch(/api\.importImagesToLibrary\(paths\)/);
    expect(hookSrc).not.toContain('invoke(');
    expect(controllerSrc).toMatch(/config\.importImages\(paths\)/);
    // 控制器绝不写来源（注释里提及术语可以，赋值 / 字段写入禁止）/ 绝不直接建索引
    expect(controllerSrc).not.toMatch(/source_kind\s*[:=]/);
    expect(controllerSrc).not.toContain('getImages');
    expect(controllerSrc).not.toContain('rescanImageLibrary');
  });

  test('图库刷新只接受 Rust 返回的全量列表（不 push 到数组头）', () => {
    expect(hookSrc).toMatch(/useImageStore\.getState\(\)\.applyImages\(images\)/);
    expect(hookSrc).not.toMatch(/images\.push|unshift/);
  });
});

describe('拖拽导入作用域（只有 Gallery 页响应文件 Drop）', () => {
  test('useGalleryFileDrop 只被 Gallery.tsx 引用', () => {
    const pages = ['AgentChat.tsx', 'Chat.tsx', 'ImageStudio.tsx', 'VisionUnderstanding.tsx', 'TaskQueue.tsx', 'History.tsx', 'Settings.tsx', 'Account.tsx', 'About.tsx', 'Auth.tsx', 'CreateTask.tsx', 'ImageEdit.tsx'];
    for (const page of pages) {
      const text = readFileSync(resolve(__dirname, '..', page), 'utf-8');
      expect(text).not.toContain('useGalleryFileDrop');
    }
  });
});
