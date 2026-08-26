/**
 * Skill Trace Markdown 导出回归（任务C）：
 * 「复制全部执行过程」必须产出结构化 Markdown——头部元信息 + 每个 skill
 * 五阶段（含未启用状态与「查看写入文本」全文），可直接粘贴外部复核。
 */

import { describe, expect, it } from 'vitest';
import type { SkillExecutionSnapshot } from '../../../../types';
import { buildSkillTraceMarkdown } from '../exportTrace';

function snapshotFixture(): SkillExecutionSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    projectRevision: 4,
    optimizationRevision: 4,
    createdAt: '2026-08-25T00:59:53.000Z',
    skills: [
      {
        executionId: 'visual_analysis-1',
        skillId: 'visual_analysis',
        skillName: '视觉模板分析',
        skillVersion: '1.0.0',
        category: 'analysis',
        status: 'applied',
        triggeredBy: 'system',
        findings: [{ id: 'f1', title: '已冻结模板九维基线', description: '真人主体与动漫主体并存' }],
        suggestions: [],
        userDecisions: [],
        hardConstraints: [],
        appliedChanges: [],
        promptContributions: [],
        startedAt: '',
        completedAt: '',
      },
      {
        executionId: 'person_replacement-1',
        skillId: 'person_replacement',
        skillName: '人物替换',
        skillVersion: '1.0.0',
        category: 'constraint',
        status: 'applied',
        triggeredBy: 'user',
        findings: [{ id: 'f2', title: '绑定了人物参考 @人物参考', severity: 'important' }],
        suggestions: [{ id: 's1', title: '人物身份使用人物参考', type: 'required', status: 'auto_applied' }],
        userDecisions: [{ suggestionId: 's1', decision: 'accepted', decidedAt: '' }],
        hardConstraints: [{ dimension: 'subject', mode: 'forced', source: '@人物参考', reason: '模板人物身份不保留' }],
        appliedChanges: [],
        promptContributions: [{
          block: 'person_contract',
          summary: '人物替换合同（强度=严格）',
          finalText: '【人物替换合同（强制执行）】\n身份来源：人物参考图。',
        }],
        startedAt: '',
        completedAt: '',
      },
      {
        executionId: 'replication_boost-1',
        skillId: 'replication_boost',
        skillName: '复刻度增强',
        skillVersion: '1.0.0',
        category: 'optimization',
        status: 'skipped',
        triggeredBy: 'auto',
        skippedReason: '未启用「提高复刻度」',
        findings: [],
        suggestions: [],
        userDecisions: [],
        hardConstraints: [],
        appliedChanges: [],
        promptContributions: [],
        startedAt: '',
        completedAt: '',
      },
      {
        executionId: 'prompt_optimization-1',
        skillId: 'prompt_optimization',
        skillName: 'Prompt 优化',
        skillVersion: '1.0.0',
        category: 'optimization',
        status: 'applied',
        triggeredBy: 'user',
        findings: [{ id: 'optimizer-model', title: '优化模型：GLM-5V-Turbo' }],
        suggestions: [],
        userDecisions: [],
        hardConstraints: [],
        appliedChanges: [],
        promptContributions: [],
        startedAt: '',
        completedAt: '',
      },
    ],
    compiledSections: [
      { block: 'person_contract', skillIds: ['person_replacement'], text: '【人物替换合同（强制执行）】' },
    ],
  } as unknown as SkillExecutionSnapshot;
}

describe('buildSkillTraceMarkdown（任务C 复制全部执行过程）', () => {
  const markdown = buildSkillTraceMarkdown(snapshotFixture(), { projectName: '动漫AI照片01' });

  it('头部元信息齐备：项目 / Revision / 执行时间 / 模型 / 生效技能数', () => {
    expect(markdown).toContain('# 技能执行过程');
    expect(markdown).toContain('- 项目：动漫AI照片01');
    expect(markdown).toContain('- Revision：4（优化对齐 R4）');
    expect(markdown).toContain('- 执行时间：');
    expect(markdown).toContain('- 模型：GLM-5V-Turbo');
    expect(markdown).toContain('- 生效技能：3 / 4');
  });

  it('每个 skill 一节：名称 / 版本 / 状态 + 五阶段标题', () => {
    expect(markdown).toContain('## 1. 视觉模板分析 v1.0.0');
    expect(markdown).toContain('**状态**：已执行');
    for (const phase of ['### 发现', '### 建议', '### 用户采用', '### 系统强制', '### Prompt 写入']) {
      expect(markdown).toContain(phase);
    }
  });

  it('未启用 skill 也带状态与原因（完整复盘）', () => {
    expect(markdown).toContain('## 3. 复刻度增强 v1.0.0');
    expect(markdown).toContain('**状态**：未启用');
    expect(markdown).toContain('**原因**：未启用「提高复刻度」');
  });

  it('Prompt 写入包含「查看写入文本」的完整文本（代码块）', () => {
    expect(markdown).toContain('写入「person_contract」');
    expect(markdown).toContain('【人物替换合同（强制执行）】');
    expect(markdown).toContain('```');
  });

  it('compiledSections 附在尾部（最终 Prompt 分段）', () => {
    expect(markdown).toContain('# 最终 Prompt 分段（编译产物）');
    expect(markdown).toContain('## person_contract');
  });

  it('无 projectName 时回落 projectId，绝不空行', () => {
    const bare = buildSkillTraceMarkdown(snapshotFixture());
    expect(bare).toContain('- 项目：proj-1');
  });
});
