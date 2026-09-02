/**
 * 步骤草稿写穿 Hook（Phase 1.2 §30/§31.1/§85）：
 *  - 本地 state 是输入主载体（打字不重渲染全工作台）；
 *  - 停顿 delayMs 后写穿到 project.uiDraft（updateActive → 600ms 防抖落库）；
 *  - 卸载冲刷：切步骤时未到期的输入同步提交，「切一下 Step 就丢失」为 0。
 * 与挂载恢复配对：Stage 用 useState(() => project.uiDraft?.xxx ?? init) 取初值。
 */

import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export const COMIC_UI_DRAFT_DELAY_MS = 400;

/**
 * @param initial 初值（挂载恢复用；支持 lazy initializer 读取 project.uiDraft）
 * @param commit 写穿回调（组件决定空值如何剥离 uiDraft 键）
 */
export function useDebouncedDraftValue<T>(
  initial: T | (() => T),
  commit: (value: T) => void,
  delayMs: number = COMIC_UI_DRAFT_DELAY_MS,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const inited = useRef(false);
  const synced = useRef<T | null>(null);
  const pending = useRef<T | null>(null);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  useEffect(() => {
    pending.current = value;
    if (!inited.current) {
      inited.current = true;
      synced.current = value;
      return;
    }
    if (value === synced.current) return;
    const timer = setTimeout(() => {
      synced.current = value;
      commitRef.current(value);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  // 卸载冲刷（§85「至少不丢」）：清 timer 后立即提交最后一段未写穿输入
  useEffect(() => () => {
    if (pending.current !== null && pending.current !== synced.current) {
      commitRef.current(pending.current);
    }
  }, []);

  return [value, setValue];
}

/** 文本草稿便捷封装（空串由 commit 侧决定剥离）。 */
export function useDebouncedDraftText(
  initial: string | (() => string),
  commit: (value: string) => void,
  delayMs: number = COMIC_UI_DRAFT_DELAY_MS,
): [string, Dispatch<SetStateAction<string>>] {
  return useDebouncedDraftValue(initial, commit, delayMs);
}
