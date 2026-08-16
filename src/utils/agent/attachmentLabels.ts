/**
 * 图片附件语义编号工具。
 *
 * 核心目标（修复 "Composer 显示真实文件名 + Planner 不懂图一图二" 的问题）：
 *   - 用户在 Composer / Gallery 里选择的多张图片，必须以稳定的
 *     "图一 / 图二 / 图三 ..." 语义编号呈现给用户和 Planner。
 *   - 编号由选择顺序决定，而不是图库原始位置；删除中间某张后剩余自动重编号；
 *     重新选中再加入末尾。
 *   - Planner 收到的 user prompt 中必须显式包含 "图一=attachment_id_xxx" 这样的映射，
 *     并且顺序与真实图片附件数组顺序保持一致，避免 "Prompt 写图一=A 但 API images=[B,A]"。
 *
 * 本模块不引入任何外部依赖，纯本地 / 可解释。
 */

/** 中文数字 1..10 的常用写法，超过 10 直接用阿拉伯数字（"图11"）。 */
const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * 根据附件在数组中的下标（从 0 开始）返回显示标签：
 *   0 -> "图一", 1 -> "图二", ..., 9 -> "图十", 10 -> "图11", 11 -> "图12" ...
 *
 * 注意：调用方必须传 *当前数组下标*，而不是某个持久的 "selectedOrder" 字段。
 * 这样删除中间项后，剩余项的标签会随数组下标自动重排 —— 不需要维护额外状态。
 */
export function getAttachmentDisplayLabel(index: number): string {
  if (!Number.isFinite(index) || index < 0) return '图?';
  if (index < CHINESE_NUMERALS.length) return `图${CHINESE_NUMERALS[index]}`;
  return `图${index + 1}`;
}

/** 批量生成标签，常用于调试日志或一次性渲染整列附件。 */
export function getAttachmentDisplayLabels(count: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < count; i += 1) result.push(getAttachmentDisplayLabel(i));
  return result;
}

/**
 * Planner 侧的附件描述符。
 *
 * - `id`: 内部稳定标识（即 ChatAttachment.id），Planner 不直接使用，但调试时有用。
 * - `label`: 用户语义编号 ("图一" / "图二" ...)，Planner 必须严格按此引用。
 * - `originalName`: 内部文件名（保留用于调试 / 诊断），不会以原始形式送给 LLM。
 * - `source`: 附件来源（gallery / upload / paste / generated / history）。
 *
 * 注意：不要把 localPath / 真实文件路径序列化到 prompt 字符串中。
 */
export interface PlannerAttachmentDescriptor {
  id: string;
  label: string;
  originalName?: string;
  source: string;
}

/**
 * 把任意 "类 ChatAttachment" 数组转换成 Planner 描述符列表。
 *
 * 接受一个最小化的属性集合（id / source / name / filePath / dataUrl），
 * 这样可以同时支持：
 *   - 当前 Composer 里的 ChatAttachment
 *   - 任务快照里的有序附件
 *   - 历史任务里恢复出来的附件元数据
 *
 * 顺序敏感：调用方必须按"用户选择顺序"传入，输出顺序与输入顺序一致。
 */
export function buildAttachmentDescriptors<
  T extends { id: string; source?: string; name?: string; filePath?: string; dataUrl?: string }
>(attachments: T[]): PlannerAttachmentDescriptor[] {
  return attachments.map((att, index) => ({
    id: att.id,
    label: getAttachmentDisplayLabel(index),
    originalName: att.filePath ? att.filePath.split(/[\\/]/).pop() || att.name : att.name,
    source: att.source || 'unknown',
  }));
}

/**
 * 渲染 Planner prompt 中 "[图片附件语义映射]" 段落。
 *
 * 形如：
 *
 *   [图片附件语义映射]
 *   - 图一：来源=gallery，附件标识=att_xxx
 *   - 图二：来源=gallery，附件标识=att_yyy
 *   - 图三：来源=upload，附件标识=att_zzz
 *   以下编号必须严格用于用户引用："图一" / "图二" / "第一张图" / "第一张"
 *   都对应上述列表中的第 N 项，不要根据文件名自行猜测。
 *
 * 不暴露 localPath / 真实文件名 —— Planner 不需要这些信息，
 * 而且泄露本地路径对用户没有任何价值。
 */
export function renderAttachmentMappingForPlanner(
  descriptors: PlannerAttachmentDescriptor[],
): string {
  if (descriptors.length === 0) return '';
  const lines = descriptors.map(d => `- ${d.label}：来源=${d.source}，附件标识=${d.id}`);
  return `[图片附件语义映射]\n${lines.join('\n')}\n规则：用户输入中出现 "图一 / 图二 / 图三 / 第一张图 / 第二张图 / 第一张 / 第二张" 等引用时，必须严格对应上面列表中的编号，不要根据文件名自行猜测。\n`;
}

