/**
 * 漫画 Prompt Compiler（Phase 7）——ComicSkill + 角色 + 分镜 (+ Anchor 档案)
 * → CompiledPanelPrompt {positive, negative, references}。
 *
 * 确定性编译（零模型裁量）：与 vision 的 generationDirective 同族思想——
 * 参考图语义强制写进 Prompt；本模块复用 buildGenerationImageDirective 生成
 * 逐图职责行（anchor = 风格参考、角色 = 身份参考），再叠加漫画专属指令块：
 *  - 无字底图铁律（noText 恒真；仅 environmentTextAllowed 且分镜给出确切文字时放开）；
 *  - 角色外观块：immutableTraits + 槽位 displayRule 逐角色编译；
 *  - Anchor 一致性块：系列分镜必须在画风/线条/上色/角色渲染上与图片1一致；
 *  - 单格画面铁律（Phase 1.2 R1/§44）：Prompt 只描述这一格，页面级形式词
 *    （comicForm / 四格 / 九宫格）永不进入单格 Prompt，negative 加多格拼图防线。
 *
 * 编译产物冻结进 panel.compiledPrompt（溯源），修改对白永不重编译（文字层独立）。
 */

import { buildGenerationImageDirective } from '../vision/generationDirective';
import type { GenerationImageReference } from '../../types';
import type { ComicCharacter, ComicDialogue, ComicPanel, ComicProject } from './types';
import { comicBubbleStyleMeta } from './bubbleShape';

export type ComicCompileMode = 'anchor' | 'series' | 'panel_regen';

export interface CompilePanelInput {
  project: ComicProject;
  panel: ComicPanel;
  mode: ComicCompileMode;
}

export interface CompiledPanelPrompt {
  positive: string;
  negative: string;
  /** 顺序 = 提交 gpt-image-2 的图片顺序（anchor → 出场角色参考）。 */
  references: GenerationImageReference[];
}

/**
 * 默认模板（V4.2.12 §52 顺序）：核心事件 → 动作 → 表情 → 场景/环境 → 时间 →
 * 镜头/构图 → 视觉风格。角色参考块、一致性、无字铁律由 sections 装配追加。
 */
const DEFAULT_PROMPT_TEMPLATE = [
  '漫画单格画面（整幅图只画这一格）',
  '画面核心事件：{{panel.scene}}',
  '{{panel.characterActions}}',
  '{{panel.characterExpressions}}',
  '场景与环境：{{panel.background}}',
  '{{panel.time}}',
  '镜头：{{panel.shotType}}，{{panel.camera}}，{{panel.composition}}',
  '{{panel.props}}',
  '{{comic.visualStyle}}',
].join('，');

/** 单格画面强制行（Phase 1.2 R1/§44）：生成单元是一格，不是一页拼图。 */
const SINGLE_FRAME_DIRECTIVE = '单格画面（强制）：整幅图就是漫画的其中一格，禁止在画面内再分格、拼图、多格排版或出现页边框。';

/** negative 防线：页面级形式词不得诱导模型在一格里画多格。 */
const MULTI_PANEL_NEGATIVE_GUARDS = ['多格拼图', '分格画面', '多格漫画排版', '四宫格', '九宫格', 'comic sheet', 'four-panel layout'];

/** V4.2.12 §59：场景丰富度标准/丰富档位的背景防线（空白背景是「鸭梨山大」实锤问题）。 */
const SCENE_NEGATIVE_GUARDS = ['纯色背景', '空白背景', '背景空无一物', '背景额外新增主要角色'];

/** §47 豁免：这些画面形态本来就是纯背景/贴纸/立绘，不注入场景丰富度指令。 */
const SCENE_EXEMPT_STYLE_PATTERNS = ['贴纸', '立绘', '纯背景', '透明背景'];

function isSceneExemptStyle(visualStyle: string): boolean {
  return SCENE_EXEMPT_STYLE_PATTERNS.some(pattern => visualStyle.includes(pattern));
}

