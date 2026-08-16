import { memo, useEffect, useState } from 'react';
import type { PlannerDiagnostic, TaskMessageState } from '../types';
import { isPlannerErrorRetryable } from '../utils/agent/promptPlanner';
import { executionVerbLabel, formatDuration, formatDurationPrecise, liveElapsedMs } from '../utils/taskDuration';
import './TaskMessageCard.css';

interface TaskMessageCardProps {
  state: TaskMessageState;
  isStreaming?: boolean;
  onPreviewImage?: (url: string, meta?: { name?: string; width?: number | null; height?: number | null; localPath?: string }) => void;
  onRetry?: () => void;
  onEditTask?: () => void;
  onRegenerate?: () => void;
  onViewTask?: () => void;
  onCancel?: () => void;
  onConfirm?: () => void;
  onModify?: (finalPrompt: string, finalNegativePrompt: string) => void;
  /** 当卡片处于 PLANNING_FAILED 时，点击"重新规划"按钮 */
  onReplan?: (newText?: string) => void;
}

const DEFAULT_EXECUTION_MODEL = 'gpt-image-2';

function stageBadgeClass(stage: TaskMessageState['stage']): string {
  switch (stage) {
    case 'planning':
      return 'badge-queued';
    case 'planning_failed':
      return 'badge-failed';
    case 'needs_clarification':
      return 'badge-waiting';
    case 'waiting_confirm':
      return 'badge-waiting';
    case 'queued':
    case 'analyzing':
      return 'badge-queued';
    case 'running':
    case 'saving':
      return 'badge-running';
    case 'success':
      return 'badge-success';
    case 'failed':
    case 'interrupted':
      return 'badge-failed';
    case 'cancelled':
      return 'badge-cancelled';
    default:
      return 'badge-queued';
  }
}

function stageHeadline(stage: TaskMessageState['stage'], attempt?: number): string {
  switch (stage) {
    case 'planning': return (attempt && attempt > 1) ? '正在重新规划任务' : '正在规划任务';
    case 'planning_failed': return '任务规划失败';
    case 'needs_clarification': return '任务需要补充信息';
    case 'waiting_confirm': return '任务待确认';
    case 'queued': return '任务已确认，正在排队';
    case 'analyzing': return '正在分析任务';
    case 'running': return '正在生成图片';
    case 'saving': return '正在保存结果';
    case 'success': return '任务完成';
    case 'failed': return '图片生成失败';
    case 'interrupted': return '任务因应用中断未完成';
    case 'cancelled': return '任务已取消';
    default: return stage;
  }
}

/**
 * 把上游真实 message / code / param 拼成一段主卡可显示的简短文案。
 * 1~2 行截断，详细字段放在"查看规划详情"里。
 */
function buildUpstreamSummary(
  message?: string,
  code?: string,
  type?: string,
  param?: string,
): string | null {
  const msg = (message || '').trim();
  const cd = (code || '').trim();
  const pm = (param || '').trim();
  if (!msg && !cd && !pm) return null;
  const truncate = (s: string, n: number) => {
    const chars = Array.from(s);
    return chars.length <= n ? s : `${chars.slice(0, n).join('')}…`;
  };
  if (msg) {
    const suffix = pm ? `（param=${pm}）` : cd ? `（code=${cd}）` : '';
    return `${truncate(msg, 160)}${suffix}`;
  }
  const meta = [cd && `code=${cd}`, pm && `param=${pm}`, type && `type=${type}`].filter(Boolean).join(', ');
  return meta ? `规划模型上游返回错误：${meta}` : null;
}

function stageSubText(stage: TaskMessageState['stage'], attempt?: number): string {
  switch (stage) {
    case 'planning': return (attempt && attempt > 1) ? '正在重新调用规划模型，请稍候…' : '智能体正在解析需求并生成提示词…';
    case 'planning_failed': return '请查看失败阶段和原因，修改描述后重新规划。';
    case 'needs_clarification': return '请在下方输入框中补充信息，或点击"修改任务"重新描述。';
    case 'waiting_confirm': return '请检查任务内容后确认执行。';
    case 'queued': return '排队中…';
    case 'analyzing': return '智能体正在解析需求并准备调用模型…';
    case 'running': return '图片生成模型正在生成图片…';
    case 'saving': return '正在保存图片到本地与图库…';
    case 'success': return '已自动保存到图库';
    case 'failed':
    case 'interrupted':
    case 'cancelled':
      return '';
    default:
      return '';
  }
}

function isRunningStage(stage: TaskMessageState['stage']): boolean {
  return stage === 'planning' || stage === 'queued' || stage === 'analyzing' || stage === 'running' || stage === 'saving';
}

function taskTypeLabel(taskType?: string, resolvedTaskKind?: TaskMessageState['resolvedTaskKind']): string {
  // 优先用本地推断的细粒度类型 —— 这样"用户已上传图但 Planner 退化"场景下
  // 仍然能在 UI 上看到"图片编辑 / 参考图生成"，而不是错误地显示"文生图"。
  if (resolvedTaskKind === 'image_edit') return '图片编辑';
  if (resolvedTaskKind === 'image_reference_generation') return '参考图生成';
  if (resolvedTaskKind === 'image_analysis') return '图片分析';
  if (taskType === 'edit') return '图片编辑';
  if (taskType === 'remove_background') return '去背景';
  if (resolvedTaskKind === 'text_to_image') return '文生图';
  return '文生图';
}

