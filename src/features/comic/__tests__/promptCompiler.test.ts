/**
 * Prompt Compiler 测试（Phase 7，验收 E / H / L）：
 *  - 模板展开（自定义 {{panel.*}}/{{comic.*}}、未知占位符剔除、缺省模板兜底）；
 *  - 角色外观块（immutableTraits + 槽位 displayRule 强制编译）；
 *  - 无字底图铁律（负面词恒含文字类条目；环境文字豁免仅放行确切内容）；
 *  - 参考图清单（anchor 首位 + 出场角色身份参考；anchor 模式不带自身）；
 *  - 纯函数确定性（同输入恒同输出——compiledPrompt 冻结可复现）。
 */

import { describe, it, expect } from 'vitest';
import { compilePanelPrompt } from '../promptCompiler';
import { normalizeComicCharacter, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';

function makeProject(options: {
  promptTemplate?: string;
  anchor?: boolean;
  environmentTextAllowed?: boolean;
  withCharacterRef?: boolean;
} = {}): ComicProject {
  const skill = normalizeComicSkill({
    name: '职场吐槽四格',
    comicForm: '四格漫画',
    visualStyle: '简笔粗线，低饱和暖色，干净留白',
    promptTemplate: options.promptTemplate,
    consistencyRules: ['线条粗细一致', '色板固定'],
    generationRules: {
      negativeConstraints: ['乱码文字', '水印'],
      environmentTextAllowed: options.environmentTextAllowed,
    },
    characterSlots: [
      { slotId: 'hero', name: '主角', required: true, displayRule: '全身出场，表情夸张' },
      { slotId: 'reporter', name: '记者', required: false, displayRule: '仅手部与麦克风，不露脸' },
    ],
  });
  const character = normalizeComicCharacter({
    id: 'char-1',
    name: '汤圆',
    status: 'locked',
    appearance: '奶油黄短毛圆脸猫，白领结',
    immutableTraits: ['奶油黄短毛', '圆脸', '白领结'],
    negativeConstraints: ['多余手指'],
    referenceImage: options.withCharacterRef === false
      ? undefined
      : { path: '/refs/tangyuan.png', label: '定妆照' },
  });
  return normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: 'generating_panels',
    skillSnapshot: skill,
    characterSnapshots: [character!],
    characterBindings: { hero: 'char-1' },
    panels: [
      normalizeComicPanel({
        id: 'panel-0', order: 0, scene: '办公室清晨，主角盯着一摞文件',
        characterIds: ['char-1'], shotType: '全景', camera: '平视', composition: '居中构图',
        characterActions: ['瘫在椅子上'], background: '格子间工位',
      })!,
    ],
    dialogues: [],
    consistency: options.anchor
      ? {
        anchor: {
          panelId: 'panel-0', path: '/comic/anchor.png',
          imageId: 'img-a', taskId: 'task-a', lockedAt: '2026-08-30T02:00:00.000Z',
        },
        characterReferences: [],
      }
      : undefined,
  })!;
}

describe('模板展开', () => {
  it('自定义模板：panel/comic 占位符展开，未知占位符剔除', () => {
    const project = makeProject({
      promptTemplate: '{{comic.visualStyle}}｜第{{panel.order}}格：{{panel.scene}}｜{{panel.shotType}}｜{{panel.unknownField}}',
    });
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.positive).toContain('简笔粗线，低饱和暖色，干净留白｜第0格：办公室清晨，主角盯着一摞文件｜全景');
    expect(compiled.positive).not.toContain('{{');
  });

  it('空模板落缺省模板（scene/景别/动作齐全）', () => {
    const project = makeProject();
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.positive).toContain('办公室清晨，主角盯着一摞文件');
    expect(compiled.positive).toContain('全景');
    expect(compiled.positive).toContain('瘫在椅子上');
  });

  it('数组字段（characterActions）合并为逗号串', () => {
    const project = makeProject({ promptTemplate: '{{panel.characterActions}}' });
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.positive).toContain('瘫在椅子上');
  });
});

describe('角色外观块（验收 E：特征与显示规则强制编译）', () => {
  it('immutableTraits / 默认服装 / 负面约束 / 槽位 displayRule 全部入 Prompt', () => {
    const project = makeProject();
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.positive).toContain('角色「汤圆」');
    expect(compiled.positive).toContain('奶油黄短毛、圆脸、白领结');
    expect(compiled.positive).toContain('该角色禁止：多余手指');
    // panel.characterIds=[char-1] 绑定 hero 槽位 → hero 的 displayRule
    expect(compiled.positive).toContain('全身出场，表情夸张');
    expect(compiled.positive).not.toContain('仅手部与麦克风');
  });

  it('未知 characterId 静默跳过（悬空引用防御）', () => {
    const project = makeProject();
    const panel = { ...project.panels[0]!, characterIds: ['ghost'] };
    const compiled = compilePanelPrompt({ project, panel, mode: 'series' });
    expect(compiled.positive).not.toContain('角色「');
    expect(compiled.negative).not.toContain('角色形象与参考图不符');
  });
});