/**
 * 场景表现指令（V4.2.12 §47~§63）——修「背景接近纯色/空白」：
 *  - background 为空 → 兜底指令（依据核心事件布置明确的故事场景背景，禁止空白）；
 *  - background 非空 → 只按丰富度加约束；
 *  - sceneRichness：minimal 保持简洁 / standard（默认）简化但可辨认 / rich 更丰富陈设；
 *  - 同场景连续性（§60）：与其他活动格 background 相同 → 声明背景跨格连续。
 */
function sceneDirective(project: ComicProject, panel: ComicPanel): { directive: string; guards: boolean } {
  const skill = project.skillSnapshot;
  if (isSceneExemptStyle(skill.visualStyle)) return { directive: '', guards: false };
  const richness = skill.generationRules.sceneRichness ?? 'standard';
  const background = panel.background.trim();
  const time = panel.time?.trim();

  const richnessLine = richness === 'minimal'
    ? '背景保持简洁，只保留画面必要元素，不做多余陈设'
    : richness === 'rich'
      ? '背景包含更丰富的环境陈设与细节（家具、墙面装饰、远处景物），但保持画风统一、不抢主体'
      : '背景是明确可辨认的故事场景（不是纯色或空白），陈设简化但不空';

  let directive: string;
  if (background) {
    directive = `场景与环境（强制）：${background}；${richnessLine}`;
  } else {
    // 兜底：分镜只写了「谁发生了什么」，没有写「在哪里」——依据核心事件推导布置
    directive = `场景与环境（强制）：依据画面事件布置明确的故事场景背景（由事件可推断的地点与陈设，如教室/家中/街道）${time ? `，时间为${time}` : ''}；${richnessLine}`;
  }
  if (time && background) {
    directive += `；时间为${time}`;
  }

  // 同场景连续性：background 非空且与其他活动格完全相同 → 背景跨格连续
  const siblings = project.panels.filter(item => !item.stale && item.id !== panel.id);
  if (background && siblings.some(item => item.background.trim() === background && item.background.trim().length > 0)) {
    directive += '；本格与其他格属于同一场景，背景陈设与光线在格间保持连续一致';
  }
  return { directive, guards: richness !== 'minimal' };
}

/** 模板占位符 → 实际值；未命中占位符剔除（不留 {{}} 残渣）。 */
function expandTemplate(template: string, project: ComicProject, panel: ComicPanel): string {
  const skill = project.skillSnapshot;
  const slotsById = new Map(skill.characterSlots.map(slot => [slot.slotId, slot]));
  const valueFor = (key: string): string => {
    const [ns, field] = key.split('.');
    switch (ns) {
      case 'comic':
        switch (field) {
          case 'visualStyle': return skill.visualStyle;
          // R1（Phase 1.2）：comicForm 是页面级形式词（四格漫画/九宫格…），
          // 写进单格 Prompt 会诱导模型在一格里再画四宫格——面板编译恒为空。
          case 'comicForm': return '';
          case 'consistencyRules': return skill.consistencyRules.join('；');
          case 'humorStyle': return skill.humorStyle;
          default: return '';
        }
      case 'panel': {
        const panelField = field as keyof ComicPanel;
        const value = panel[panelField];
        if (Array.isArray(value)) return value.join('，');
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return String(value);
        return '';
      }
      case 'slot': {
        // {{slot.<slotId>.displayRule}}：按槽位取显示规则
        const slotId = field;
        return slotsById.get(slotId)?.displayRule ?? '';
      }
      default:
        return '';
    }
  };
  return template
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => valueFor(key))
    .replace(/，\s*，/g, '，')
    .replace(/｜\s*｜/g, '｜')
    .replace(/^[，｜\s]+|[，｜\s]+$/g, '');
}

