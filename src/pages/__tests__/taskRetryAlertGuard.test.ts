import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Native Alert 守卫（spec §32）：
 * 任务队列 / 重试相关页面禁止 window.alert / alert / confirm 阻塞弹窗，
 * 重试与提交反馈一律走应用内 Toast（useToastStore）。
 */

const GUARD_FILES = [
  'pages/TaskQueue.tsx',
  'components/EditTaskModal.tsx',
  'components/BatchRedoModal.tsx',
  'components/DeleteTaskDialog.tsx',
  'utils/taskNavigation.ts',
];

/** 匹配调用点（忽略注释里的词）；覆盖 window.alert( / alert( / confirm( */
const NATIVE_DIALOG_RE = /(?:window\.)?(?:alert|confirm|prompt)\s*\(/g;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('taskRetryAlertGuard · 任务重试链路禁止 native alert/confirm', () => {
  for (const file of GUARD_FILES) {
    it(`${file} 不包含 native alert/confirm/prompt 调用`, () => {
      const source = readFileSync(resolve(__dirname, '../..', file), 'utf-8');
      const code = stripComments(source);
      const matches = code.match(NATIVE_DIALOG_RE) ?? [];
      expect(matches, `${file} 发现 native 弹窗调用: ${matches.join(', ')}`).toEqual([]);
    });
  }

  it('重试反馈使用应用 Toast 系统（Toast.tsx 导出的 toastSuccess/toastError）', () => {
    const taskQueue = readFileSync(resolve(__dirname, '../TaskQueue.tsx'), 'utf-8');
    expect(taskQueue).toMatch(/toastSuccess\(/);
    expect(taskQueue).toMatch(/toastError\(/);
  });
});