describe('无字底图铁律（验收 H / L）', () => {
  it('默认：禁文字指令 + 负面词恒含文字类条目（LLM 输出关不掉）', () => {
    const project = makeProject();
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.positive).toContain('无字底图（强制）');
    expect(compiled.negative).toContain('画面内文字');
    expect(compiled.negative).toContain('对白气泡');
    expect(compiled.negative).toContain('乱码文字');
  });

  it('环境文字豁免：仅放行确切内容，负面词不加文字类条目', () => {
    const project = makeProject({ environmentTextAllowed: true });
    const panel = { ...project.panels[0]!, environmentText: '延吉路 8 号' };
    const compiled = compilePanelPrompt({ project, panel, mode: 'series' });
    expect(compiled.positive).toContain('「延吉路 8 号」');
    expect(compiled.positive).toContain('除此之外画面不得出现任何可读文字');
    expect(compiled.negative).not.toContain('画面内文字');
  });

  it('未给确切文字时即使开关打开也不豁免', () => {
    const project = makeProject({ environmentTextAllowed: true });
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.positive).toContain('无字底图（强制）');
    expect(compiled.negative).toContain('画面内文字');
  });
});

describe('参考图清单（验收 L：顺序 = 提交顺序）', () => {
  it('series 模式：anchor 首位 + 出场角色身份参考', () => {
    const project = makeProject({ anchor: true });
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.references).toHaveLength(2);
    expect(compiled.references[0]).toMatchObject({ path: '/comic/anchor.png', role: 'style_reference' });
    expect(compiled.references[1]).toMatchObject({ path: '/refs/tangyuan.png', role: 'person_reference' });
    expect(compiled.positive).toContain('画风一致性（强制）');
    expect(compiled.positive).toContain('图片1');
    expect(compiled.positive).toContain('图片2');
  });

  it('anchor 模式：不带 anchor 参考（它自己就是锚）', () => {
    const project = makeProject({ anchor: true });
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'anchor' });
    expect(compiled.references).toHaveLength(1);
    expect(compiled.references[0]!.role).toBe('person_reference');
    expect(compiled.positive).not.toContain('画风一致性（强制）');
  });

  it('panel_regen 模式：与 series 同形（继承一致性档案）', () => {
    const project = makeProject({ anchor: true });
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'panel_regen' });
    expect(compiled.references[0]!.role).toBe('style_reference');
  });

  it('角色无参考图时引用清单只含 anchor', () => {
    const project = makeProject({ anchor: true, withCharacterRef: false });
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.references).toHaveLength(1);
  });
});

describe('单格画面铁律（Phase 1.2 R1 / §44：一格图内不得再画四宫格）', () => {
  it('页面级形式词（comicForm=四格漫画）不进单格 Prompt：标题、模板、负面防线三面堵', () => {
    const project = makeProject();
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    // 标题不带 comicForm；正 / 负面都不出现「四格漫画」
    expect(compiled.positive).not.toContain('四格漫画');
    expect(compiled.negative).not.toContain('四格漫画');
    // 强制单格指令 + 多格拼图负面防线
    expect(compiled.positive).toContain('单格画面（强制）');
    expect(compiled.positive).toContain('整幅图只画这一格');
    for (const guard of ['多格拼图', '分格画面', 'comic sheet', 'four-panel layout']) {
      expect(compiled.negative).toContain(guard);
    }
  });

  it('自定义模板含 {{comic.comicForm}} → 展开为空（页面级概念永不进单格 Prompt）', () => {
    const project = makeProject({
      promptTemplate: '{{comic.comicForm}}：{{panel.scene}}',
    });
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.positive).toContain('办公室清晨');
    expect(compiled.positive).not.toContain('四格漫画');
    expect(compiled.positive).toContain('单格画面（强制）');
  });

  it('缺省模板描述单格画面，不再输出「第 N 格」分镜措辞', () => {
    const project = makeProject();
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(compiled.positive).toContain('漫画单格画面（整幅图只画这一格）');
    expect(compiled.positive).not.toContain('漫画分镜（第');
  });
});

describe('确定性（compiledPrompt 冻结可复现）', () => {
  it('同输入两次编译结果完全一致', () => {
    const project = makeProject({ anchor: true });
    const a = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    const b = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'series' });
    expect(a).toEqual(b);
  });
});