/** 逐角色外观块：不可变特征 + 槽位显示规则（镜头限制）编译为指令行。 */
function characterDirectiveLines(project: ComicProject, panel: ComicPanel): { lines: string[]; resolvedCount: number } {
  const skill = project.skillSnapshot;
  // 同一角色绑多槽时取首个槽位（确定性；displayRule 以主槽位为准）
  const slotOfCharacter = new Map<string, string>();
  for (const [slotId, characterId] of Object.entries(project.characterBindings)) {
    if (!slotOfCharacter.has(characterId)) slotOfCharacter.set(characterId, slotId);
  }
  const lines: string[] = [];
  for (const characterId of panel.characterIds) {
    const character = project.characterSnapshots.find(item => item.id === characterId);
    if (!character) continue;
    const slot = skill.characterSlots.find(item => item.slotId === slotOfCharacter.get(characterId));
    const traits = character.immutableTraits.join('、');
    const linesFor: string[] = [`- 角色「${character.name}」：${character.appearance || traits || '外观以角色参考图为准'}`];
    if (traits) linesFor.push(`跨格不变特征：${traits}`);
    if (character.defaultClothing) linesFor.push(`默认服装：${character.defaultClothing}`);
    if (character.negativeConstraints.length) linesFor.push(`该角色禁止：${character.negativeConstraints.join('、')}`);
    if (slot?.displayRule) linesFor.push(`出场规则（强制）：${slot.displayRule}`);
    lines.push(linesFor.join('；') + '。');
  }
  return { lines, resolvedCount: lines.length };
}

/** 无字底图指令：默认全面禁文字；环境文字豁免只放行分镜给定的确切内容。 */
function noTextDirective(project: ComicProject, panel: ComicPanel): string {
  const environmentText = panel.environmentText?.trim();
  if (environmentText && project.skillSnapshot.generationRules.environmentTextAllowed) {
    return `环境文字豁免：画面内仅允许出现以下确切文字——「${environmentText}」，除此之外画面不得出现任何可读文字、对白、字母或数字。`;
  }
  return '无字底图（强制）：画面内不得出现任何可读文字、对白气泡、台词、字母、数字、乱码、水印、签名或 Logo。';
}

/** 参考图清单：anchor（风格锚）在前，出场且有参考图的角色（身份来源）在后。 */
function collectReferences(project: ComicProject, panel: ComicPanel, mode: ComicCompileMode): GenerationImageReference[] {
  const refs: GenerationImageReference[] = [];
  const anchor = project.consistency?.anchor;
  if (mode !== 'anchor' && anchor) {
    refs.push({
      path: anchor.path,
      label: '漫画首格定稿（风格与画法锚点）',
      role: 'style_reference',
    });
  }
  for (const characterId of panel.characterIds) {
    const character = project.characterSnapshots.find(item => item.id === characterId);
    if (!character?.referenceImage) continue;
    refs.push({
      path: character.referenceImage.path,
      assetId: character.referenceImage.assetId,
      label: `${character.name} · 角色参考`,
      role: 'person_reference',
    });
  }
  return refs;
}

/**
 * 编译单格生图输入。纯函数：同输入恒同输出（冻结进 panel.compiledPrompt 可复现）。
 * mode='anchor' 时不带 anchor 参考（它自己就是锚）。
 */
