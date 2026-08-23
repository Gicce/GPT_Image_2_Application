/**
 * Prompt Diff（视觉理解「修改对比」唯一实现）：
 *  - tokenizePrompt：CJK 逐字 / 拉丁字母数字连串成词 / 标点单字 / 空白归并 ——
 *    中文、英文、标点都能得到稳定 token 流（禁整段判成删除+新增）；
 *  - computePromptDiff：先裁公共前后缀，再 LCS DP（token 数超限时整体替换兜底），
 *    输出 equal / removed / added 三类连续片段（removed 恒在 added 之前）。
 * 纯函数、无 IO；配色由 CSS Token（--diff-*）承担，本模块不感知 UI。
 */

export type PromptDiffSegmentType = 'equal' | 'removed' | 'added';

export interface PromptDiffSegment {
  type: PromptDiffSegmentType;
  text: string;
}

export interface PromptDiffResult {
  segments: PromptDiffSegment[];
  addedCount: number;
  removedCount: number;
}

/** 单个 token 超过该 token 数时不再做 LCS（DP 矩阵过大），整体替换。 */
const MAX_TOKENS = 3000;

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;
const LATIN_RE = /[A-Za-z0-9]/;

/** 文本 → token 流（保留空白 token，保证片段拼接可还原原文）。 */
export function tokenizePrompt(text: string): string[] {
  const tokens: string[] = [];
  let buffer = '';
  let bufferKind: 'cjk' | 'latin' | 'space' | 'other' | '' = '';

  const flush = () => {
    if (buffer) tokens.push(buffer);
    buffer = '';
    bufferKind = '';
  };

  for (const ch of text) {
    const kind: 'cjk' | 'latin' | 'space' | 'other' = /\s/.test(ch)
      ? 'space'
      : CJK_RE.test(ch)
        ? 'cjk'
        : LATIN_RE.test(ch)
          ? 'latin'
          : 'other';
    // CJK 逐字、拉丁连串、空白连串、标点逐字：同类连续才合并
    if (bufferKind && (kind === bufferKind) && (kind === 'latin' || kind === 'space')) {
      buffer += ch;
    } else {
      flush();
      buffer = ch;
      bufferKind = kind;
    }
  }
  flush();
  return tokens;
}

/** 裁掉公共前缀 / 后缀（典型改动只动中间一段，直接把 DP 规模砍到差异区）。 */
function trimCommon(
  oldTokens: string[],
  newTokens: string[],
): { prefix: string[]; suffix: string[]; oldCore: string[]; newCore: string[] } {
  let start = 0;
  while (start < oldTokens.length && start < newTokens.length && oldTokens[start] === newTokens[start]) {
    start++;
  }
  let endOld = oldTokens.length;
  let endNew = newTokens.length;
  while (endOld > start && endNew > start && oldTokens[endOld - 1] === newTokens[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return {
    prefix: oldTokens.slice(0, start),
    suffix: oldTokens.slice(endOld),
    oldCore: oldTokens.slice(start, endOld),
    newCore: newTokens.slice(start, endNew),
  };
}

/**
 * LCS 回溯方向（Uint8 编码）：0 = 左移（old 删除）、1 = 上移（new 新增）、2 = 左上（相等）。
 */
function diffCore(oldCore: string[], newCore: string[]): PromptDiffSegment[] {
  const n = oldCore.length;
  const m = newCore.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: 'added', text: newCore.join('') }];
  if (m === 0) return [{ type: 'removed', text: oldCore.join('') }];

  // DP 长度表（滚动一维）+ 方向表（n+1)*(m+1)
  const width = m + 1;
  const dir = new Uint8Array((n + 1) * width);
  const lens = new Uint32Array(width);
  for (let i = 1; i <= n; i++) {
    let prevDiag = lens[0];
    const oldToken = oldCore[i - 1];
    for (let j = 1; j <= m; j++) {
      const above = lens[j];
      if (oldToken === newCore[j - 1]) {
        lens[j] = prevDiag + 1;
        dir[i * width + j] = 2;
      } else if (above >= lens[j - 1]) {
        lens[j] = above;
        dir[i * width + j] = 1;
      } else {
        lens[j] = lens[j - 1];
        dir[i * width + j] = 0;
      }
      prevDiag = above;
    }
  }

  // 回溯（终点 → 起点），再整体反转
  const reversed: PromptDiffSegment[] = [];
  let i = n;
  let j = m;
  const pushToken = (type: PromptDiffSegmentType, token: string) => {
    const last = reversed[reversed.length - 1];
    if (last && last.type === type) last.text = token + last.text;
    else reversed.push({ type, text: token });
  };
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dir[i * width + j] === 2) {
      pushToken('equal', oldCore[i - 1]);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dir[i * width + j] === 1)) {
      pushToken('added', newCore[j - 1]);
      j--;
    } else {
      pushToken('removed', oldCore[i - 1]);
      i--;
    }
  }
  return reversed.reverse();
}

function countTokens(segments: PromptDiffSegment[], type: PromptDiffSegmentType): number {
  return segments.filter(seg => seg.type === type).reduce((acc, seg) => acc + tokenizeLength(seg.text), 0);
}

function tokenizeLength(text: string): number {
  // 粗粒度计数（字符数）即可满足「改了多少」的展示语义，避免重复 tokenize
  return [...text].length;
}

/** 全文 Prompt Diff：oldText → newText 的 equal / removed / added 片段序列。 */
export function computePromptDiff(oldText: string, newText: string): PromptDiffResult {
  const oldTokens = tokenizePrompt(oldText);
  const newTokens = tokenizePrompt(newText);
  if (oldTokens.length === 0 && newTokens.length === 0) {
    return { segments: [], addedCount: 0, removedCount: 0 };
  }
  if (oldTokens.length > MAX_TOKENS || newTokens.length > MAX_TOKENS) {
    const segments: PromptDiffSegment[] = [];
    if (oldText) segments.push({ type: 'removed', text: oldText });
    if (newText) segments.push({ type: 'added', text: newText });
    return {
      segments,
      addedCount: tokenizeLength(newText),
      removedCount: tokenizeLength(oldText),
    };
  }
  const { prefix, suffix, oldCore, newCore } = trimCommon(oldTokens, newTokens);
  const segments: PromptDiffSegment[] = [];
  if (prefix.length > 0) segments.push({ type: 'equal', text: prefix.join('') });
  segments.push(...diffCore(oldCore, newCore));
  if (suffix.length > 0) segments.push({ type: 'equal', text: suffix.join('') });
  return {
    segments,
    addedCount: countTokens(segments, 'added'),
    removedCount: countTokens(segments, 'removed'),
  };
}

/** 维度级语义 Diff（维度卡「原 / 新」对比）：整值替换语义，不做维度内逐字 diff。 */
export interface DimensionDiff {
  changed: boolean;
  oldValue: string;
  newValue: string;
}

export function dimensionDiff(oldValue: string | undefined, newValue: string | undefined): DimensionDiff {
  const oldText = (oldValue ?? '').trim();
  const newText = (newValue ?? '').trim();
  return { changed: oldText !== newText, oldValue: oldText, newValue: newText };
}
