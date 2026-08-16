/**
 * 任务修订意图判别（Task Revision Intent）。
 *
 * 历史问题（本轮 bug 根因之二）：
 *   用户先被误判成批量任务（proposal status='draft', batch_items=3），
 *   然后说 "我不要批量任务 我要单张"。
 *   旧链路里这句话：
 *     - 不是确认执行信号（isExecutionConfirmationSignal 不匹配）
 *     - 不是新任务（isLikelyNewTaskMessage 需要强任务动词）
 *     - isLikelyReferentialFollowUp 也不匹配（只认"脸不要变"类约束）
 *   → 落进 follow_up → applyDraftFollowUp 返回 null → 退化成普通聊天回复。
 *   旧批量 proposal 仍是 status='draft'，用户接着说"确认执行"时，
 *   resolveExecutionIntentFromContext 找到的还是旧批量 proposal，
 *   createTaskFromProposal 以 batch / count=3 入队 → 生成 3 张图。
 *
 * 本模块职责：
 *   1. detectTaskRevisionIntent：识别"对当前待确认任务的修订指令"
 *      （我不要批量 / 我要单张 / 改成一张图 / 不要 3 张……）。
 *   2. buildTaskRevisionPlan：把修订指令转成对旧 plan 的结构化修正 ——
 *      batch → single 时必须清空 batch_items / batch_strategy / variant_plan /
 *      count，绝不允许只改文案留旧结构。
 */

import { resolveOutputStructure } from './compositionIntentResolver';

export interface TaskRevisionDirective {
  /** 是否为任务修订指令。 */
  isRevision: boolean;
  /** 修订后的输出模式。 */
  outputMode?: 'single' | 'batch';
  /** 修订证据（诊断 / 测试断言）。 */
  evidence: string[];
}

/**
 * 否定批量 + 主张单张的表达。
 * 必须同时出现"否定批量"和"要单张"两组信号中的至少各一（或强单张信号单独出现）。
 */
const REJECT_BATCH_PATTERN = /(不要批量|不是批量|取消批量|别批量|不用批量|批量取消|不要\s*\d*\s*张|不要\s*\d+\s*张图|别生成\s*\d+\s*张|不要多张|不需要多张)/;

const WANT_SINGLE_PATTERN = /(我要单张|要单张|只要单张|就一张|只要一张|改成一张|改成单张|做成一张|生成一张|单张图|一张图就好|只需要一张|就出一张|合并成一张|放一张图里|一张图里展示)/;

/** 强单张信号：单独出现也足以构成修订（用户明确纠正输出形态）。 */
const STRONG_SINGLE_PATTERN = /(我不要批量任务|不要批量任务|我要单张|我只要单张|改成单张|不是批量是单张)/;

/**
 * 判别用户输入是否是对当前待确认任务的修订指令。
 */
export function detectTaskRevisionIntent(text: string): TaskRevisionDirective {
  const trimmed = (text || '').trim();
  if (!trimmed) return { isRevision: false, evidence: [] };

  const rejectsBatch = REJECT_BATCH_PATTERN.test(trimmed);
  const wantsSingle = WANT_SINGLE_PATTERN.test(trimmed);
  const strongSingle = STRONG_SINGLE_PATTERN.test(trimmed);

  const evidence: string[] = [];
  if (rejectsBatch) evidence.push('否定批量');
  if (wantsSingle) evidence.push('要求单张');

  // 组合判定：明确否定批量 + 要求单张，或强单张纠正语句。
  if (strongSingle || (rejectsBatch && wantsSingle)) {
    // 交叉验证 composition resolver：如果同一句话里出现"生成3张"这类
    // 明确批量信号，则不是"改成单张"的修订（防止误拦真正的批量新任务）。
    const structure = resolveOutputStructure(trimmed);
    if (structure.kind !== 'batch_images' || rejectsBatch) {
      return { isRevision: true, outputMode: 'single', evidence: [...evidence, 'revision→single'] };
    }
  }

  return { isRevision: false, evidence };
}

/**
 * 构造"任务已修订"合并文本：原任务 + 用户修订指令，送入 Planner 重新规划。
 * 结构上与 clarification 续接文本类似 —— 让 Planner 看到"这是同一个任务的修订版"。
 */
export function buildTaskRevisionContinuationText(input: {
  originalRequest: string;
  revisionInstruction: string;
}): string {
  const lines: string[] = [];
  lines.push('[任务修订上下文]');
  lines.push('- 以下是同一个任务的"原始需求 + 用户修订指令"，必须视为该任务的修订版（revision），不是独立新任务。');
  lines.push('');
  lines.push('[原始任务]');
  lines.push(input.originalRequest || '(无)');
  lines.push('');
  lines.push('[用户修订指令]');
  lines.push(input.revisionInstruction || '(无)');
  lines.push('');
  lines.push('请基于修订指令重新规划。特别注意：');
  lines.push('- 如果修订指令把批量改成单张（例如"我不要批量任务 我要单张"），输出数量必须是 1 张，禁止任何批量子任务结构。');
  lines.push('- 如果原始需求含"三分镜 / 九宫格 / 一张图里展示多个主体"等复合构图表达，应规划为单张图内部的复合构图（每个分格绑定一个明确主体），不是多张图。');
  lines.push('- final_prompt 必须明确描述单张图内部的分格布局与每格主体。');
  return lines.join('\n');
}
