import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * AI 漫画 Phase 10/11 接线源守卫（验收 I + 页面接入）。
 *
 * 锁定的规范：
 * - 验收 I（图片层与文字层分离）：对白编辑只走 upsertDialogue / removeDialogue，
 *   文字层组件与对白 handler 结构上不存在任何生图入口——修改对白零图片 API；
 * - 生成提交唯一入口：buildAnchorTask / buildPanelSeriesTask / buildPanelRegenTask
 *   → useTaskStore.createSeriesTask（报价确认 + 计费两段授权全复用，禁止页面绕开）；
 * - 页面接入：App PAGE_COMPONENTS / 登录门禁 / Sidebar 导航 / copy.md 术语表。
 */

const comicStudio = readFileSync(resolve(__dirname, '../ComicStudio.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const comicTextStage = readFileSync(
  resolve(__dirname, '../../features/comic/components/ComicTextStage.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const comicExport = readFileSync(
  resolve(__dirname, '../../features/comic/comicExport.ts'), 'utf-8',
).replace(/\r\n/g, '\n');
const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const sidebar = readFileSync(resolve(__dirname, '../../components/Sidebar.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const copy = readFileSync(
  resolve(__dirname, '../../../.claude/skills/cyimagepro-ui/copy.md'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('验收 I：图片层与文字层分离（改对白零生图）', () => {
  test('页面对白 handler 只走 upsertDialogue / removeDialogue（纯 dialogues 数组操作）', () => {
    expect(comicStudio).toContain('const handleDialogueChange = useCallback((dialogue: ComicDialogue) => {');
    expect(comicStudio).toContain('applyProject(draft => upsertDialogue(draft, dialogue))');
    expect(comicStudio).toContain('applyProject(draft => removeDialogue(draft, dialogueId))');
  });

  test('文字层组件不 import 任何任务构建器 / 生图 API（结构上不可能触发生图）', () => {
    for (const forbidden of [
      'comicTask', 'buildAnchorTask', 'buildPanelSeriesTask', 'buildPanelRegenTask',
      'createSeriesTask', 'authorizeImage2', 'requestQuote', 'api.',
    ]) {
      expect(comicTextStage.includes(forbidden)).toBe(false);
    }
    // 全部编辑回调只经 props 透传
    expect(comicTextStage).toContain('props.onDialogueChange(');
    expect(comicTextStage).toContain('props.onDialogueRemove(');
  });

  test('导出链路是纯本地合成（readImageData → canvas → saveImageAs），不触发生图', () => {
    expect(comicExport).toContain('api.readImageData');
    expect(comicExport).toContain('api.saveImageAs');
    expect(comicExport.includes('authorizeImage2')).toBe(false);
    expect(comicExport.includes('createSeriesTask')).toBe(false);
  });

  test('文字层组件声明铁律注释（跨上下文恢复后仍可读的设计意图）', () => {
    expect(comicTextStage).toContain('零图片 API 调用');
  });
});

describe('生成提交唯一入口（D-006 两段编排）', () => {
  test('三种任务构建器都从 comicTask 导入，不存在页面自拼 Task 参数', () => {
    for (const builder of ['buildAnchorTask', 'buildPanelSeriesTask', 'buildPanelRegenTask']) {
      expect(comicStudio).toContain(builder);
    }
    expect(comicStudio).not.toMatch(/task_source\s*[:=]\s*['"]comic['"]/);
  });

  test('提交只经 createSeriesTask（报价确认 + 计费两段授权复用既有链路）', () => {
    expect(comicStudio).toContain("useTaskStore.getState().createSeriesTask(input.params, input.params.count)");
    // 页面不直接调用生图 / 授权 API
    expect(comicStudio.includes('authorizeImage2')).toBe(false);
  });

  test('终态回写经 applyComicTaskResults（幂等），不经页面散写面板状态', () => {
    expect(comicStudio).toContain('registerTaskRefreshHook');
    expect(comicStudio).toContain('applyComicTaskResults');
    expect(comicStudio).toContain('ensureTaskEventBridge');
  });

  test('锚点锁定优先用任务审定载荷，任务不可达时回落面板成图事实（同源数据）', () => {
    expect(comicStudio).toContain('buildAnchorConfirmation');
    expect(comicStudio).toContain('panel.imageAsset');
  });
});

describe('阶段推进：skill_draft 钉住要求显式转换', () => {
  test('确认技能走原生 stage 写入（不经 derive 包裹的 applyProject）', () => {
    expect(comicStudio).toContain("updateActive(draft => ({ ...draft, stage: 'character_confirmation' }))");
  });

  test('其余语义更新统一经 applyProject（事实派生阶段标签）', () => {
    expect(comicStudio).toContain('deriveComicStage');
  });
});

describe('页面接入（导航 / 门禁 / 术语）', () => {
  test('App：comicstudio 注册进 PAGE_COMPONENTS 且要求登录', () => {
    expect(app).toContain("const ComicStudio = lazy(() => import('./pages/ComicStudio'));");
    expect(app).toContain('comicstudio: <ComicStudio />');
    expect(app).toContain("'comicstudio'");
  });

  test('Sidebar：导航项「AI 漫画」（标准叫法来自 copy.md）', () => {
    expect(sidebar).toContain("{ id: 'comicstudio', label: 'AI 漫画', icon: '◆' }");
  });

  test('copy.md：导航标准叫法 + 漫画核心术语表已登记', () => {
    expect(copy).toContain('| AI 漫画 |');
    for (const term of ['漫画技能', '演员库', '本期故事', '分镜脚本', '首格锚点', '系列分镜', '单格重绘', '文字层', '无字底图', '整页导出']) {
      expect(copy).toContain(term);
    }
  });
});
