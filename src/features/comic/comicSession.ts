/**
 * 漫画工作台会话恢复（Phase 1.2 §85）：刷新 / 重开应用后回到
 * 「上次打开的项目 + 上次所在步骤」。sessionStorage（会话级）：
 *  - 刷新（F5 / webview reload）→ 恢复；
 *  - 正常回到项目库 / 关闭项目 → 主动清除，下次不自动进入。
 * 纯函数 + 可注入 storage（node vitest 无 sessionStorage 也能测）。
 */

import { normalizeComicStepId, type ComicStudioStepId } from './comicStudioFlow';

const COMIC_SESSION_KEY = 'cyimagepro.comic.session';
const COMIC_SESSION_STEPS: readonly ComicStudioStepId[] = [
  'story', 'skill', 'characters', 'storyboard', 'generate', 'text',
];

export interface ComicSessionSnapshot {
  projectId: string;
  viewStep: ComicStudioStepId;
  savedAt: string;
}

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** node / 测试环境无 sessionStorage → null（调用方视为无会话可恢复）。 */
function resolveStorage(): SessionStorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readComicSession(storage: SessionStorageLike | null = resolveStorage()): ComicSessionSnapshot | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(COMIC_SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ComicSessionSnapshot>;
    // V4.2.11 §D：旧步骤 id（anchor/panels）读入即映射到 generate
    const step = typeof parsed.viewStep === 'string' ? normalizeComicStepId(parsed.viewStep) : null;
    if (
      typeof parsed.projectId === 'string' && parsed.projectId
      && step !== null
      && (COMIC_SESSION_STEPS as readonly string[]).includes(step)
    ) {
      return {
        projectId: parsed.projectId,
        viewStep: step,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeComicSession(
  snapshot: Omit<ComicSessionSnapshot, 'savedAt'>,
  storage: SessionStorageLike | null = resolveStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(COMIC_SESSION_KEY, JSON.stringify({ ...snapshot, savedAt: new Date().toISOString() }));
  } catch {
    // 存储不可写（隐私模式 / 配额）→ 会话恢复降级为不可用，不影响主流程
  }
}

export function clearComicSession(storage: SessionStorageLike | null = resolveStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(COMIC_SESSION_KEY);
  } catch {
    // 同上：清理失败无副作用
  }
}