export function compilePanelPrompt(input: CompilePanelInput): CompiledPanelPrompt {
  const { project, panel, mode } = input;
  const skill = project.skillSnapshot;

  const template = skill.promptTemplate?.trim() || DEFAULT_PROMPT_TEMPLATE;
  const expanded = expandTemplate(template, project, panel);

  const references = collectReferences(project, panel, mode);
  // 复用 vision 的逐图职责行（personReplacementEnabled=false：漫画不做「替换模板人物」语义，
  // 只取角色行——person_reference 行本身即声明身份唯一来源）
  const imageDirective = buildGenerationImageDirective({
    imageReferences: references,
    personReplacementEnabled: false,
    clothingPolicy: 'preserve_original',
  });

  const anchor = project.consistency?.anchor;
  const anchorLine = mode !== 'anchor' && anchor
    ? `画风一致性（强制）：本格与已定稿首格（随请求附上的「漫画首格定稿」参考图）必须保持同一画风——线条粗细、上色方式、色板、角色渲染方式、背景留白密度完全一致。`
    : '';

  const sections: string[] = [
    `【${skill.name}】`,
    expanded,
    SINGLE_FRAME_DIRECTIVE,
  ];
  // V4.2.12 §47~§63 场景表现：环境兜底 + 丰富度 + 同场景连续（紧跟画面事件之后）
  const scene = sceneDirective(project, panel);
  if (scene.directive) sections.push(scene.directive);
  const characterBlock = characterDirectiveLines(project, panel);
  if (characterBlock.lines.length) {
    sections.push('角色设定（跨格一致，禁止重新设计）：\n' + characterBlock.lines.join('\n'));
  }
  if (skill.consistencyRules.length) {
    sections.push(`跨格一致性约束：${skill.consistencyRules.join('；')}。`);
  }
  sections.push(noTextDirective(project, panel));
  if (anchorLine) sections.push(anchorLine);
  if (imageDirective) sections.push(imageDirective);

  const negativeParts = [...skill.generationRules.negativeConstraints];
  if (!skill.generationRules.environmentTextAllowed || !panel.environmentText?.trim()) {
    for (const extra of ['画面内文字', '对白气泡', '台词字幕', '乱码', '水印', '签名', 'Logo']) {
      if (!negativeParts.includes(extra)) negativeParts.push(extra);
    }
  }
  // R1 防线：页面级拼图形态全部进 negative
  for (const guard of MULTI_PANEL_NEGATIVE_GUARDS) {
    if (!negativeParts.includes(guard)) negativeParts.push(guard);
  }
  // V4.2.12 §59/§61：标准/丰富档位追加背景防线（空白背景 + 背景新增主要角色）
  if (scene.guards) {
    for (const guard of SCENE_NEGATIVE_GUARDS) {
      if (!negativeParts.includes(guard)) negativeParts.push(guard);
    }
  }
  if (characterBlock.resolvedCount > 0) {
    negativeParts.push('角色形象与参考图不符');
  }

  return {
    positive: sections.filter(Boolean).join('\n'),
    negative: negativeParts.join('，'),
    references,
  };
}

// ---------------------------------------------------------------------------
// 角色参考图（Phase 1.1 §六/§七）：Brief + SkillSnapshot → 定妆参考图 Prompt
// ---------------------------------------------------------------------------

export interface CompileCharacterReferenceInput {
  project: ComicProject;
  character: ComicCharacter;
}

/**
 * 编译角色定妆参考图生图输入（纯函数；产物冻结进任务 execution_snapshot 溯源）。
 * Prompt 来源 = SkillSnapshot.visualStyle + 角色 Brief（appearance / immutableTraits /
 * colorPalette / defaultClothing）+ 角色与技能 negativeConstraints + noText 铁律 +
 * 视觉建议（单角色 / 干净背景 / 完整外观 / 面部清晰 / 主配色明确 / 无对白 / 无水印 /
 * 无额外角色）。无源图（task_type='generate'）。
 */
