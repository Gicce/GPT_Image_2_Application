/**
 * Prompt 修改摘要（V4.1：先摘要、后全文——修「修改对比只有大段 diff 噪音」）。
 *
 * 从两个确定性来源派生「本次到底改了什么」：
 *  1. recreation.adjustInstruction 的结构化指令行（modificationIntent 合成协议：
 *     人物替换 / 画面模板 / 服装处理 / 动作修改 / 背景修改 / 重点修改维度…）；
 *  2. 优化成功后 plan 字段的维度 Diff（originalValue → value，applyDimensionIntent 落位）。
 *
 * 输出按「人物 / 服装 / 动作 / 背景 / 镜头 / 风格 / 其它维度」分组，
 * 每项带状态：planned（意图已记录，待优化）/ applied（优化后维度值已实际变化）。
 * 纯函数（无 React / store 依赖）。
 */

import type { RecreationFieldKey, RecreationState } from './recreationPlan';

export type PromptChangeStatus = 'planned' | 'applied';

export interface PromptChangeItem {
  key: RecreationFieldKey;
  /** 展示名（人物 / 服装 / 动作 / 背景 / 镜头 / 风格 / 构图 / 光线 / 色彩）。 */
  label: string;
  status: PromptChangeStatus;
  /** 一句话说明改什么（意图行原文 / 优化后新维度值）。 */
  text: string;
}

export interface PromptChangeSummaryModel {
  items: PromptChangeItem[];
  /** 其它结构化约束（画面模板 / 复刻强度），摘要下方轻量呈现。 */
  contextLines: string[];
}

const SHORT_LABELS: Record<RecreationFieldKey, string> = {
  subject: '人物',
  clothing: '服装',
  pose: '动作',
  composition: '构图',
  camera: '镜头',
  scene: '背景',
  lighting: '光线',
  style: '风格',
  color: '色彩',
};

/** 指令行前缀 → 维度 key（buildModificationInstruction 的合成协议，前缀锚定）。 */
const DIRECTIVE_PREFIXES: ReadonlyArray<{ prefix: string; key: RecreationFieldKey }> = [
  { prefix: '人物替换：', key: 'subject' },
  { prefix: '人物修改（已启用）：', key: 'subject' },
  { prefix: '服装处理：', key: 'clothing' },
  { prefix: '服装修改（已启用）：', key: 'clothing' },
  { prefix: '动作修改（已启用）：', key: 'pose' },
  { prefix: '背景修改（已启用）：', key: 'scene' },
  { prefix: '镜头修改（已启用）：', key: 'camera' },
  { prefix: '风格修改（已启用）：', key: 'style' },
];

/** 展示顺序（人物 / 动作 / 背景 / 服装 → 镜头 / 风格 → 其它）。 */
const ITEM_ORDER: RecreationFieldKey[] = ['subject', 'pose', 'scene', 'clothing', 'camera', 'style', 'composition', 'lighting', 'color'];

/** 一行一句话截断（摘要不堆长文；全文 Prompt 在编辑 / Diff Tab 看）。 */
function oneLine(text: string, max = 72): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 构建 Prompt 修改摘要。
 * @param recreation 复刻状态（adjustInstruction + plan 维度值）
 * @param changedFieldKeys 优化后实际发生维度值变化的 key 列表（页面已用 dimensionDiff 派生）
 */
export function buildPromptChangeSummary(
  recreation: RecreationState | null,
  changedFieldKeys: ReadonlyArray<RecreationFieldKey>,
): PromptChangeSummaryModel | null {
  if (!recreation) return null;

  const byKey = new Map<RecreationFieldKey, PromptChangeItem>();
  const contextLines: string[] = [];

  // 1) 意图行（planned 基底；applied 状态由维度 Diff 覆盖）
  const instructionLines = recreation.adjustInstruction.split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of instructionLines) {
    if (line.startsWith('画面模板：')) {
      contextLines.push(oneLine(line, 96));
      continue;
    }
    if (line.startsWith('复刻强度：')) {
      contextLines.push(oneLine(line, 96));
      continue;
    }
    if (line.startsWith('图片引用：')) continue; // 引用绑定在 @chips 与人物卡可见，不进摘要
    const hit = DIRECTIVE_PREFIXES.find(entry => line.startsWith(entry.prefix));
    if (hit) {
      byKey.set(hit.key, {
        key: hit.key,
        label: SHORT_LABELS[hit.key],
        status: 'planned',
        text: oneLine(line.slice(hit.prefix.length)),
      });
      continue;
    }
    if (line.startsWith('重点修改维度：')) {
      // 兜底：无专行维度（如纯 Chip 启用且无指令行）按标签映射
      const labels = line.slice('重点修改维度：'.length).split('、').map(s => s.trim()).filter(Boolean);
      for (const [key, label] of Object.entries(SHORT_LABELS)) {
        if (labels.includes(label) && !byKey.has(key as RecreationFieldKey)) {
          byKey.set(key as RecreationFieldKey, {
            key: key as RecreationFieldKey,
            label,
            status: 'planned',
            text: '已启用该维度修改',
          });
        }
      }
    }
  }

  // 2) 优化后实际变化（applied 证据：维度新值）
  const changedSet = new Set(changedFieldKeys);
  for (const field of recreation.plan.fields) {
    if (!changedSet.has(field.key)) continue;
    const existing = byKey.get(field.key);
    const newText = oneLine(field.value || '（新值未识别）');
    if (existing) {
      existing.status = 'applied';
      existing.text = newText;
    } else {
      byKey.set(field.key, {
        key: field.key,
        label: SHORT_LABELS[field.key],
        status: 'applied',
        text: newText,
      });
    }
  }

  const items = [...byKey.values()].sort(
    (a, b) => ITEM_ORDER.indexOf(a.key) - ITEM_ORDER.indexOf(b.key),
  );
  if (items.length === 0 && contextLines.length === 0) return null;
  return { items, contextLines };
}
