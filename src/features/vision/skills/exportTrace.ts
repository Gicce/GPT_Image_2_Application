/**
 * Skill Trace Markdown 导出器 —— 「复制全部执行过程」的内容构建（纯函数）。
 *
 * 输出按用户验收格式：头部元信息（项目 / Revision / 执行时间 / 模型 / 生效技能数）
 * + 每个 skill 一节（名称 / 版本 / 状态 + 五阶段：发现 / 建议 / 用户选择 /
 * 系统强制 / Prompt 写入；含「查看写入文本」的完整文本）。
 * 未启用（skipped）技能也带状态与原因，便于完整复盘。
 */

import type { SkillExecutionRecord, SkillExecutionSnapshot } from '../../../types';

const STATUS_LABELS: Record<SkillExecutionRecord['status'], string> = {
  applied: '已执行',
  skipped: '未启用',
  overridden: '已覆写',
  failed: '失败',
};

const DECISION_LABELS: Record<string, string> = {
  accepted: '已采用',
  modified: '已调整',
  rejected: '已拒绝',
};

/** 从 prompt_optimization 记录的发现里解析「优化模型：X」行（无则未配置）。 */
function resolveOptimizerModel(snapshot: SkillExecutionSnapshot): string {
  const optimizer = snapshot.skills.find(record => record.skillId === 'prompt_optimization');
  if (!optimizer) return '—';
  const finding = optimizer.findings.find(item => item.id === 'optimizer-model');
  return finding?.title.replace(/^优化模型：/, '') || '未配置';
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function bulletItems(items: ReadonlyArray<string>): string {
  return items.map(item => `- ${item}`).join('\n');
}

function recordSection(record: SkillExecutionRecord, index: number): string {
  const lines: string[] = [];
  lines.push(`## ${index + 1}. ${record.skillName} v${record.skillVersion}`);
  lines.push(`**状态**：${STATUS_LABELS[record.status] ?? record.status}`);
  if (record.skippedReason) lines.push(`**原因**：${record.skippedReason}`);

  if (record.findings.length > 0) {
    lines.push('', '### 发现');
    lines.push(bulletItems(record.findings.map(finding =>
      `${finding.title}${finding.description ? `——${finding.description}` : ''}`)));
  }
  if (record.suggestions.length > 0) {
    lines.push('', '### 建议');
    lines.push(bulletItems(record.suggestions.map(suggestion =>
      `${suggestion.type === 'required' ? '（必须）' : ''}${suggestion.title}${suggestion.description ? `——${suggestion.description}` : ''}`)));
  }
  if (record.userDecisions.length > 0) {
    lines.push('', '### 用户采用');
    lines.push(bulletItems(record.userDecisions.map(decision => {
      const label = DECISION_LABELS[decision.decision] ?? decision.decision;
      const value = decision.modifiedValue !== undefined
        ? `：${JSON.stringify(decision.modifiedValue)}`
        : '';
      return `${label}${value}`;
    })));
  }
  if (record.hardConstraints.length > 0) {
    lines.push('', '### 系统强制');
    lines.push(bulletItems(record.hardConstraints.map(constraint =>
      `${constraint.dimension}${constraint.value ? ` = ${constraint.value}` : ''}`
      + `${constraint.source ? `（来源 ${constraint.source}）` : ''}`
      + `${constraint.reason ? `——${constraint.reason}` : ''}`)));
  }
  if (record.promptContributions.length > 0) {
    lines.push('', '### Prompt 写入');
    lines.push(bulletItems(record.promptContributions.map(contribution =>
      `写入「${contribution.block}」——${contribution.summary}`
      + (contribution.finalText ? `\n\n  \`\`\`\n  ${contribution.finalText.split('\n').join('\n  ')}\n  \`\`\`` : ''))));
  }
  return lines.join('\n');
}

/**
 * 构建技能执行过程 Markdown。
 * @param snapshot 冻结快照（project.skillExecution / provenance.skillExecutionSnapshot）
 * @param meta.projectName 项目名（快照只存 id；页面从当前项目 / History 任务补齐）
 */
export function buildSkillTraceMarkdown(
  snapshot: SkillExecutionSnapshot,
  meta?: { projectName?: string; fallbackSections?: ReadonlyArray<{ block: string; text: string }> },
): string {
  const applied = snapshot.skills.filter(record => record.status === 'applied');
  const header = [
    '# 技能执行过程',
    '',
    `- 项目：${meta?.projectName?.trim() || snapshot.projectId}`,
    `- Revision：${snapshot.projectRevision}`
    + (snapshot.optimizationRevision !== undefined ? `（优化对齐 R${snapshot.optimizationRevision}）` : ''),
    `- 执行时间：${formatTime(snapshot.createdAt)}`,
    `- 模型：${resolveOptimizerModel(snapshot)}`,
    `- 生效技能：${applied.length} / ${snapshot.skills.length}`,
    '',
  ].join('\n');

  const body = snapshot.skills
    .map((record, index) => recordSection(record, index))
    .join('\n\n');

  const sections = snapshot.compiledSections ?? meta?.fallbackSections;
  let tail = '';
  if (sections && sections.length > 0) {
    tail = '\n\n---\n\n# 最终 Prompt 分段（编译产物）\n\n'
      + sections.map(section =>
        `## ${section.block}\n\n\`\`\`\n${section.text}\n\`\`\``).join('\n\n');
  }

  return `${header}${body}${tail}\n`;
}
