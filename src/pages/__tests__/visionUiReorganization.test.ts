/**
 * V6.4 UI 入口迁移守卫：只移动入口，不删除业务回调或数据链路。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const headerSrc = readFileSync(resolve(__dirname, '../../features/vision/project/ProjectHeaderBar.tsx'), 'utf-8');
const previewSrc = readFileSync(resolve(__dirname, '../../features/vision/project/ProjectPreviewPanel.tsx'), 'utf-8');
const viewStoreSrc = readFileSync(resolve(__dirname, '../../store/useVisionViewStore.ts'), 'utf-8');

describe('视觉理解工作台 V6.4 功能映射', () => {
  it('项目预览集中原图、摘要、模型和状态，并提升重新视觉理解入口', () => {
    expect(pageSrc).toContain('<ProjectPreviewPanel');
    for (const marker of ['analysisSummary', 'visionModelLabel', 'projectStatus', 'onReanalyze']) {
      expect(previewSrc).toContain(marker);
    }
    expect(previewSrc).toContain('重新视觉理解');
    for (const callback of ['onPickLocal', 'onPickGallery', 'onOpenFolder', 'onRemove', 'onOpenViewer']) {
      expect(previewSrc).toContain(callback);
      expect(pageSrc).toContain(`${callback}=`);
    }
  });

  it('项目操作零删减：项目切换、新建、重命名、保存、技能、派生、重新识别和删除均可达', () => {
    for (const callback of [
      'onRename', 'onSave', 'onSaveAsSkill', 'onDerive', 'onReanalyze',
      'onOpenProject', 'onNewProject', 'onOpenLibrary', 'onDeleteProject',
    ]) expect(headerSrc).toContain(callback);
    for (const label of ['立即保存', '创建可复用技能', '基于此方案新建', '重新识别', '删除当前项目']) {
      expect(headerSrc).toContain(label);
    }
    expect(headerSrc).toContain('自动保存');
    expect(pageSrc).toContain('onDuplicateProject');
  });

  it('人物、服装、自定义内容均独立可折叠，且折叠只存在 View Store', () => {
    expect(pageSrc).toContain('<PersonReplacementPanel');
    expect(pageSrc).toContain('<ClothingChangePanel');
    expect(pageSrc).toContain('自定义修改内容');
    for (const field of [
      'projectPreviewCollapsed', 'customContentCollapsed',
      'personReplacementCollapsed', 'clothingChangeCollapsed',
      'wizardStep',
    ]) {
      expect(viewStoreSrc).toContain(field);
      expect(pageSrc).toContain(field);
    }
    expect(viewStoreSrc).not.toMatch(/^import .*useVisionWorkspaceStore/m);
  });

  it('原有 Prompt 与生成闭环入口仍在页面', () => {
    for (const marker of [
      'IntentMentionInput', 'optimizeRecreationPrompt', 'FinalPromptEditor',
      'VisionResultSection', 'onContinueAdjust', 'ContextRail',
      'RegionEditorPanel', 'SkillCreatorDialog',
    ]) expect(pageSrc).toContain(marker);
  });
});
