/**
 * Generation Handoff Operation（V6.2）——「确认生成 → 图片工作室」交接的操作身份。
 *
 *  - operationId：一次确认生成的唯一标识（防重入 / 计时 / Toast 去重共用）；
 *  - correction toast 去重：同一 operation 内同一种系统修正提示（动漫一致性 /
 *    服装来源 / 维度锁定）只弹一次——React 严格模式双执行或同步镜像 effect
 *    重放 generateFromPlan 产物时，不产生重复 Toast（V6.1 实机验收问题 2 的
 *    感知重复根因之一）。
 *
 * Set 为模块级（页面切换不丢失）；operationId 含纳秒级随机段，跨操作绝不误判。
 */

const shownCorrectionToasts = new Set<string>();

/** 新操作 id：`handoff-<ms36>-<rand>`。 */
export function newHandoffOperationId(): string {
  return `handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 该修正提示是否应当展示（同 operation + 同 key 只展示一次）。
 * key = 提示种类（'anime_guard' / 'clothing_guard' / 'lock_guard' …）。
 */
export function shouldShowCorrectionToast(operationId: string, key: string): boolean {
  const dedupKey = `${operationId}:${key}`;
  if (shownCorrectionToasts.has(dedupKey)) return false;
  shownCorrectionToasts.add(dedupKey);
  // 上限防泄漏（长期会话）
  if (shownCorrectionToasts.size > 200) {
    const oldest = shownCorrectionToasts.values().next().value;
    if (oldest) shownCorrectionToasts.delete(oldest);
  }
  return true;
}

/** 测试 / 显式重置用：清空去重记录。 */
export function resetCorrectionToastDedup(): void {
  shownCorrectionToasts.clear();
}

/**
 * Notification Severity Contract（V6.3 §3-§7/§49）——修正类 Toast 的严重级判定。
 *
 * 语义（判断依据 = 最终用户状态，不是「内部是否执行过 Guard」）：
 *  - success（绿）：系统已完成修正，最终状态符合用户当前合同，无需用户动作；
 *  - warning（橙）：修正结果与用户当前显式要求存在出入（仍可继续，但用户应注意）；
 *  - error（红）：阻断（编译冲突 / 校验失败——不走本函数，由门禁直接 toastError）。
 *
 * 系统自动修正（动漫一致性 / 服装来源 / 维度锁定）默认 = success：Guard 执行
 * 说明合同被正确执行。唯一例外：被剥离的漂移句来自用户当前自由文本——
 * 用户明确要求的内容被锁定合同覆盖（如文字里写了改动作却没启用动作维度），
 * 这是「与用户要求不同」，必须 warning 提示而非绿色确认。
 */
export type CorrectionSeverity = 'success' | 'warning';

/** 被移除的漂移句是否源自用户当前修改指令（子串级判定，确定性、零模型调用）。 */
function removedSentenceFromUserInstruction(
  removedSentences: ReadonlyArray<string>,
  userInstruction: string,
): boolean {
  const instruction = userInstruction.trim();
  if (!instruction) return false;
  return removedSentences.some(sentence => {
    const text = sentence.trim();
    if (text.length < 4) return false; // 过短片段不做子串归因（噪声）
    return instruction.includes(text);
  });
}

/**
 * 维度锁定修正的严重级：漂移句不来自用户当前指令 ⇒ success（系统完成了
 * 用户合同要求的锁定）；来自用户当前指令 ⇒ warning（结果与用户文字要求不同）。
 */
export function lockCorrectionSeverity(
  removedSentences: ReadonlyArray<string>,
  userInstruction: string,
): CorrectionSeverity {
  return removedSentenceFromUserInstruction(removedSentences, userInstruction) ? 'warning' : 'success';
}

/** 服装 / 动漫一致性修正的严重级：执行的是显式结构合同，恒 success。 */
export function contractCorrectionSeverity(): CorrectionSeverity {
  return 'success';
}