/** 用户自然语言引用解析结果。 */
export interface ResolvedImageReference {
  /** 显示标签，如 "图二"。 */
  label: string;
  /** 对应的附件稳定 id（来自 descriptors）。 */
  attachmentId: string;
  /** 在 descriptors 数组中的下标，从 0 开始。 */
  index: number;
  /** 用户原文中匹配到的子串，例如 "图二" / "第二张"。 */
  rawMatch: string;
}

/**
 * 解析用户输入中的图片引用，把 "图二 / 第二张图 / 第二张 / 第2张" 等
 * 映射到具体的 PlannerAttachmentDescriptor。
 *
 * 用法：
 *   1. Planner 在生成 final_prompt 时，可以利用它把用户的 "图二" 显式展开。
 *   2. UI / 调试日志可以用它告诉用户 "你的图二指的是哪张"。
 *
 * 不会调用 LLM、不会发起网络请求 —— 纯正则匹配 + 数组下标查询。
 * 如果 descriptors 为空 / 引用越界，会跳过该匹配项。
 */
export function resolveImageReferences(
  text: string,
  descriptors: PlannerAttachmentDescriptor[],
): ResolvedImageReference[] {
  if (!text || descriptors.length === 0) return [];
  const results: ResolvedImageReference[] = [];
  const seen = new Set<string>();

  // 中文数字 -> 下标映射，最多支持到 descriptors.length。
  const chineseToIndex: Record<string, number> = {};
  CHINESE_NUMERALS.forEach((ch, idx) => {
    if (idx < descriptors.length) chineseToIndex[ch] = idx;
  });

  // 形如 "图一" / "图二" / "图三" ... "图10" / "图11"
  // 注意：不能用 negative lookahead (?![\w一-龥]) —— "图一的人物" 里的"的"也是 CJK，
  // 会误判拒绝合法引用。这里改成：图后面立刻跟一个数字 / 中文数字即可，
  // 因为 "图片 / 图形 / 图书" 这些常用词的下一字符不可能是中文数字，自然不会误匹配。
  const labelRegex = /图([一二三四五六七八九十]|\d{1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = labelRegex.exec(text)) !== null) {
    const token = m[1];
    let idx = -1;
    if (/^\d+$/.test(token)) {
      idx = parseInt(token, 10) - 1;
    } else if (token in chineseToIndex) {
      idx = chineseToIndex[token];
    }
    if (idx >= 0 && idx < descriptors.length) {
      const d = descriptors[idx];
      const key = `${d.id}@${m[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ label: d.label, attachmentId: d.id, index: idx, rawMatch: m[0] });
      }
    }
  }

  // 形如 "第一张图" / "第二张图" / "第2张图" / "第一张" / "第2张"
  const ordinalRegex = /第([一二三四五六七八九十]|\d{1,2})张(?:图|图片|照片)?/g;
  while ((m = ordinalRegex.exec(text)) !== null) {
    const token = m[1];
    let idx = -1;
    if (/^\d+$/.test(token)) {
      idx = parseInt(token, 10) - 1;
    } else if (token in chineseToIndex) {
      idx = chineseToIndex[token];
    }
    if (idx >= 0 && idx < descriptors.length) {
      const d = descriptors[idx];
      const key = `${d.id}@${m[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ label: d.label, attachmentId: d.id, index: idx, rawMatch: m[0] });
      }
    }
  }

  return results;
}

/**
 * 任务快照里保存的"有序附件"最小字段集。
 *
 * 任务提交后，必须立即把当前 Composer 的附件按选择顺序冻结成这个形态，
 * 后续用户在 Composer 里增删图片都不能影响历史任务的展示。
 */
export interface OrderedAttachmentSnapshot {
  id: string;
  source: string;
  internalName?: string;
  /** 缩略图 / dataUrl，用于历史详情中显示。可缺省。 */
  preview?: string;
}

/**
 * 从快照数组生成描述符 —— 顺序与快照顺序一致。
 * 用于任务详情 / 历史回放。
 */
export function descriptorsFromSnapshots(
  snapshots: OrderedAttachmentSnapshot[],
): PlannerAttachmentDescriptor[] {
  return snapshots.map((s, index) => ({
    id: s.id,
    label: getAttachmentDisplayLabel(index),
    originalName: s.internalName,
    source: s.source,
  }));
}
