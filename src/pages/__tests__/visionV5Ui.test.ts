import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf8');
const pageCss = readFileSync(resolve(__dirname, '../VisionUnderstanding.css'), 'utf8');
const rail = readFileSync(resolve(__dirname, '../../features/vision/project/ContextRail.tsx'), 'utf8');
const evaluation = readFileSync(resolve(__dirname, '../../features/evaluation/EvaluationPanel.tsx'), 'utf8');
const studio = readFileSync(resolve(__dirname, '../ImageStudio.tsx'), 'utf8');
const history = readFileSync(resolve(__dirname, '../History.tsx'), 'utf8');

describe('V5 确认生成渐进披露与 Prompt Truth', () => {
  it('默认摘要只含决策信息，高级详情默认折叠', () => {
    const start = page.indexOf('确认生成图片弹层');
    const dialog = page.slice(start, page.indexOf('删除当前项目确认', start));
    expect(dialog).toContain('vision-confirm-summary');
    for (const label of ['来源：', '编辑：', '参考图：', '角色一致性：', '生成模型：', '尺寸与数量：', '预计点数：']) {
      expect(dialog).toContain(label);
    }
    expect(dialog).toContain('<details className="vision-confirm-advanced">');
    expect(dialog).not.toContain('<details className="vision-confirm-advanced" open>');
    expect(dialog.indexOf('来源任务：')).toBeGreaterThan(dialog.indexOf('vision-confirm-advanced'));
    expect(dialog.indexOf('视觉理解：')).toBeGreaterThan(dialog.indexOf('vision-confirm-advanced'));
    expect(dialog).toContain('最终生图 Prompt');
    expect(pageCss).toContain('.vision-confirm-advanced');
  });

  it('手动完整 Prompt 同时进入确认预览与唯一提交编译输入', () => {
    expect(page).toContain('workspace: { ...draft.workspace, fullPromptOverride: value }');
    expect(page).toContain('activeProject?.workspace.fullPromptOverride?.trim() || finalPrompt');
    expect(page).toContain('{ fullPromptOverride: project.workspace.fullPromptOverride }');
    expect(page).toContain('{ fullPromptOverride: activeProject.workspace.fullPromptOverride }');
    expect(page).toContain('optimizedPrompt: finalPromptText');
    expect(studio).toContain('final_prompt: finalPrompt');
    expect(history).toContain('const singlePositive = (task.final_prompt || task.prompt).trim()');
  });
});

describe('V5 用户可见入口', () => {
  it('Strict 角色参考卡提供生成、复用与重新生成状态', () => {
    expect(rail).toContain('anime-character-reference-card');
    expect(rail).toContain('最终生成会自动复用，不重复计费');
    expect(rail).toContain('生成角色参考图');
    expect(rail).toContain('重新生成角色参考图');
  });

  it('系统修正 Toast 使用用户语言并可进入技能执行过程', () => {
    for (const copy of ['已保持动漫角色一致', '已保持人物参考服装', '已保持锁定内容', '查看执行过程']) {
      expect(page).toContain(copy);
    }
    expect(page).not.toContain("'服装来源守卫生效'");
    expect(page).not.toContain("'锁定维度守卫生效'");
  });

  it('角色一致性评价仅在存在生成快照上下文时展示，并提供重试入口', () => {
    expect(evaluation).toContain('{animeContext && (');
    expect(evaluation).toContain('暂无角色一致性评价');
    expect(evaluation).toContain('重新评价角色一致性');
    expect(evaluation).toContain('ANIME_CONSISTENCY_DIMENSION_LABELS');
  });
});
