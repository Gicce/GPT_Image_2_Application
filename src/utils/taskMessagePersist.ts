/**
 * TaskMessageState 序列化 / 反序列化层
 * ---------------------------------------------------------------------------
 * 历史问题：
 *   - 早期版本直接把内存中的 TaskMessageState 写到 ChatMessage.task_message，
 *     没有 version / kind 字段，字段演化时无法做兼容性处理。
 *   - Rust 端 ChatMessage 早期根本没有 task_message 字段，serde 在 save 时静默丢掉，
 *     导致重启 / 页面切换后 TaskMessageCard 退化为普通文本。
 *
 * 现在：
 *   - Rust 已经把 task_message 作为 Option<serde_json::Value> 透传。
 *   - 前端在写入前用 serializeTaskMessageState 打包；读取时用 deserializeTaskMessageState
 *     校验 version / 必要字段，损坏时返回带 errorStage 的"恢复失败"状态而不是抛异常，
 *     这样不会阻塞整个会话加载。
 */

import type {
  PlannerDiagnostic,
  Task,
  TaskMessageState,
  TaskStage,
} from '../types';

/** 当前持久化 schema 版本。字段语义变更时递增并在反序列化里加迁移分支。 */
export const TASK_MESSAGE_PERSIST_VERSION = 1;

/**
 * 持久化 envelope：把 TaskMessageState 包一层 version + kind。
 * kind 永远是 'task_message'，方便日后 metadata JSON 里区分多种结构化消息类型。
 */
export interface PersistedTaskMessageEnvelope {
  version: number;
  kind: 'task_message';
  state: TaskMessageState;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskStage(value: unknown): value is TaskStage {
  return (
    typeof value === 'string' && [
      'planning',
      'planning_failed',
      // 新增：clarification 是合法的持久化态。应用重启后必须仍然显示
      // "任务需要补充信息"，而不是被降级成 planning_failed。
      'needs_clarification',
      'waiting_confirm',
      'queued',
      'analyzing',
      'running',
      'saving',
      'success',
      'failed',
      'cancelled',
      'interrupted',
    ].includes(value as string)
  );
}

function isTaskStatus(value: unknown): value is Task['status'] {
  return (
    typeof value === 'string' && ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(value as string)
  );
}

/**
 * 把内存中的 TaskMessageState 包装成可持久化的 envelope。
 * 注意：调用方（buildPersistedMessage）依然负责剥离 images URL / blob 等不可恢复字段。
 */
export function serializeTaskMessageState(state: TaskMessageState): PersistedTaskMessageEnvelope {
  return {
    version: TASK_MESSAGE_PERSIST_VERSION,
    kind: 'task_message',
    state,
  };
}

/**
 * 从 ChatMessage.task_message 反序列化出可用的 TaskMessageState。
 *
 * 三种返回形态：
 *   1. { ok: true, state }  —— 成功恢复
 *   2. { ok: false, reason }  —— 数据损坏但 UI 仍可显示一张"任务记录恢复失败"卡片
 *   3. null  —— 输入完全不是任务消息（例如旧版纯文本）
 *
 * 不要让这个函数抛异常 —— 它运行在 loadConversations 路径上，异常会导致整个会话打不开。
 */
export function deserializeTaskMessageState(
  raw: unknown,
): | { ok: true; state: TaskMessageState }
   | { ok: false; reason: string; partial?: Partial<TaskMessageState> }
   | null {
  if (raw == null) return null;

  // 兼容旧格式：以前 task_message 直接就是 TaskMessageState（没有 envelope 包装）。
  // 旧数据没有 version/kind，但只要带合法 stage / status 就允许直通。
  if (isPlainObject(raw)) {
    // 新 envelope 格式
    if (typeof raw.version === 'number' && raw.kind === 'task_message' && isPlainObject(raw.state)) {
      const inner = raw.state as Record<string, unknown>;
      const stage = inner.stage;
      const status = inner.status;
      const taskId = inner.taskId;
      if (!isTaskStage(stage)) {
        return { ok: false, reason: 'stage 字段缺失或非法', partial: { stage: 'planning_failed' } };
      }
      if (!isTaskStatus(status)) {
        return { ok: false, reason: 'status 字段缺失或非法', partial: { status: 'failed', stage } };
      }
      if (typeof taskId !== 'string' || !taskId) {
        return { ok: false, reason: 'taskId 字段缺失', partial: { status, stage } };
      }
      return { ok: true, state: inner as unknown as TaskMessageState };
    }

    // 旧格式直通：原始 TaskMessageState 对象
    if ('stage' in raw || 'status' in raw || 'taskId' in raw) {
      const stage = raw.stage;
      const status = raw.status;
      const taskId = raw.taskId;
      if (!isTaskStage(stage) || !isTaskStatus(status) || typeof taskId !== 'string' || !taskId) {
        return { ok: false, reason: '旧格式任务消息缺少必要字段' };
      }
      return { ok: true, state: raw as unknown as TaskMessageState };
    }
  }

  return null;
}

/**
 * 构造"恢复失败"占位 TaskMessageState —— 这样 UI 不会退化成普通文本，
 * 而是渲染一张可点击查看详情的失败卡，开发期更容易发现 schema 损坏。
 */
export function buildRecoveryFailedState(
  reason: string,
  fallback?: Partial<TaskMessageState>,
): TaskMessageState {
  const nowIso = new Date().toISOString();
  const diagnostic: PlannerDiagnostic = {
    errorStage: '任务记录恢复',
    errorKind: 'task_message_hydrate_failed',
    reason,
  };
  return {
    taskId: fallback?.taskId || `recover_${Date.now()}`,
    status: 'failed',
    stage: 'planning_failed',
    title: '任务记录恢复失败',
    prompt: fallback?.prompt,
    error: reason,
    createdAt: fallback?.createdAt || nowIso,
    updatedAt: nowIso,
    plannerDiagnostic: diagnostic,
  };
}