function taskTypeFailureLabel(taskType?: string, resolvedTaskKind?: TaskMessageState['resolvedTaskKind']): string {
  if (resolvedTaskKind === 'image_edit' || taskType === 'edit') return '图片编辑失败';
  if (taskType === 'remove_background') return '去背景失败';
  return '图片生成失败';
}

/**
 * 安全截断 Planner Raw Output，避免超长内容把详情区撑爆。
 * 默认 4000 字符（按 UTF-16 code unit，与后端 Rust 端 char-based 截断略有差异，但量级一致）。
 */
function truncateRawOutput(text: string | undefined, limit = 4000): string | undefined {
  if (!text) return undefined;
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n\n…（已截断，仅显示前 ${limit} 字符）`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function TaskMessageCardImpl({
  state,
  isStreaming,
  onPreviewImage,
  onRetry,
  onEditTask,
  onRegenerate,
  onViewTask,
  onCancel,
  onConfirm,
  onModify,
  onReplan,
}: TaskMessageCardProps) {
  const [tick, setTick] = useState(0);
  const [elapsedTick, setElapsedTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(state.finalPrompt || state.prompt || '');
  const [draftNegative, setDraftNegative] = useState(state.finalNegativePrompt || '');
  const [showPlannerDetail, setShowPlannerDetail] = useState(false);
  const [rawOutputExpanded, setRawOutputExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDraftPrompt(state.finalPrompt || state.prompt || '');
    setDraftNegative(state.finalNegativePrompt || '');
  }, [state.finalPrompt, state.finalNegativePrompt, state.prompt]);

  useEffect(() => {
    if (!isRunningStage(state.stage)) return;
    const timer = setInterval(() => setTick(t => t + 1), 1500);
    return () => clearInterval(timer);
  }, [state.stage]);

  // ====== 执行耗时实时显示（spec 五十五~五十六节）======
  // 只有执行阶段（queued / analyzing / running / saving）且有 executionStartedAt 时才启动；
  // 250ms 刷新（不要 1ms 高频 re-render）。组件卸载 clearInterval 防泄漏。
  // 注意：只更新 local UI state，不触发持久化 —— 最终 duration 由 store 在终态写入。
  const isExecutionTimingStage = state.stage === 'queued'
    || state.stage === 'analyzing'
    || state.stage === 'running'
    || state.stage === 'saving';
  useEffect(() => {
    if (!isExecutionTimingStage || !state.executionStartedAt || state.executionDurationMs != null) return;
    const timer = setInterval(() => setElapsedTick(t => t + 1), 250);
    return () => clearInterval(timer);
  }, [isExecutionTimingStage, state.executionStartedAt, state.executionDurationMs]);

  // 当 stage 切换时，重置详情区开关，避免上一阶段的展开状态污染新阶段
  useEffect(() => {
    setShowPlannerDetail(false);
    setRawOutputExpanded(false);
  }, [state.stage, state.taskId]);

  const headline = stageHeadline(state.stage, state.planningAttempt);
  const subText = stageSubText(state.stage, state.planningAttempt);
  const running = isRunningStage(state.stage);
  const isPlanning = state.stage === 'planning';
  const isWaiting = state.stage === 'waiting_confirm';
  // 关键修复（spec）：needs_clarification 是独立的不可执行态。
  // 它和 waiting_confirm 必须互斥。UI 在此态下绝不显示"确认执行"按钮。
  const isNeedsClarification = state.stage === 'needs_clarification';
  const isPlanningFailed = state.stage === 'planning_failed';
  const isExecutionFailed = state.stage === 'failed' || state.stage === 'interrupted';
  const confirming = !!state.confirming;
  const showSkeleton = running;
  const showImages = state.stage === 'success' && state.images && state.images.length > 0;
  const showGallery = state.stage === 'success';
  const showRetry = isExecutionFailed;
  // 取消按钮：planning / waiting_confirm / needs_clarification 都允许用户取消。
  const showCancel = (running || isWaiting || isNeedsClarification) && onCancel;
  const taskNumberShort = state.taskId
    && !state.taskId.startsWith('draft_')
    && !state.taskId.startsWith('pending_')
    && !state.taskId.startsWith('failed_')
    && !state.taskId.startsWith('no_task')
    && state.taskId.length >= 8 ? state.taskId.slice(0, 8) : '';
  const imageCount = state.images?.length || 0;
  const referenceCount = state.sourceImageCount ?? 0;
  // 附件角色拆分（仅当任务语义层填充了才有 —— 否则退回到旧的 sourceImageCount 显示）。
  const editTargetImageCount = state.editTargetImageCount ?? 0;
  const referenceImageCount = state.referenceImageCount ?? 0;
  const hasAmbiguousMultiImage = editTargetImageCount + referenceImageCount >= 2 && !state.resolvedTaskKind;
  const showTaskInfo = isWaiting || (running && !isPlanning) || state.stage === 'success' || isExecutionFailed;
  const isEditKind = state.taskType === 'edit'
    || state.resolvedTaskKind === 'image_edit'
    || state.resolvedTaskKind === 'image_reference_generation';
  const sourceThumb = state.sourceImagePreviewUrl;
  // 解析后的上下文摘要：作品 / 主体 / 补充标记。仅在 inheritedFromPreviousTurn=true 时展示。
  const resolvedCtx = state.resolvedContext;
  const hasResolvedContext = !!(resolvedCtx && (resolvedCtx.inheritedFromPreviousTurn || resolvedCtx.augmentationDetected));

  const plannerDiagnostic: PlannerDiagnostic | undefined = state.plannerDiagnostic;
  // 规划模型展示：Provider 名 / 模型 ID（真实 BYOK ModelRef，旧历史无快照时仅显示模型 ID）
  const plannerModelLabel = state.plannerProviderNameSnapshot
    ? `${state.plannerProviderNameSnapshot} / ${state.agentModel}`
    : state.agentModel;
  const upstreamErrorMessage = plannerDiagnostic?.upstreamErrorMessage
    || plannerDiagnostic?.responsesShape?.upstreamErrorMessage;
  const upstreamErrorType = plannerDiagnostic?.upstreamErrorType
    || plannerDiagnostic?.responsesShape?.upstreamErrorType;
  const upstreamErrorCode = plannerDiagnostic?.upstreamErrorCode
    || plannerDiagnostic?.responsesShape?.upstreamErrorCode;
  const upstreamErrorParam = plannerDiagnostic?.upstreamErrorParam
    || plannerDiagnostic?.responsesShape?.upstreamErrorParam;
  const hasUpstreamErrorDetail = !!(upstreamErrorMessage || upstreamErrorCode || upstreamErrorParam);
  const hasPlannerDetail = !!(plannerDiagnostic && (
    plannerDiagnostic.rawOutput
    || plannerDiagnostic.parserError
    || plannerDiagnostic.errorKind
    || plannerDiagnostic.transport
    || plannerDiagnostic.responsesShape
    || hasUpstreamErrorDetail
    || (plannerDiagnostic.httpStatus !== undefined && plannerDiagnostic.httpStatus !== null)
  ));
  // 主卡 reason：当上游真实 message 存在时优先用它（截断 1~2 行），让用户立刻看到
  // gpt-5.6-luna 的失败原因，而不是只看到"上游返回错误"这种空泛话。
  const upstreamSummary = hasUpstreamErrorDetail
    ? buildUpstreamSummary(upstreamErrorMessage, upstreamErrorCode, upstreamErrorType, upstreamErrorParam)
    : null;
  const displayReason = upstreamSummary
    || plannerDiagnostic?.reason
    || state.error
    || '规划模型未返回可用的优化提示词，请重试或修改描述。';
  const displayErrorStage = plannerDiagnostic?.errorStage
    || (plannerDiagnostic?.errorKind ? '规划阶段' : undefined);
  // 重试建议：当 errorKind 是确定性参数 / 模型错误时，告诉用户"继续重试不会解决此错误"，
  // 避免他们点十次重新规划都被同一个 unsupported_parameter 打回。
  const retryable = isPlannerErrorRetryable(plannerDiagnostic?.errorKind, {
    code: upstreamErrorCode,
    type: upstreamErrorType,
  });
  const retryHint = !retryable && plannerDiagnostic?.errorKind
    ? '提示：此错误通常无法通过重试解决，建议更换模型或调整任务描述后再规划。'
    : null;

  const executionDiagnostic = state.executionDiagnostic;
  const execHttpStatus = executionDiagnostic?.httpStatus ?? null;
  const execErrorKind = executionDiagnostic?.errorKind;
  const execSummary = executionDiagnostic?.summary || state.error;
  const hasExecutionDetail = !!(execSummary || execHttpStatus || execErrorKind || (executionDiagnostic?.subTaskErrors && executionDiagnostic.subTaskErrors.length > 0));

  // ====== 执行耗时显示值（spec 一百零三~一百零五节）======
  // 执行中：实时 Date.now() - executionStartedAt（elapsedTick 强制 250ms 重算）；
  // 终态：固定 executionDurationMs。Planning / waiting 阶段不显示（不是执行耗时）。
  void elapsedTick;
  const finalDurationText = state.executionDurationMs != null
    ? formatDuration(state.executionDurationMs)
    : '';
  const liveDurationMs = isExecutionTimingStage && state.executionStartedAt && state.executionDurationMs == null
    ? liveElapsedMs(state.executionStartedAt)
    : null;
  const liveDurationText = liveDurationMs != null ? formatDuration(liveDurationMs) : '';
  const executionVerb = executionVerbLabel(state.taskType, state.resolvedTaskKind);
  const preciseDurationText = state.executionDurationMs != null && state.stage === 'success'
    ? formatDurationPrecise(state.executionDurationMs)
    : '';

  const handleSaveEdit = () => {
    setEditing(false);
    onModify?.(draftPrompt.trim(), draftNegative.trim());
  };

  const handleCopyRawOutput = async () => {
    if (!plannerDiagnostic?.rawOutput) return;
    const ok = await copyToClipboard(plannerDiagnostic.rawOutput);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className={`task-message-card ${stageBadgeClass(state.stage)}`}>
      <div className="task-message-head">
        <div className="task-message-head-left">
          <span className={`task-message-badge ${stageBadgeClass(state.stage)}`}>
            {(running || confirming) && <span className="task-message-spinner" aria-hidden />}
            <span className="task-message-badge-text">{headline}</span>
          </span>
          {taskNumberShort && (
            <span className="task-message-id">#{taskNumberShort}</span>
          )}
        </div>
        {state.title && (
          <span className="task-message-title" title={state.title}>{state.title}</span>
        )}
      </div>

      {/* ====== PLANNING（首次规划 / 重新规划）阶段：只显示 loader + 原 prompt，没有任何操作按钮 ====== */}
      {isPlanning && (
        <>
          {state.prompt && (
            <div className="task-message-info-grid">
              <div><span>原始需求</span><p>{state.prompt}</p></div>
              {plannerModelLabel && (
                <div><span>规划模型</span><p>{plannerModelLabel}</p></div>
              )}
            </div>
          )}
        </>
      )}

      {/* ====== PLANNING_FAILED 卡片：分阶段展示失败原因 + 重新规划，禁止"确认执行" ====== */}
      {isPlanningFailed && (
        <>
          <div className="task-message-info-grid">
            {state.prompt && (
              <div><span>原始需求</span><p>{state.prompt}</p></div>
            )}
            {(plannerDiagnostic?.model || plannerModelLabel) && (
              <div><span>规划模型</span><p>{plannerDiagnostic?.model || plannerModelLabel}</p></div>
            )}
            {displayErrorStage && (
              <div><span>失败阶段</span><p>{displayErrorStage}</p></div>
            )}
            {plannerDiagnostic?.transport && (
              <div><span>调用通道</span><p>{plannerDiagnostic.transport === 'responses' ? 'Responses API' : 'Chat Completions'}</p></div>
            )}
            {plannerDiagnostic?.httpStatus !== undefined && plannerDiagnostic?.httpStatus !== null && (
              <div><span>HTTP</span><p>{plannerDiagnostic.httpStatus}</p></div>
            )}
            {plannerDiagnostic?.errorKind && (
              <div><span>错误类型</span><p>{plannerDiagnostic.errorKind}</p></div>
            )}
            {upstreamErrorCode && (
              <div><span>上游错误代码</span><p>{upstreamErrorCode}</p></div>
            )}
            {upstreamErrorParam && (
              <div><span>上游错误参数</span><p>{upstreamErrorParam}</p></div>
            )}
          </div>

          <div className="task-message-error">{displayReason}</div>

          {retryHint && (
            <div className="task-message-sub" style={{ color: 'var(--warning, #b8791c)' }}>{retryHint}</div>
          )}

          <div className="task-message-sub">{subText}</div>

          <div className="task-message-actions">
            {onReplan && (
              <button
                type="button"
                className="tm-btn primary"
                onClick={() => onReplan()}
                disabled={isStreaming}
                title="重新规划"
              >
                重新规划
              </button>
            )}
            {state.prompt && onModify && (
              <button
                type="button"
                className="tm-btn"
                onClick={() => setEditing(true)}
                disabled={isStreaming}
              >
                修改任务
              </button>
            )}
            {hasPlannerDetail && (
              <button
                type="button"
                className="tm-btn"
                onClick={() => setShowPlannerDetail(v => !v)}
                aria-expanded={showPlannerDetail}
              >
                {showPlannerDetail ? '收起规划详情' : '查看规划详情'}
              </button>
            )}
            {onCancel && (
              <button
                type="button"
                className="tm-btn"
                onClick={onCancel}
                disabled={isStreaming}
              >
                取消
              </button>
            )}
          </div>

          {showPlannerDetail && hasPlannerDetail && (
            <div className="task-message-planner-detail">
              <div className="task-message-planner-detail-section">
                <div className="task-message-planner-detail-label">原始需求</div>
                <pre className="task-message-planner-detail-pre">{state.prompt || '(无)'}</pre>
              </div>
              {plannerDiagnostic?.model && (
                <div className="task-message-planner-detail-section">
                  <div className="task-message-planner-detail-label">规划模型</div>
                  <pre className="task-message-planner-detail-pre">{plannerDiagnostic.model}</pre>
                </div>
              )}
              {plannerDiagnostic?.transport && (
                <div className="task-message-planner-detail-section">
                  <div className="task-message-planner-detail-label">调用通道</div>
                  <pre className="task-message-planner-detail-pre">
                    {plannerDiagnostic.transport === 'responses' ? 'Responses API (/v1/responses)' : 'Chat Completions (/v1/chat/completions)'}
                  </pre>
                </div>
              )}
              {plannerDiagnostic?.errorKind && (
                <div className="task-message-planner-detail-section">
                  <div className="task-message-planner-detail-label">错误类型 (error_kind)</div>
                  <pre className="task-message-planner-detail-pre">{plannerDiagnostic.errorKind}</pre>
                </div>
              )}
              {plannerDiagnostic?.parserError && (
                <div className="task-message-planner-detail-section">
                  <div className="task-message-planner-detail-label">解析错误</div>
                  <pre className="task-message-planner-detail-pre">{plannerDiagnostic.parserError}</pre>
                </div>
              )}
              {(upstreamErrorMessage || upstreamErrorType || upstreamErrorCode || upstreamErrorParam) && (
                <div className="task-message-planner-detail-section">
                  <div className="task-message-planner-detail-label">上游真实错误（body.error / last_error）</div>
                  <pre className="task-message-planner-detail-pre">
{`Message : ${upstreamErrorMessage || '(无)'}
Type    : ${upstreamErrorType || '(无)'}
Code    : ${upstreamErrorCode || '(无)'}
Param   : ${upstreamErrorParam || '(无)'}`}
                  </pre>
                </div>
              )}
              {plannerDiagnostic?.responsesShape && (
                <div className="task-message-planner-detail-section">
                  <div className="task-message-planner-detail-label">Responses Shape</div>
                  <pre className="task-message-planner-detail-pre">
{`HTTP Status         : ${plannerDiagnostic.responsesShape.httpStatus ?? '(无)'}
Responses Status    : ${plannerDiagnostic.responsesShape.responseStatus ?? '(无)'}
Top-Level Keys      : ${(plannerDiagnostic.responsesShape.topLevelKeys ?? []).join(', ') || '(空)'}
Output Count        : ${plannerDiagnostic.responsesShape.outputCount ?? 0}
Output Types        : ${(plannerDiagnostic.responsesShape.outputTypes ?? []).join(', ') || '(空)'}
Content Types       : ${(plannerDiagnostic.responsesShape.contentTypes ?? []).join(', ') || '(空)'}
Has Top output_text : ${plannerDiagnostic.responsesShape.hasTopLevelOutputText ? 'true' : 'false'}
Has choices[]       : ${plannerDiagnostic.responsesShape.hasChoices ? 'true' : 'false'}
Has error           : ${plannerDiagnostic.responsesShape.hasError ? 'true' : 'false'}
Extracted Text Len  : ${plannerDiagnostic.responsesShape.extractedTextLength ?? 0}
Incomplete Reason   : ${plannerDiagnostic.responsesShape.incompleteReason ?? '(无)'}
Upstream Msg        : ${plannerDiagnostic.responsesShape.upstreamErrorMessage ?? '(无)'}
Upstream Code       : ${plannerDiagnostic.responsesShape.upstreamErrorCode ?? '(无)'}
Upstream Type       : ${plannerDiagnostic.responsesShape.upstreamErrorType ?? '(无)'}
Upstream Param      : ${plannerDiagnostic.responsesShape.upstreamErrorParam ?? '(无)'}
Response ID         : ${plannerDiagnostic.responsesShape.responseId ?? '(无)'}
Output Tokens       : ${plannerDiagnostic.responsesShape.outputTokens ?? '(无)'}`}
                  </pre>
                </div>
              )}
              {plannerDiagnostic?.recovery?.attempted && (
                <div className="task-message-planner-detail-section">
                  <div className="task-message-planner-detail-label">响应恢复 (Responses Recovery)</div>
                  <pre className="task-message-planner-detail-pre">
{`Primary             : payload_missing (output_tokens=${plannerDiagnostic.recovery.providerOutputTokens ?? '?'}, response_id=${plannerDiagnostic.recovery.providerResponseId?.slice(0, 24) || '(无)'}${plannerDiagnostic.recovery.providerResponseId && plannerDiagnostic.recovery.providerResponseId.length > 24 ? '…' : ''})
Retrieve            : ${plannerDiagnostic.recovery.retrieveResult ?? '(未执行)'}${plannerDiagnostic.recovery.retrieveHttpStatus != null ? ` (HTTP ${plannerDiagnostic.recovery.retrieveHttpStatus})` : ''}
Streaming           : ${plannerDiagnostic.recovery.streamResult ?? '(未执行)'}${plannerDiagnostic.recovery.streamHttpStatus != null ? ` (HTTP ${plannerDiagnostic.recovery.streamHttpStatus})` : ''}${plannerDiagnostic.recovery.streamEventCount != null ? `, events=${plannerDiagnostic.recovery.streamEventCount}` : ''}${plannerDiagnostic.recovery.streamTextDeltaCount != null ? `, text_delta=${plannerDiagnostic.recovery.streamTextDeltaCount}` : ''}
最终文本来源        : ${plannerDiagnostic.recovery.textSource ?? '(未恢复)'}`}
                  </pre>
                </div>
              )}
              <div className="task-message-planner-detail-section">
                <div className="task-message-planner-detail-label-row">
                  <div className="task-message-planner-detail-label">Planner 原始返回</div>
                  {plannerDiagnostic?.rawOutput && (
                    <button
                      type="button"
                      className="tm-btn tiny"
                      onClick={handleCopyRawOutput}
                    >
                      {copied ? '已复制' : '复制'}
                    </button>
                  )}
                </div>
                <pre className="task-message-planner-detail-pre">
                  {plannerDiagnostic?.rawOutput
                    ? (rawOutputExpanded
                        ? plannerDiagnostic.rawOutput
                        : truncateRawOutput(plannerDiagnostic.rawOutput, 2000))
                    : '(无可用文本输出)'}
                </pre>
                {plannerDiagnostic?.rawOutput && plannerDiagnostic.rawOutput.length > 2000 && (
                  <button
                    type="button"
                    className="tm-btn tiny"
                    onClick={() => setRawOutputExpanded(v => !v)}
                  >
                    {rawOutputExpanded ? '收起' : '展开全部'}
                  </button>
                )}
              </div>
            </div>
          )}

          {editing && (
            <div className="task-message-edit">
              <textarea
                className="task-message-edit-input"
                value={draftPrompt}
                onChange={e => setDraftPrompt(e.target.value)}
                rows={4}
                placeholder="请输入新的描述，重新规划"
              />
              <div className="task-message-edit-actions">
                <button type="button" className="tm-btn" onClick={() => setEditing(false)}>取消</button>
                <button
                  type="button"
                  className="tm-btn primary"
                  onClick={() => {
                    if (!draftPrompt.trim()) return;
                    onReplan?.();
                  }}
                  disabled={!draftPrompt.trim()}
                >
                  重新规划
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ====== NEEDS_CLARIFICATION 卡片：Planner 明确要求补充信息 ======
          关键修复（spec）：
            - 这不是 waiting_confirm，也不是 planning_failed。
            - 此态下绝对禁止显示"确认执行"按钮 —— 否则用户点击后会出现"任务参数缺失"。
            - 卡片内容：原始需求 + Planner 的问题 + 可能缺失的字段。
            - 按钮：修改任务 / 取消。用户也可以直接在底部输入框输入补充回答，
              sendTaskMessage 会自动把它路由到 replanTaskMessage。 */}
      {isNeedsClarification && (
        <>
          <div className="task-message-info-grid">
            {state.clarification?.originalRequest && (
              <div><span>原始需求</span><p>{state.clarification.originalRequest}</p></div>
            )}
            {(!state.clarification?.originalRequest && state.prompt) && (
              <div><span>原始需求</span><p>{state.prompt}</p></div>
            )}
            {(plannerModelLabel) && (
              <div><span>规划模型</span><p>{plannerModelLabel}</p></div>
            )}
            {state.clarification?.missingFields && state.clarification.missingFields.length > 0 && (
              <div><span>缺失字段</span><p>{state.clarification.missingFields.join('、')}</p></div>
            )}
            {state.clarification?.attempt && state.clarification.attempt > 1 && (
              <div><span>补充轮次</span><p>第 {state.clarification.attempt} 轮</p></div>
            )}
          </div>

          <div className="task-message-final-prompt">
            <span>需要补充</span>
            <p>{state.clarification?.question || '请补充更多信息以便完成任务规划。'}</p>
          </div>

          <div className="task-message-sub">{subText}</div>

          <div className="task-message-actions">
            {/* 注意：此处故意没有"补充信息"按钮。
                用户应该在底部聊天输入框中直接输入补充回答，sendTaskMessage 会
                自动把它路由成对这张卡的 clarification 续接（replanTaskMessage）。
                点击"修改任务"则会原地打开编辑框，让用户重新写一份完整描述。 */}
            {state.prompt && onModify && (
              <button
                type="button"
                className="tm-btn primary"
                onClick={() => setEditing(true)}
                disabled={isStreaming}
              >
                修改任务
              </button>
            )}
            {showCancel && (
              <button
                type="button"
                className="tm-btn"
                onClick={onCancel}
                disabled={isStreaming}
              >
                取消
              </button>
            )}
          </div>

          {editing && (
            <div className="task-message-edit">
              <textarea
                className="task-message-edit-input"
                value={draftPrompt}
                onChange={e => setDraftPrompt(e.target.value)}
                rows={4}
                placeholder="请输入新的完整描述，重新规划"
              />
              <div className="task-message-edit-actions">
                <button type="button" className="tm-btn" onClick={() => setEditing(false)}>取消</button>
                <button
                  type="button"
                  className="tm-btn primary"
                  onClick={() => {
                    if (!draftPrompt.trim()) return;
                    onReplan?.();
                  }}
                  disabled={!draftPrompt.trim()}
                >
                  重新规划
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {!isPlanningFailed && showTaskInfo && !editing && (
        <div className="task-message-info-grid">
          <div><span>类型</span><p>{taskTypeLabel(state.taskType, state.resolvedTaskKind)}</p></div>
          <div><span>执行模型</span><p>{state.executionModel || DEFAULT_EXECUTION_MODEL}</p></div>
          {state.size && <div><span>尺寸</span><p>{state.size}</p></div>}
          {state.count && state.count > 1 && <div><span>数量</span><p>{state.count} 张</p></div>}
          {/* 附件角色拆分：编辑目标图 / 参考图分别展示。
              当任务语义层未填充（旧任务）时退回到旧的"参考图 N 张"。*/}
          {(editTargetImageCount > 0 || referenceImageCount > 0) ? (
            <>
              {editTargetImageCount > 0 && <div><span>编辑目标图</span><p>{editTargetImageCount} 张</p></div>}
              {referenceImageCount > 0 && <div><span>参考图</span><p>{referenceImageCount} 张</p></div>}
            </>
          ) : (
            referenceCount > 0 && <div><span>参考图</span><p>{referenceCount} 张</p></div>
          )}
          {plannerModelLabel && state.agentModel !== (state.executionModel || DEFAULT_EXECUTION_MODEL) && (
            <div><span>规划模型</span><p>{plannerModelLabel}</p></div>
          )}
          {/* Chat Handoff 语义上下文：布局 + 来源（spec 四十五节） */}
          {state.gridLayout && state.gridLayout.rows > 0 && !state.compositeLayout && (
            <div><span>布局</span><p>{state.gridLayout.rows}×{state.gridLayout.columns} 九宫格</p></div>
          )}
          {/* 单张复合构图（三分镜 / 宫格 / 分屏）：输出模式恒为单张 */}
          {state.compositeLayout && state.compositeLayout.panelCount > 0 && (
            <div>
              <span>输出模式</span>
              <p>单张（{state.compositeLayout.type === 'triptych' ? '三分镜' : state.compositeLayout.type === 'grid' ? `${state.compositeLayout.panelCount} 宫格` : '分屏'}复合构图）</p>
            </div>
          )}
          {state.subjectEntities && state.subjectEntities.length > 0 && (
            <div className="tm-info-wide">
              <span>主体</span><p>{state.subjectEntities.join('、')}</p>
            </div>
          )}
          {state.contextSourceLabel && (
            <div><span>上下文来源</span><p>{state.contextSourceLabel}</p></div>
          )}
          {isExecutionFailed && execHttpStatus !== null && (
            <div><span>HTTP</span><p>{execHttpStatus}</p></div>
          )}
          {isExecutionFailed && execErrorKind && (
            <div><span>错误类型</span><p>{execErrorKind}</p></div>
          )}
        </div>
      )}

      {/* ====== 多图但角色不明：给用户一条温和的"已识别到 N 张图"提示 ====== */}
      {!isPlanningFailed && isWaiting && hasAmbiguousMultiImage && (
        <div className="task-message-sub">
          已识别到 {editTargetImageCount + referenceImageCount} 张图片，将默认作为编辑目标 / 参考图处理；如需调整请使用"修改任务"。
        </div>
      )}

      {/* ====== 任务上下文继承摘要（多轮补充任务时显示作品 / 主体） ====== */}
      {!isPlanningFailed && isWaiting && hasResolvedContext && (
        <div className="task-message-context-summary">
          {resolvedCtx?.workTitle && (
            <div className="task-message-context-line">
              <span>作品</span><p>{resolvedCtx.workTitle}</p>
            </div>
          )}
          {resolvedCtx?.primarySubject && (
            <div className="task-message-context-line">
              <span>主体</span><p>{resolvedCtx.primarySubject}</p>
            </div>
          )}
          {resolvedCtx?.augmentationDetected && (
            <div className="task-message-context-line">
              <span>上下文</span><p>已识别为对上一任务的补充要求，已自动继承主体 / 作品</p>
            </div>
          )}
        </div>
      )}

      {/* ====== 编辑任务的 WAITING_CONFIRM 卡片：展示源图片缩略图 ======
          关键修复：用语义标签 "图一 / 图二 / 图三" 替代"已绑定源图"这种过强措辞，
          并优先读取任务提交时冻结的 orderedAttachments 快照 ——
          后续 Composer 增删图不能影响历史任务的展示。 */}
      {!isPlanningFailed && isWaiting && isEditKind && (sourceThumb || state.sourceImageFileName || (state.orderedAttachments?.length ?? 0) > 0) && (
        <div className="task-message-source-image">
          <span>编辑目标图</span>
          <div className="task-message-source-image-body">
            {sourceThumb ? (
              <img
                src={sourceThumb}
                alt={state.sourceImageFileName || '源图片'}
                onClick={() => sourceThumb && onPreviewImage?.(sourceThumb, {
                  name: state.sourceImageFileName,
                })}
              />
            ) : state.orderedAttachments && state.orderedAttachments.length > 0 ? (
              <div className="task-message-source-image-placeholder">
                {state.orderedAttachments[0].internalName || '图一'}
              </div>
            ) : (
              <div className="task-message-source-image-placeholder">
                {state.sourceImageFileName || state.sourceImageId || '图一'}
              </div>
            )}
            <div className="task-message-source-image-meta">
              {(() => {
                // 优先用任务快照里的"图一"语义标签，而不是真实文件名 / "已绑定源图"。
                const snapshot = state.orderedAttachments?.[0];
                const label = '图一';
                if (snapshot) {
                  return (
                    <span className="task-message-source-image-name" title={snapshot.internalName || label}>
                      {label}
                      {snapshot.internalName ? ` · ${snapshot.internalName}` : ''}
                    </span>
                  );
                }
                return (
                  <span className="task-message-source-image-name" title={state.sourceImageFileName || label}>
                    {label}
                    {state.sourceImageFileName ? ` · ${state.sourceImageFileName}` : ''}
                  </span>
                );
              })()}
              {state.sourceImageId && (
                <span className="task-message-source-image-id">#{String(state.sourceImageId).slice(0, 8)}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 多图附件：当 orderedAttachments > 1 时，列出图二 / 图三 等参考图。
          没有 orderedAttachments 时降级到 attachmentNames 数量提示。 */}
      {!isPlanningFailed && isWaiting && !editing && (() => {
        const orderedCount = state.orderedAttachments?.length ?? 0;
        const descCount = state.attachmentDescriptors?.length ?? 0;
        const showCount = Math.max(orderedCount, descCount);
        if (showCount <= 1) return null;
        const labels = state.attachmentDescriptors?.map(d => d.label)
          ?? Array.from({ length: showCount }, (_, i) => `图${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][i] || (i + 1)}`);
        return (
          <div className="task-message-attachments-summary">
            <span>附件 ({showCount})</span>
            <div className="task-message-attachments-list">
              {labels.map((label, idx) => (
                <span key={label + idx} className="task-message-attachment-chip" title={state.orderedAttachments?.[idx]?.internalName}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {!isPlanningFailed && isWaiting && !editing && state.prompt && state.prompt !== state.finalPrompt && (
        <div className="task-message-raw-prompt">
          <span>{isEditKind ? '修改要求' : '原始需求'}</span>
          <p>{state.prompt}</p>
        </div>
      )}

      {!isPlanningFailed && isWaiting && !editing && state.finalPrompt && (
        <div className="task-message-final-prompt">
          <span>{isEditKind ? '最终编辑提示词' : '最终提示词'}</span>
          <p>{state.finalPrompt}</p>
        </div>
      )}

      {!isPlanningFailed && isWaiting && !editing && state.finalNegativePrompt && (
        <div className="task-message-final-prompt muted">
          <span>负面提示词</span>
          <p>{state.finalNegativePrompt}</p>
        </div>
      )}

      {!isPlanningFailed && editing && (
        <div className="task-message-edit">
          <textarea
            className="task-message-edit-input"
            value={draftPrompt}
            onChange={e => setDraftPrompt(e.target.value)}
            rows={4}
            placeholder="最终提示词"
          />
          <textarea
            className="task-message-edit-input small"
            value={draftNegative}
            onChange={e => setDraftNegative(e.target.value)}
            rows={2}
            placeholder="负面提示词（可选）"
          />
          <div className="task-message-edit-actions">
            <button type="button" className="tm-btn" onClick={() => setEditing(false)}>取消</button>
            <button type="button" className="tm-btn primary" onClick={handleSaveEdit}>保存修改</button>
          </div>
        </div>
      )}

      {!isPlanningFailed && showSkeleton && (
        <div className="task-message-skeleton" data-tick={tick}>
          <div className="task-message-skeleton-row long" />
          <div className="task-message-skeleton-row medium" />
          <div className="task-message-skeleton-row short" />
        </div>
      )}

      {!isPlanningFailed && !isExecutionFailed && subText && (
        <div className="task-message-sub">{subText}</div>
      )}

      {/* ====== 执行中实时耗时（spec 五十五节）："正在生成图片… 6.7 秒" ====== */}
      {!isPlanningFailed && liveDurationText && (
        <div className="task-message-sub task-message-elapsed">
          {executionVerb}… {liveDurationText}
        </div>
      )}

      {/* ====== 成功：最终执行耗时（精确毫秒放详情） ====== */}
      {!isPlanningFailed && state.stage === 'success' && finalDurationText && (
        <div className="task-message-sub task-message-elapsed done">
          执行耗时：{finalDurationText}
          {preciseDurationText ? `（${preciseDurationText}）` : ''}
        </div>
      )}

      {/* ====== 执行失败详情：仅在 failed / interrupted 时显示，独立于成功路径 */}
      {!isPlanningFailed && isExecutionFailed && hasExecutionDetail && (
        <div className="task-message-exec-failure">
          {execSummary && (
            <div className="task-message-error">{execSummary}</div>
          )}
          {finalDurationText && (
            <div className="task-message-sub task-message-elapsed failed">失败 · 耗时 {finalDurationText}</div>
          )}
          {executionDiagnostic?.subTaskErrors && executionDiagnostic.subTaskErrors.length > 0 && (
            <ul className="task-message-subtask-errors">
              {executionDiagnostic.subTaskErrors.map((err, idx) => (
                <li key={idx} title={err}>{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!isPlanningFailed && (state.size || state.count) && !showTaskInfo && (
        <div className="task-message-meta">
          {state.size && <span>{state.size}</span>}
          {state.count && state.count > 1 && <span>{state.count} 张</span>}
          {state.model && <span>{state.model}</span>}
        </div>
      )}

      {!isPlanningFailed && showImages && (
        <div className={`task-message-images image-count-${Math.min(imageCount, 4)}`}>
          {state.images!.slice(0, 4).map(img => (
            <button
              key={img.id}
              type="button"
              className="task-message-image-btn"
              onClick={() => onPreviewImage?.(img.url, {
                name: img.file_name,
                width: img.width ?? undefined,
                height: img.height ?? undefined,
                localPath: img.localPath,
              })}
              title={img.file_name || '查看原图'}
            >
              <img src={img.url} alt={img.file_name || '生成结果'} loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}

      {!isPlanningFailed && showGallery && (
        <div className="task-message-gallery-hint">已自动保存到图库</div>
      )}

      {/* ====== 错误展示的卫生规则：
        - PLANNING_FAILED：上面已经展示过 state.error，这里不再重复
        - SUCCESS：绝不展示任何 error，防止"成功+报错"并存
        - CANCELLED：没有 error 时给一条 muted 文案
        - FAILED / INTERRUPTED：已在 exec-failure 区块展示，这里不再重复
      */}
      {state.stage === 'cancelled' && !state.error && (
        <div className="task-message-error muted">任务已取消，未生成图片。</div>
      )}

      {!isPlanningFailed && !isPlanning && (
        <div className="task-message-actions">
          {isWaiting && (
            <>
              <button
                type="button"
                className="tm-btn primary"
                onClick={onConfirm}
                disabled={isStreaming || confirming || !onConfirm}
                title={confirming ? '正在提交…' : (isEditKind ? '确认编辑' : '确认执行')}
              >
                {confirming ? '提交中…' : (isEditKind ? '确认编辑' : '确认执行')}
              </button>
              {onModify && (
                <button
                  type="button"
                  className="tm-btn"
                  onClick={() => setEditing(true)}
                  disabled={isStreaming || confirming}
                >
                  修改任务
                </button>
              )}
              {showCancel && (
                <button
                  type="button"
                  className="tm-btn"
                  onClick={onCancel}
                  disabled={isStreaming || confirming}
                >
                  取消
                </button>
              )}
            </>
          )}
          {isExecutionFailed && (
            <>
              {showRetry && (
                <button type="button" className="tm-btn primary" onClick={onRetry} disabled={isStreaming}>重试</button>
              )}
            </>
          )}
          {running && showCancel && (
            <button type="button" className="tm-btn" onClick={onCancel} disabled={isStreaming}>取消任务</button>
          )}
          {showImages && (
            <>
              <button type="button" className="tm-btn" onClick={() => state.images && state.images[0] && onPreviewImage?.(state.images[0].url, {
                name: state.images[0].file_name,
                width: state.images[0].width ?? undefined,
                height: state.images[0].height ?? undefined,
                localPath: state.images[0].localPath,
              })}>查看原图</button>
              {onEditTask && (
                <button type="button" className="tm-btn" onClick={onEditTask}>编辑此图</button>
              )}
              {onRegenerate && (
                <button type="button" className="tm-btn" onClick={onRegenerate}>再来一张</button>
              )}
            </>
          )}
          {onViewTask && !isWaiting && (
            <button type="button" className="tm-btn" onClick={onViewTask}>查看任务</button>
          )}
        </div>
      )}
    </div>
  );
}

export const TaskMessageCard = memo(TaskMessageCardImpl);
export default TaskMessageCard;
