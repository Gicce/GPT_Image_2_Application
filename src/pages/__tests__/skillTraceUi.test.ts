/**
 * Runtime Skill Trace UI 布线守卫（§50）：
 *  - 视觉工作台：Rail 技能入口 / 最终 Prompt「查看 Prompt 来源」/ Drawer 渲染；
 *  - 五阶段标签（发现/建议/用户选择/系统强制/Prompt 写入）必须存在于渲染结构；
 *  - History：AI 技能与规则只读 provenance.skillExecutionSnapshot，无快照如实提示；
 *  - 设置：AI 技能中心挂载 + 核心技能无假开关；
 *  - CSS：新样式只走语义 Token（不硬编码 hex）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const page = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const rail = readFileSync(resolve(__dirname, '../../features/vision/project/ContextRail.tsx'), 'utf-8');
const drawer = readFileSync(resolve(__dirname, '../../features/vision/skills/SkillTraceDrawer.tsx'), 'utf-8');
const history = readFileSync(resolve(__dirname, '../History.tsx'), 'utf-8');
const settings = readFileSync(resolve(__dirname, '../Settings.tsx'), 'utf-8');
const skillsCss = readFileSync(resolve(__dirname, '../../features/vision/skills/skills.css'), 'utf-8');

describe('Skill Trace UI 布线（§23/§24/§25）', () => {
  test('ContextRail 暴露技能入口 onOpenSkillTrace + 本次使用 N 个技能', () => {
    expect(rail).toContain('onOpenSkillTrace');
    expect(rail).toContain('本次使用');
    expect(rail).toContain('查看技能执行过程');
  });

  test('VisionUnderstanding 渲染 SkillTraceDrawer 且两个入口都接通', () => {
    expect(page).toContain('<SkillTraceDrawer');
    expect(page).toContain("setSkillTraceMode('skills')");
    expect(page).toContain('openPromptSource');
    expect(page).toContain('查看 Prompt 来源');
  });

  test('优化完成冻结快照进项目（updateActiveMeta，不加修订）', () => {
    expect(page).toContain('buildSkillExecutionSnapshot');
    expect(page).toMatch(/updateActiveMeta\(draft => \(\{[\s\S]*?skillExecution: snapshot/);
  });

  test('生成冻结快照进 provenance（History 数据源）', () => {
    expect(page).toMatch(/provenance\.skillExecutionSnapshot = skillSnapshot/);
    expect(page).toContain('includeRegions');
  });

  test('Drawer 五阶段标签齐备（§25 最高产品要求）', () => {
    for (const phase of ['发现', '建议', '用户选择', '系统强制', 'Prompt 写入']) {
      expect(drawer).toContain(phase);
    }
  });

  test('Drawer 状态语义 Tone 齐备（applied/skipped/overridden/failed）', () => {
    expect(drawer).toContain('is-${record.status}');
    for (const status of ['is-applied', 'is-skipped', 'is-overridden', 'is-failed']) {
      expect(skillsCss).toContain(`.vision-skill-status.${status}`);
    }
  });

  test('无快照旧项目如实提示，不伪造（§44）', () => {
    expect(drawer).toContain('暂无技能执行记录');
    expect(drawer).toContain('技能追踪功能之前');
  });
});

describe('History 技能审计（§35/§36）', () => {
  test('AI 技能与规则区块只读 provenance.skillExecutionSnapshot', () => {
    expect(history).toContain('AI 技能与规则');
    expect(history).toMatch(/provenance\.skillExecutionSnapshot\.skills/);
    expect(history).toContain('查看执行详情');
    expect(history).toContain('该任务生成于技能追踪功能之前，无历史技能记录');
  });
});

describe('Skill Center（§28-§30）', () => {
  test('设置页挂载 aiskills 分区与 RuntimeSkillCenter', () => {
    expect(settings).toContain("'aiskills'");
    expect(settings).toContain('<RuntimeSkillCenter />');
  });
});

describe('CSS Token 守卫（§26：不硬编码颜色）', () => {
  test('skills.css 不出现裸 hex 颜色（语义 Token + fallback 除外）', () => {
    const hexOffenders = skillsCss.match(/:\s*#[0-9a-fA-F]{3,8}\s*;/g) ?? [];
    expect(hexOffenders).toEqual([]);
  });

  test('五阶段 Tone 使用 badge 语义 Token', () => {
    expect(skillsCss).toContain('var(--badge-success-bg');
    expect(skillsCss).toContain('var(--badge-warn-text');
    expect(skillsCss).toContain('var(--badge-danger-bg');
    expect(skillsCss).toContain('var(--accent-primary, #6366f1)');
  });
});
