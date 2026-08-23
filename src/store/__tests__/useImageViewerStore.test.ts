import { describe, it, expect, beforeEach } from 'vitest';
import { useImageViewerStore } from '../useImageViewerStore';

/**
 * 内置图片查看器 store 契约：打开 / 关闭 / 多图循环切换 / 越界钳位 / 空列表拒绝。
 * 缩放 / 平移 / 快捷键属组件内状态（DOM 交互），由源码文本守卫测试覆盖。
 */

describe('useImageViewerStore', () => {
  beforeEach(() => {
    useImageViewerStore.getState().close();
  });

  it('openViewer：空列表拒绝打开；index 缺省 0；越界钳位', () => {
    useImageViewerStore.getState().openViewer([]);
    expect(useImageViewerStore.getState().open).toBe(false);

    useImageViewerStore.getState().openViewer([{ path: 'a.png' }]);
    expect(useImageViewerStore.getState().open).toBe(true);
    expect(useImageViewerStore.getState().index).toBe(0);

    useImageViewerStore.getState().openViewer([{ path: 'a.png' }, { path: 'b.png' }], 9);
    expect(useImageViewerStore.getState().index).toBe(1);
  });

  it('close：关闭并清空（不留旧数据）', () => {
    useImageViewerStore.getState().openViewer([{ path: 'a.png' }], 0);
    useImageViewerStore.getState().close();
    const state = useImageViewerStore.getState();
    expect(state.open).toBe(false);
    expect(state.items).toHaveLength(0);
    expect(state.index).toBe(0);
  });

  it('next / prev：多图循环切换；单图不切换', () => {
    useImageViewerStore.getState().openViewer(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }].map((item, i) => ({ id: item.id, path: `${i}.png` })),
      0,
    );
    const store = useImageViewerStore.getState();
    store.next();
    expect(useImageViewerStore.getState().index).toBe(1);
    useImageViewerStore.getState().next();
    useImageViewerStore.getState().next();
    expect(useImageViewerStore.getState().index).toBe(0); // 循环
    useImageViewerStore.getState().prev();
    expect(useImageViewerStore.getState().index).toBe(2); // 反向循环

    useImageViewerStore.getState().openViewer([{ path: 'only.png' }]);
    useImageViewerStore.getState().next();
    useImageViewerStore.getState().prev();
    expect(useImageViewerStore.getState().index).toBe(0);
  });

  it('setIndex：合法 index 生效；越界忽略', () => {
    useImageViewerStore.getState().openViewer([{ path: 'a.png' }, { path: 'b.png' }]);
    useImageViewerStore.getState().setIndex(1);
    expect(useImageViewerStore.getState().index).toBe(1);
    useImageViewerStore.getState().setIndex(5);
    expect(useImageViewerStore.getState().index).toBe(1);
    useImageViewerStore.getState().setIndex(-1);
    expect(useImageViewerStore.getState().index).toBe(1);
  });
});
