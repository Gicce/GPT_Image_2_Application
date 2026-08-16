/**
 * Conversation 一键复制导出 —— 纯函数 formatter。
 *
 * 核心原则（spec 第五节）：
 *   - 禁止 DOM selection / innerText 复制（会带出 "0 tokens"、"CA / GC" 头像缩写、
 *     Task 卡 JSON、加粗标记混乱等问题）。
 *   - 从 Conversation 原始 message 数据生成干净的 Markdown。
 *   - 技术字段（message id / conversation id / plannerJobId / planningRequestId /
 *     pendingParams / token 计数 / localPath / diagnostic JSON）一律不导出。
 *   - 用户可见错误（例如 "❌ 上游模型接口失败…"）保留 —— 它是聊天历史的一部分。
 *
 * 职责边界（spec 一百一十五节）：本模块只负责"导出成人类可读文本"，
 * 不参与 Chat 语义解析（那是 chatExecutionContext 的职责）。
 */

import type { ChatConversation, ChatMessage, TaskMessageState } from '../types';
import { formatDuration } from './taskDuration';

export interface ConversationExportOptions {
  /** 角色显示名。默认 user → "用户"，assistant → agentName 或 "CyImage Agent"。 */
  userName?: string;
  agentName?: string;
}

const STAGE_STATUS_LABEL: Record<string, string> = {
  planning: '规划中',
  planning_failed: '规划失败',
  needs_clarification: '待补充信息',
  waiting_confirm: '待确认',
  queued: '排队中',
  analyzing: '分析中',
  running: '执行中',
  saving: '保存中',
  success: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const TASK_TYPE_LABEL: Record<string, string> = {
  generate: '文生图',
  edit: '图生图',
  remove_background: '去背景',
};

function roleLabel(message: ChatMessage, options: ConversationExportOptions): string {
  if (message.role === 'user') return options.userName || '用户';
  return options.agentName || 'CyImage Agent';
}

const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function attachmentLine(count: number): string {
  const labels = Array.from({ length: count }, (_, i) =>
    i < CHINESE_NUMERALS.length ? `图${CHINESE_NUMERALS[i]}` : `图${i + 1}`);
  return `附件：${labels.map(label => `- ${label}`).join(' ')}`;
}

function formatTaskMessage(tm: TaskMessageState): string {
  const lines: string[] = [];
  const statusLabel = STAGE_STATUS_LABEL[tm.stage] || tm.stage;
  lines.push(`状态：${statusLabel}`);

  if (tm.taskType) {
    const typeLabel = TASK_TYPE_LABEL[tm.taskType] || tm.taskType;
    lines.push(`类型：${typeLabel}`);
  }
  if (tm.executionModel) lines.push(`执行模型：${tm.executionModel}`);
  if (tm.size) lines.push(`尺寸：${tm.size}`);
  lines.push('来源：对话自动识别');

  // 布局（九宫格等）—— Handoff 任务卡会写入 gridLayout。
  const grid = tm.gridLayout;
  if (grid && grid.rows > 0 && grid.columns > 0) {
    lines.push(`布局：${grid.rows}×${grid.columns} 九宫格（${grid.cellCount} 格）`);
    if (grid.cells && grid.cells.length > 0) {
      lines.push('九宫格内容：');
      grid.cells.forEach(cell => {
        lines.push(`- 格${cell.index}：${cell.label}`);
      });
    }
  }
  if (tm.contextSourceLabel) {
    lines.push(`上下文来源：${tm.contextSourceLabel}`);
  }

  if (tm.prompt) {
    lines.push('');
    lines.push('原始需求：');
    lines.push(tm.prompt);
  }
  if (tm.finalPrompt) {
    lines.push('');
    lines.push('最终提示词：');
    lines.push(tm.finalPrompt);
  }
  if (tm.finalNegativePrompt) {
    lines.push('');
    lines.push('负面提示词：');
    lines.push(tm.finalNegativePrompt);
  }

  // 附件：只显示语义标签（图一 / 图二 / 图三），绝不导出 localPath / 文件名。
  const attachmentCount = Math.max(
    tm.orderedAttachments?.length ?? 0,
    tm.attachmentDescriptors?.length ?? 0,
  );
  if (attachmentCount > 0) {
    lines.push('');
    lines.push(attachmentLine(attachmentCount));
  }

  // 执行耗时（spec 七十节）：完成任务显示最终耗时；执行中显示当前已执行。
  if (tm.executionDurationMs != null) {
    const formatted = formatDuration(tm.executionDurationMs);
    if (formatted) {
      lines.push('');
      lines.push(tm.stage === 'failed' ? `失败 · 耗时 ${formatted}` : `执行耗时：${formatted}`);
    }
  } else if (tm.executionStartedAt && (tm.stage === 'running' || tm.stage === 'queued' || tm.stage === 'analyzing' || tm.stage === 'saving')) {
    const elapsed = Date.now() - Date.parse(tm.executionStartedAt);
    if (Number.isFinite(elapsed) && elapsed > 0) {
      const formatted = formatDuration(elapsed);
      if (formatted) {
        lines.push('');
        lines.push(`当前已执行：${formatted}`);
      }
    }
  }

  // 用户可见错误保留（是聊天历史的一部分），但不导出 plannerDiagnostic /
  // executionDiagnostic 等 JSON。
  if (tm.error && (tm.stage === 'failed' || tm.stage === 'interrupted' || tm.stage === 'cancelled' || tm.stage === 'planning_failed')) {
    lines.push('');
    lines.push(`错误信息：${tm.error}`);
  }

  if (tm.stage === 'needs_clarification' && tm.clarification?.question) {
    lines.push('');
    lines.push('需要补充：');
    lines.push(tm.clarification.question);
  }

  return lines.join('\n');
}

/**
 * 格式化单条消息。streaming 中的 assistant 消息复制当前已有文本。
 * task_message 转换为人类可读块；token 计数 / 内部 id / reasoning 不导出。
 */
export function formatMessageForExport(
  message: ChatMessage,
  options: ConversationExportOptions = {},
): string {
  const header = `## ${roleLabel(message, options)}`;

  if (message.task_message) {
    return `${header}\n\n${formatTaskMessage(message.task_message)}`;
  }

  // 普通文本消息：content 原样保留（markdown 列表保持可读）；
  // stageDisplayContent 的 "⚡ 任务已创建…" 等占位符由 task_message 分支处理，
  // 这里跳过没有 task_message 却只有 stage 占位内容的消息。
  const content = (message.content || '').trim();
  if (!content) return '';

  // 剥离 HTML 渲染层注入的技术噪音（错误信息复制按钮等）。
  const cleaned = content
    .replace(/<button[^>]*>[^<]*<\/button>/g, '')
    .trim();

  return `${header}\n\n${cleaned}`;
}

/**
 * 把整个 Conversation 格式化为干净的 Markdown 文本。
 * 严格按 message timeline 顺序导出。
 */
export function formatConversationForClipboard(
  conversation: Pick<ChatConversation, 'title' | 'messages'>,
  options: ConversationExportOptions = {},
): string {
  const blocks: string[] = [];
  const title = (conversation.title || '未命名对话').trim();
  blocks.push(`# ${title}`);

  for (const message of conversation.messages) {
    // 内部 / 隐藏消息不导出（目前数据模型只有 user / assistant）。
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const block = formatMessageForExport(message, options);
    if (block) blocks.push(block);
  }

  return blocks.join('\n\n');
}

/** 写入剪贴板；成功返回 true，失败不抛异常。 */
export async function copyConversationToClipboard(
  conversation: Pick<ChatConversation, 'title' | 'messages'>,
  options: ConversationExportOptions = {},
): Promise<boolean> {
  const text = formatConversationForClipboard(conversation, options);
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
