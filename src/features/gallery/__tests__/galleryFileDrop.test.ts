import { describe, expect, it, vi } from 'vitest';
import {
  createGalleryFileDropController,
  describeImportResult,
  galleryDropOverlayCopy,
  GALLERY_FILE_DROP_INITIAL_STATE,
  type GalleryFileDropConfig,
} from '../galleryFileDrop';
import type { ImportImagesToLibraryResult } from '../../../types';

const PNG = 'D:/Downloads/girl.png';
const JPG = 'D:/Downloads/cat.jpg';
const PDF = 'D:/Downloads/doc.pdf';
const ZIP = 'D:/Downloads/bundle.zip';

function makeResult(partial: Partial<ImportImagesToLibraryResult> = {}): ImportImagesToLibraryResult {
  return { imported: [], skipped: [], failed: [], images: [], ...partial };
}

function makeController(overrides: Partial<GalleryFileDropConfig> = {}) {
  const config: GalleryFileDropConfig = {
    importImages: vi.fn().mockResolvedValue(makeResult()),
    ...overrides,
  };
  const controller = createGalleryFileDropController(config);
  return { controller, config };
}

describe('drop 状态机（enter / over / leave / drop）', () => {
  it('enter（含合法图片）→ overlay 可见且计数正确', async () => {
    const { controller } = makeController();
    await controller.handleEvent({ type: 'enter', paths: [PNG, JPG] });
    const s = controller.getState();
    expect(s.active).toBe(true);
    expect(s.acceptedCount).toBe(2);
    expect(s.rejectedCount).toBe(0);
    expect(s.processing).toBe(false);
  });

  it('混合拖入 → accepted / rejected 双计数', async () => {
    const { controller } = makeController();
    await controller.handleEvent({ type: 'enter', paths: [PNG, JPG, PDF, ZIP] });
    const s = controller.getState();
    expect(s.fileCount).toBe(4);
    expect(s.acceptedCount).toBe(2);
    expect(s.rejectedCount).toBe(2);
  });

  it('over 不改变状态（enter 已激活则保持，未激活不激活）', async () => {
    const { controller } = makeController();
    await controller.handleEvent({ type: 'over' });
    expect(controller.getState().active).toBe(false);

    await controller.handleEvent({ type: 'enter', paths: [PNG] });
    await controller.handleEvent({ type: 'over' });
    expect(controller.getState().active).toBe(true);
  });

  it('leave → overlay 隐藏', async () => {
    const { controller } = makeController();
    await controller.handleEvent({ type: 'enter', paths: [PNG] });
    await controller.handleEvent({ type: 'leave' });
    expect(controller.getState().active).toBe(false);
    // 计数保留（再次 enter 会覆盖）
    expect(controller.getState().acceptedCount).toBe(1);
  });

  it('drop → overlay 关闭、只把合法图片交给导入通道', async () => {
    const importImages = vi.fn().mockResolvedValue(makeResult());
    const { controller } = makeController({ importImages });
    await controller.handleEvent({ type: 'enter', paths: [PNG, PDF, JPG] });
    await controller.handleEvent({ type: 'drop', paths: [PNG, PDF, JPG] });
    expect(controller.getState().active).toBe(false);
    expect(importImages).toHaveBeenCalledTimes(1);
    expect(importImages).toHaveBeenCalledWith([PNG, JPG]);
  });

  it('processing 中重复 drop → 整体忽略（一次松手 = 一次导入）', async () => {
    let release: (() => void) | undefined;
    const importImages = vi.fn().mockImplementation(
      () => new Promise<ImportImagesToLibraryResult>(resolve => { release = () => resolve(makeResult()); }),
    );
    const { controller } = makeController({ importImages });
    const first = controller.handleEvent({ type: 'drop', paths: [PNG] });
    expect(controller.getState().processing).toBe(true);
    // 第二次松手：不触发第二次导入
    await controller.handleEvent({ type: 'drop', paths: [JPG] });
    expect(importImages).toHaveBeenCalledTimes(1);
    // processing 中 enter 也不激活 overlay
    await controller.handleEvent({ type: 'enter', paths: [JPG] });
    expect(controller.getState().active).toBe(false);
    release!();
    await first;
    expect(controller.getState().processing).toBe(false);
  });

  it('全部非法 drop → onEmptyDrop，不调用导入通道', async () => {
    const importImages = vi.fn();
    const onEmptyDrop = vi.fn();
    const { controller } = makeController({ importImages, onEmptyDrop });
    await controller.handleEvent({ type: 'enter', paths: [PDF, ZIP] });
    await controller.handleEvent({ type: 'drop', paths: [PDF, ZIP] });
    expect(onEmptyDrop).toHaveBeenCalledTimes(1);
    expect(importImages).not.toHaveBeenCalled();
    expect(controller.getState().processing).toBe(false);
  });

  it('导入异常 → onImportError 且 processing 复位', async () => {
    const importImages = vi.fn().mockRejectedValue(new Error('请先配置本地导入目录'));
    const onImportError = vi.fn();
    const { controller } = makeController({ importImages, onImportError });
    await controller.handleEvent({ type: 'drop', paths: [PNG] });
    expect(onImportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '请先配置本地导入目录' }),
    );
    expect(controller.getState().processing).toBe(false);
  });

  it('reset → 拖拽态清零（Modal 打开 / 失活场景）', async () => {
    const { controller } = makeController();
    await controller.handleEvent({ type: 'enter', paths: [PNG, PDF] });
    controller.reset();
    expect(controller.getState()).toEqual(GALLERY_FILE_DROP_INITIAL_STATE);
  });

  it('subscribe → 状态变化通知订阅者，取消订阅后不再通知', async () => {
    const { controller } = makeController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.handleEvent({ type: 'enter', paths: [PNG] });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    await controller.handleEvent({ type: 'leave' });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('批量结果（imported / skipped / failed）', () => {
  it('5 拖入：4 成功 1 失败 → 导入通道收 5 个路径，结果如实返回', async () => {
    const result = makeResult({
      imported: [
        { file_name: 'a.png', local_path: 'D:/lib/a.png' },
        { file_name: 'b.png', local_path: 'D:/lib/b.png' },
        { file_name: 'c.png', local_path: 'D:/lib/c.png' },
        { file_name: 'd.png', local_path: 'D:/lib/d.png' },
      ],
      failed: [{ path: 'D:/Downloads/e.png', reason: '复制失败' }],
    });
    const importImages = vi.fn().mockResolvedValue(result);
    const onImportFinish = vi.fn();
    const { controller } = makeController({ importImages, onImportFinish });
    await controller.handleEvent({ type: 'drop', paths: [PNG, JPG, 'D:/a.png', 'D:/b.png', 'D:/c.png'] });
    expect(importImages).toHaveBeenCalledWith([PNG, JPG, 'D:/a.png', 'D:/b.png', 'D:/c.png']);
    const payload = onImportFinish.mock.calls[0][0];
    expect(payload.summary.main.text).toBe('已导入 4 张，1 张失败');
    expect(payload.summary.main.kind).toBe('error');
    expect(payload.summary.failureDetail).toBe('e.png：复制失败');
  });
});

describe('describeImportResult（Toast 文案）', () => {
  it('全部成功 → 已导入 N 张图片', () => {
    const out = describeImportResult(makeResult({ imported: [{ file_name: 'a.png', local_path: 'x' }] }));
    expect(out).toEqual({ main: { text: '已导入 1 张图片', kind: 'success' }, failureDetail: null });
  });

  it('部分失败 → 已导入 N 张，M 张失败 + 失败明细', () => {
    const out = describeImportResult(makeResult({
      imported: new Array(7).fill({ file_name: 'a.png', local_path: 'x' }),
      failed: [{ path: 'D:/x/broken.png', reason: '不支持该文件格式' }],
    }));
    expect(out!.main).toEqual({ text: '已导入 7 张，1 张失败', kind: 'error' });
    expect(out!.failureDetail).toBe('broken.png：不支持该文件格式');
  });

  it('全部失败（0 导入 0 跳过）→ 没有可导入的图片', () => {
    const out = describeImportResult(makeResult({ failed: [{ path: PDF, reason: '不支持该文件格式' }] }));
    expect(out!.main).toEqual({ text: '没有可导入的图片', kind: 'error' });
  });

  it('已在图片库 → 已在图片库中提示', () => {
    const out = describeImportResult(makeResult({
      imported: [{ file_name: 'a.png', local_path: 'x' }],
      skipped: [{ path: 'D:/lib/b.png', reason: '已在图片库目录中' }],
    }));
    expect(out!.main.text).toBe('已导入 1 张图片，1 张已在图片库中');
    expect(out!.main.kind).toBe('success');
  });

  it('空结果 → null（不弹 Toast）', () => {
    expect(describeImportResult(makeResult())).toBeNull();
  });
});

describe('galleryDropOverlayCopy（Overlay 文案）', () => {
  it('纯合法多图 → 释放即可导入 N 张图片', () => {
    const copy = galleryDropOverlayCopy({ ...GALLERY_FILE_DROP_INITIAL_STATE, active: true, fileCount: 6, acceptedCount: 6 });
    expect(copy.title).toBe('释放即可导入 6 张图片');
    expect(copy.hint).toBe('图片将保存到 CyImagePro 图片库');
    expect(copy.formats).toBe('PNG · JPG · JPEG · WebP');
    expect(copy.warning).toBe('');
  });

  it('单张 → 释放即可导入图片', () => {
    const copy = galleryDropOverlayCopy({ ...GALLERY_FILE_DROP_INITIAL_STATE, active: true, fileCount: 1, acceptedCount: 1 });
    expect(copy.title).toBe('释放即可导入图片');
  });

  it('混合 → 可导入 N 张图片 + 不支持计数', () => {
    const copy = galleryDropOverlayCopy({ ...GALLERY_FILE_DROP_INITIAL_STATE, active: true, fileCount: 6, acceptedCount: 4, rejectedCount: 2 });
    expect(copy.title).toBe('可导入 4 张图片');
    expect(copy.warning).toBe('2 个文件不支持');
  });

  it('全部非法 → 没有可导入的图片 + 支持格式说明', () => {
    const copy = galleryDropOverlayCopy({ ...GALLERY_FILE_DROP_INITIAL_STATE, active: true, fileCount: 2, acceptedCount: 0, rejectedCount: 2 });
    expect(copy.title).toBe('没有可导入的图片');
    expect(copy.hint).toBe('仅支持 PNG、JPG、JPEG、WebP 图片');
  });
});