export function compileCharacterReferencePrompt(input: CompileCharacterReferenceInput): CompiledPanelPrompt {
  const { project, character } = input;
  const skill = project.skillSnapshot;
  // 同一角色绑多槽时取首个槽位（与 compilePanelPrompt 的确定性规则一致）
  const slotOfCharacter = Object.entries(project.characterBindings)
    .find(([, characterId]) => characterId === character.id)?.[0];
  const slot = skill.characterSlots.find(item => item.slotId === slotOfCharacter);

  const sections: string[] = [
    `【${skill.name} · 角色参考图】`,
    skill.visualStyle,
    `角色「${character.name}」定妆参考图（单人设定图）`,
  ];
  const appearance = character.appearance || character.immutableTraits.join('、');
  if (appearance) sections.push(`外观设定：${appearance}`);
  if (character.description) sections.push(`人设摘要：${character.description}`);
  if (character.immutableTraits.length) {
    sections.push(`跨格不变特征（必须全部呈现且完全一致）：${character.immutableTraits.join('、')}`);
  }
  if (character.defaultClothing) sections.push(`默认服装：${character.defaultClothing}`);
  if (character.colorPalette?.length) sections.push(`主配色（明确可辨识）：${character.colorPalette.join('、')}`);
  if (slot?.displayRule) sections.push(`出场规则（强制）：${slot.displayRule}`);
  sections.push(
    '画面要求：画面中只有这一个角色，不出现任何其他人物或动物；干净纯色浅背景；'
      + '完整全身外观（从头到脚，含四肢与手持物）；面部清晰正对观者，五官可辨识；'
      + '光线均匀，无阴影遮挡面部；构图居中，角色完整入画不裁切。',
  );
  sections.push('无字底图（强制）：画面内不得出现任何可读文字、对白气泡、台词、字母、数字、乱码、水印、签名或 Logo。');

  const negativeParts = [...skill.generationRules.negativeConstraints, ...character.negativeConstraints];
  for (const extra of ['画面内文字', '对白气泡', '台词字幕', '乱码', '水印', '签名', 'Logo', '第二个角色', '多人', '分格拼图']) {
    if (!negativeParts.includes(extra)) negativeParts.push(extra);
  }
  return { positive: sections.join('\n'), negative: negativeParts.join('，'), references: [] };
}

// ---------------------------------------------------------------------------
// 文字烘焙（V4.2.14 §63~§66，实验）：成图 + 文字层 → 烘焙版整格 Prompt
// ---------------------------------------------------------------------------

export interface CompileBakeTextInput {
  project: ComicProject;
  panel: ComicPanel;
  dialogues: ComicDialogue[];
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/**
 * 编译文字烘焙输入（纯函数；源图 = 本格成图，role='template' 图生图）。
 * 与 WYSIWYG 布局同源（docs/ai-comic/28）：position 恒为「本格画面中心锚点」的
 * 归一化坐标（0~100%），width 为归一化宽；文本逐字原样传入（绝不让模型改写）。
 * 产物是派生资产（bakedTextAsset），永不覆盖 imageAsset。
 */
export function compileBakeTextPrompt(input: CompileBakeTextInput): CompiledPanelPrompt {
  const { project, panel, dialogues } = input;
  const sections: string[] = [
    `【${project.skillSnapshot.name} · 第 ${panel.order + 1} 格 · 文字烘焙】`,
    '以图片1（本格漫画成图）为底，完全保留原有画面、构图、角色与画风，只做一件事：把下列文字精确绘制到画面上。',
    '绘制铁律：文字内容逐字一致（一个字都不能改、不能增减）；字号与气泡宽度成正比；文字必须清晰可读、不得溢出气泡；中文标点规范；不添加任何未列出的文字或水印。',
  ];
  sections.push('文字清单（按绘制顺序）：');
  dialogues.forEach((dialogue, index) => {
    const meta = comicBubbleStyleMeta(dialogue.bubbleStyle);
    const width = dialogue.size?.width;
    sections.push(
      `${index + 1}. 文字：「${dialogue.text}」`,
      `   呈现：${meta.label}（${meta.hint}）；中心位置：水平 ${pct(dialogue.position.x)}、垂直 ${pct(dialogue.position.y)}`
      + (width ? `；宽度约为画面宽度的 ${pct(width)}` : ''),
    );
  });
  sections.push('除上述文字外画面保持原样（角色、背景、光影、分格边界都不变）。');

  return {
    positive: sections.join('\n'),
    negative: '改写文字内容，漏字，多字，错别字，文字溢出气泡，额外水印，额外签名，改变画面构图，改变角色外观',
    references: [{
      path: panel.imageAsset!.path,
      label: `第 ${panel.order + 1} 格成图（烘焙底图）`,
      role: 'template',
    }],
  };
}
