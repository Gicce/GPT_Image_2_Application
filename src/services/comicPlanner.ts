/**
 * ComicPlannerService —— AI 漫画 LLM 规划（Phase 3，D-008）。
 *
 * 镜像 batchPlanner 家族（mode:'chat' + role='comic_planner'）：
 *  - recommendComicConcepts：需求 → N 个完整漫画形式方案（不是画风标签）
 *  - draftComicSkill：需求 + 选定方案 → 完整漫画 Skill 草稿（导演规则）
 *  - patchComicSkill：对话式修改指令 → 结构化补丁（白名单校验，UI 再应用）
 *  - draftComicCharacter：槽位 + 备注 → 角色演员草稿
 *  - patchComicCharacter：修改指令 → 角色结构化补丁
 *
 * 铁律：
 *  - 输出全部走 normalize（schema 校验），解析 / 校验失败自动重试 1 次，仍失败报错；
 *  - LLM 主动报错（{"ok":false,"reason":"…"}）原样透传 reason（技术细节，UI 拦截不直出）；
 *  - Planner 是文本 LLM 通道：零计费、不触碰 vision.rs 与生成引擎（规格 §3.3 分离）。
 */

import { api } from './api';
import { buildProviderError, providerErrorCompact } from '../features/aiProviders/providerError';
import { resolveModelForRole, recordAiRoleUsage, type AiRoleConnection } from '../features/aiRouting/resolveModelForRole';
import { logAiTransport } from '../features/aiRouting/aiRoutingLog';
import { cleanReply } from './promptOptimizer';
import { COMIC_CHARACTER_PATCH_FIELDS, COMIC_PANEL_PATCH_FIELDS, COMIC_SKILL_PATCH_FIELDS } from '../features/comic/domain';
import {
  characterIdentitiesMatch,
  characterNameBase,
  stripCharacterNameSuffix,
} from '../features/comic/characterIdentity';
import {
  normalizeComicCharacter,
  normalizeComicConcept,
  normalizeComicDialogue,
  normalizeComicPanel,
  normalizeComicSkill,
  normalizeComicStory,
  validateComicSkill,
} from '../features/comic/normalize';
import {
  comicPresentationConstraintSpec,
  normalizeComicPresentationConstraint,
} from '../features/comic/presentation';
import type {
  ComicCharacter,
  ComicCharacterSlot,
  ComicConcept,
  ComicDialogue,
  ComicPanel,
  ComicPresentationConstraint,
  ComicSkill,
  ComicSkillPatch,
  ComicStory,
} from '../features/comic/types';

type ResolvedPlanner = AiRoleConnection;

export type ComicPlannerOutcome<T> =
  | ({ ok: true } & T & { providerName: string; modelName: string })
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const CONCEPT_SHAPE_HINT = `{"concepts":[{"id":"concept-a","storyTitle":"《小鸭为什么不怕冷？》","oneLineStory":"…","fullStory":"…","punchline":"…","characters":[{"name":"…","role":"…","displayRule":"","characterKey":"main_duck"}],"storyboardBeats":[{"order":1,"title":"≤6字","summary":"…","characters":["…"]}],"comicForm":"四格漫画","layout":{"panelCount":4,"arrangement":"grid_4","description":"田字四格"},"visualStyle":"…","storyPattern":"…","dialogueStyle":"…","tone":"…","reason":"…","name":"…"}]}`;

const RECOMMEND_SYSTEM_PROMPT = `你是 CyImagePro 的漫画故事顾问。用户描述一个漫画创作需求，你先为「本期」写出几个**完整且彼此不同的漫画故事**，再为每个故事规划最合适的展示形式。用户要在不展开任何高级信息的情况下，读懂每个故事从头到尾讲什么、最终大概长什么样。

每个方案（concepts 数组元素，全部简体中文）：
- id：方案标识（concept-a / concept-b / concept-c）
- storyTitle：本期故事标题（《》内，12 字内，如《小鸭为什么不怕冷？》）
- oneLineStory：一句话讲完整个故事（≤40 字；推荐卡最重要的字段）
- fullStory：完整故事（80~200 字，从开头讲到结尾，口语化，读完不需要任何补充信息）
- punchline：结尾包袱 / 点题句（1 句，故事怎么收尾）
- characters：出场角色数组，每项 {"name":"角色名","role":"主角/对手/路人…","displayRule":"出场规则（可空字符串)","characterKey":"角色身份键"}；characterKey 是每个不同角色的稳定英文标识（snake_case，如 main_duck / duck_mom / duck_teacher），同一角色在 characters 与 storyboardBeats 中必须复用同一名字，不同角色绝不同键
- storyboardBeats：分镜节拍数组，长度必须等于 layout.panelCount；每项 {"order":从1开始,"title":"≤6字短标题","summary":"这一格发生什么（一句话）","characters":["出场角色名"]}
- comicForm：漫画形式（四格漫画 / 竖屏条漫 / 单格漫画 / 多页对话漫画 …）
- layout：{"panelCount":格数(1-12),"arrangement":"grid_4|grid_9|vertical_2|horizontal_2|vertical_3|single|multi_page","description":"布局说明"}；仅 multi_page 额外带 "pageCount":页数
- visualStyle：画面风格（线条/上色/留白/细节密度，将直接用于生图）
- storyPattern：叙事节奏模板（如「铺垫 → 小冲突 → 反转 → 点题」）
- dialogueStyle：对白风格（短句口语化 / 冷幽默旁白…；文字层用，不进生图）
- tone：整体情绪基调
- reason：为什么这个方案适合用户需求（1~2 句）
- name：方案名（10 字内，如「四格冷笑话」）

创作顺序（严格遵守）：先把故事写完（storyTitle → oneLineStory → fullStory → punchline），再定 characters，再拆 storyboardBeats，再选展示形式（comicForm + layout），最后才写 visualStyle / storyPattern 等风格参数。禁止先堆风格参数再补故事。

三个方案必须本质不同：故事本身不同（题材 / 结构 / 笑点角度不同），不只是同一个故事换四格 / 六格 / 单格。例如同一需求下：A 传统四格起承转合冷笑话；B 连续对话条漫；C 极简单格反转。方案之间的 layout.arrangement 尽量不同。

规则：
- concepts 数组长度必须严格等于用户要的数量
- storyboardBeats 是 fullStory 的逐格拆解（最后一拍就是 punchline），不得与故事矛盾
- oneLineStory / fullStory / punchline / storyboardBeats 是给普通用户读的故事正文：禁止出现「视觉方向、叙事结构、适用场景、画风」这类规划术语
- 画面风格必须适配「无字底图」工作流：visualStyle 只描述画风本身，不写对白/台词/文字类内容

输出格式（严格遵守）：只输出一个 JSON 对象，不要解释、前言或 Markdown 代码块。
${CONCEPT_SHAPE_HINT}`;

// ---------------------------------------------------------------------------
// V4.2.8 Presentation Constraint（§13~§19）：auto / fixed 是长期产品契约——
// 用户固定的形式是硬约束，Prompt、Validator、Repair 三层一致执行。
// ---------------------------------------------------------------------------

/** fixed 约束追加进 system prompt 的硬约束块（auto 不追加，保持 AI 自由）。 */
function buildFixedConstraintPromptBlock(constraint: ComicPresentationConstraint): string {
  const spec = comicPresentationConstraintSpec(constraint);
  if (!spec) return '';
  const { template } = spec;
  const arrangementNote = template.id === 'multi_page'
    ? `layout 必须为 {"panelCount":${spec.totalPanels},"arrangement":"multi_page","pageCount":${spec.pageCount}}，storyboardBeats 长度必须等于 ${spec.totalPanels}`
    : `layout.arrangement 必须为 "${template.id}"，layout.panelCount 必须为 ${spec.totalPanels}，storyboardBeats 长度必须等于 ${spec.totalPanels}`;
  return `

—— 用户指定的漫画形式（硬约束，最高优先级）——
用户已明确选择「${template.name}」。
- 三个方案的 ${arrangementNote}。禁止改用其他漫画形式（四格/九宫格/双格/单格/多页之间不得互换）。
- 三个方案使用同一形式时，故事必须真正不同：storyTitle / 冲突 / punchline / 叙事角度 / 角色互动各自独立，不得把同一个笑话换几个字重复三遍。`;
}

/** recommend 的 user content：结构化 constraint（§13：不拼「请用四格」式自然语言）。 */
function buildRecommendUserContent(
  requirement: string,
  count: number,
  constraint: ComicPresentationConstraint,
): string {
  const spec = comicPresentationConstraintSpec(constraint);
  const lines: string[] = [`方案数量：${count}（concepts 数组必须严格等于 ${count} 个）`, ''];
  if (spec) {
    const { template } = spec;
    const payload = template.id === 'multi_page'
      ? `{"mode":"fixed","type":"${template.id}","pageCount":${spec.pageCount},"totalPanels":${spec.totalPanels},"panelsPerPage":1}`
      : `{"mode":"fixed","type":"${template.id}","pageCount":1,"totalPanels":${spec.totalPanels},"panelsPerPage":${spec.totalPanels}}`;
    lines.push(
      '漫画形式约束（用户硬约束，三个方案全部遵守）：',
      payload,
      `三个方案都必须是「${template.name}」——layout.arrangement="${template.id}"，共 ${spec.totalPanels} 格，每方案 storyboardBeats 恰好 ${spec.totalPanels} 拍。`,
      '',
    );
  } else {
    lines.push(
      '漫画形式约束：{"mode":"auto"}',
      '由你为每个故事选择最合适的展示形式（grid_4 / grid_9 / vertical_2 / horizontal_2 / vertical_3 / single / multi_page 任选）；三个方案的形式尽量有差异，但故事差异才是核心。',
      '',
    );
  }
  lines.push('漫画创作需求：', requirement.trim());
  return lines.join('\n');
}

/** fixed 约束的 repair 前言（§19：修复指令必须声明硬约束不可改）。 */
function buildConstraintRepairPreamble(constraint: ComicPresentationConstraint): string | undefined {
  const spec = comicPresentationConstraintSpec(constraint);
  if (!spec) return undefined;
  const { template } = spec;
  const geometry = template.id === 'multi_page'
    ? `${spec.pageCount} 页 · 每页 1 张 · 共 ${spec.totalPanels} 格`
    : `1 页 ${spec.totalPanels} 格`;
  return `用户明确选择「${template.name}」（${geometry}），这是硬约束：三个方案都必须保持该漫画形式，不允许修改 layout.arrangement / 格数。请保持三个故事的差异，只修正 Presentation 与 Storyboard Beats 数量。`;
}

/**
 * fixed 约束校验（§16~§18 / §71）：每个 concept 的 arrangement / panelCount /
 * beats 数量必须精确匹配约束几何；multi_page 额外校验页数。返回逐项问题清单
 * （进 repair 指令与诊断日志），空数组 = 通过。
 */
function validateConceptsAgainstConstraint(
  concepts: ComicConcept[],
  constraint: ComicPresentationConstraint,
): string[] {
  const spec = comicPresentationConstraintSpec(constraint);
  if (!spec) return [];
  const { template, totalPanels, pageCount } = spec;
  const problems: string[] = [];
  concepts.forEach((concept, index) => {
    const label = `方案${index + 1}（${concept.storyTitle || concept.name}）`;
    if (concept.layout.arrangement !== template.id) {
      problems.push(`${label} layout.arrangement="${concept.layout.arrangement}"，不符合用户指定的 "${template.id}"（${template.name}）`);
    }
    if (concept.layout.panelCount !== totalPanels) {
      problems.push(`${label} layout.panelCount=${concept.layout.panelCount}，应为 ${totalPanels}`);
    }
    if (template.id === 'multi_page' && concept.layout.pageCount !== undefined
      && concept.layout.pageCount !== pageCount) {
      problems.push(`${label} layout.pageCount=${concept.layout.pageCount}，应为 ${pageCount}`);
    }
    if (concept.storyboardBeats.length !== totalPanels) {
      problems.push(`${label} storyboardBeats 长度=${concept.storyboardBeats.length}，应恰好为 ${totalPanels}（每格一拍）`);
    }
  });
  return problems;
}

const SKILL_FIELD_RULES = `Skill 对象字段（全部必填，简体中文）：
- name / description：漫画名与一句话定位
- intent：{"purpose":"用途","tone":"情绪","platform":"发布渠道"}（可部分为空字符串）
- comicForm：漫画形式
- visualStyle：画面风格（线条/上色/细节密度/留白；直接用于生图）
- layout：{"panelCount":格数(1-12),"arrangement":"vertical_2|grid_4|single|custom","description":"布局说明"}
- storyPattern：叙事节奏模板
- dialogueStyle：对白风格描述（短句口语化 / 冷幽默旁白 …；文字层渲染用，不进生图）
- humorStyle：幽默类型
- textStyle：{"bubbleStyle":"气泡样式提示","fontHint":"字体提示"}
- generationRules：{"negativeConstraints":["乱码文字","水印","签名","随机 Logo","画面内对白气泡"]}（图片层禁文字是产品铁律，negativeConstraints 保持这类条目）
- characterSlots：角色槽位数组，每项 {"slotId":"英文短id","name":"槽位名（主角/记者/同事…）","required":true/false,"displayRule":"出场规则（可空字符串）","characterKey":"角色身份键"}；至少 1 个 required=true 的槽位；name 用净名（禁止「名字（身份）」后缀），characterKey 沿用方案 characters 里同一角色的键（无则给 snake_case 英文键），同一角色绝不出现两个槽位
- consistencyRules：跨格一致性约束文案数组（画风/线条/角色特征/背景留白如何保持一致）
- promptTemplate：分镜生图 Prompt 模板，用 {{占位符}} 引用运行时字段：{{panel.scene}} {{panel.shotType}} {{panel.camera}} {{panel.composition}} {{panel.characterActions}} {{panel.background}} {{comic.visualStyle}} {{comic.consistencyRules}}；模板必须产出「无字底图」描述
- referenceStrategy：{"useAnchorAsStyle":true,"characterRefs":"required|optional"}
- exportDefaults：{"canvasRatio":"1:1|3:4|9:16","background":"#ffffff"}`;

const DRAFT_SKILL_SYSTEM_PROMPT = `你是 CyImagePro 的漫画 Skill 起草专家。用户给出创作需求与选定的方案概要（含本期完整故事），你把它展开为一份完整的漫画 Skill（漫画规则，导演视角）。

${SKILL_FIELD_RULES}

规则：
- Skill 是「规则」不是「本期内容」：storyPattern 是模板，不要写死某一期的情节
- layout 必须与选定方案的 layout 完全一致（arrangement / panelCount / pageCount 原样保留，不得改写用户已选的展示形式）
- 方案里的本期故事（storyTitle / fullStory / storyboardBeats）是用户已确认的事实：characterSlots 与规则必须能让这个故事画出来，但不得把故事情节写进规则字段
- characterSlots 的 displayRule 承载镜头限制（如「仅手部 + 麦克风，不露脸」），越具体越好
- promptTemplate 里的占位符只能用上面列出的，不得发明新占位符

输出格式（严格遵守）：只输出一个 JSON 对象（Skill 本体，不要包 skill 键），不要解释、前言或 Markdown 代码块。`;

const PATCH_SKILL_SYSTEM_PROMPT = `你是 CyImagePro 的漫画 Skill 修改专家。用户对当前漫画 Skill 提出一条修改指令，你只输出**结构化补丁**。

可修改字段白名单（field 只能取以下值）：
${COMIC_SKILL_PATCH_FIELDS.map(field => `- ${field}`).join('\n')}
其中 characterSlot.* 的补丁必须额外携带 slotId（目标槽位的 slotId）。

规则：
- 只改用户指令涉及的字段：指令没提到的字段绝不出现在 patches 里
- value 的类型：标量为字符串；layout.panelCount 为 1-12 数字；数组字段（generationRules.negativeConstraints / consistencyRules）为字符串数组；characterSlot.displayRule 为字符串
- reason：一句话说明为什么这样改（中文）

输出格式（严格遵守）：只输出一个 JSON 对象：{"patches":[{"field":"…","value":…,"slotId":"（仅 characterSlot.* 需要）","reason":"…"}]}；不要解释、前言或 Markdown 代码块。`;

const DRAFT_CHARACTER_SYSTEM_PROMPT = `你是 CyImagePro 的漫画角色设计师。用户给出漫画 Skill 概要与一个角色槽位要求，你设计这个 recurring 角色演员。

角色对象字段（全部简体中文）：
- name：角色名
- description：一句话人设
- role：叙事分工（与槽位对应）
- appearance：一段完整外观描述（体型/毛色或发型肤色/五官/服装），将直接编译进生图 Prompt，写画面可见的事实，不要写性格
- immutableTraits：不可变特征数组（跨格强制一致，如「黄白毛色」「圆脸」「左耳缺口」）
- mutableTraits：可变特征数组（表情/动作/姿态/手持物这类每格可变的维度名）
- defaultClothing：默认服装（可空字符串）
- colorPalette：主色板（如「奶油黄」「焦糖棕」；可空数组）
- negativeConstraints：负面约束（如「多余手指」「Q版大头身」；可空数组）

规则：
- appearance 与 immutableTraits 不冲突（immutableTraits 是 appearance 的关键锚点子集）
- 槽位 displayRule 有镜头限制（如「不露脸」）时，appearance 必须遵守并在描述里体现（如「画面只出现手部与麦克风」）

输出格式（严格遵守）：只输出一个 JSON 对象（角色本体），不要解释、前言或 Markdown 代码块。`;

const PATCH_CHARACTER_SYSTEM_PROMPT = `你是 CyImagePro 的漫画角色修改专家。用户对当前角色提出一条修改指令，你只输出**结构化补丁**。

可修改字段白名单（field 只能取以下值）：
${COMIC_CHARACTER_PATCH_FIELDS.map(field => `- ${field}`).join('\n')}

规则：
- 只改用户指令涉及的字段；immutableTraits / mutableTraits / colorPalette / negativeConstraints 的 value 是字符串数组，其余是字符串
- 修改外观时同步维护 immutableTraits（新增的不可变锚点要加进去）

输出格式（严格遵守）：只输出一个 JSON 对象：{"patches":[{"field":"…","value":…,"reason":"…"}]}；不要解释、前言或 Markdown 代码块。`;

const PATCH_PANEL_SYSTEM_PROMPT = `你是 CyImagePro 的漫画分镜修改专家。用户对当前这一格分镜提出一条修改指令，你只输出**结构化补丁**（Phase 1.2 §38.2：大白话改单格，只改这一格）。

可修改字段白名单（field 只能取以下值）：
${COMIC_PANEL_PATCH_FIELDS.map(field => `- ${field}`).join('\n')}

规则：
- 只改用户指令涉及的字段；characterActions / characterExpressions 的 value 是字符串数组，其余是字符串
- scene 是「画面可见的事实」（谁在哪做什么），保持无字底图：不要往 scene 里加对白或文字
- environmentText 只放画面内环境文字（店名/标语）；用户要求「这格不要画面内文字」时输出 {"field":"environmentText","value":null}

输出格式（严格遵守）：只输出一个 JSON 对象：{"patches":[{"field":"…","value":…,"reason":"…"}]}；不要解释、前言或 Markdown 代码块。`;

// ---------------------------------------------------------------------------
// 回复解析（cleanReply + 花括号配平 + {ok:false} 错误形态）
// ---------------------------------------------------------------------------

interface AgentRunResult {
  ok: boolean;
  reply?: string;
  error_kind?: string;
  error_message?: string;
  status?: number;
  /** chat 通道 finish_reason（stop / length / ...）。length = 输出被截断。 */
  finish_reason?: string;
}

export class ComicPlannerRefusalError extends Error {
  constructor(public readonly refusalReason: string) {
    super(refusalReason);
    this.name = 'ComicPlannerRefusalError';
  }
}

/** JSON 提取结果（可诊断：不再把所有失败折叠成一句 null）。 */
type ComicExtractOutcome =
  | { kind: 'ok'; record: Record<string, unknown> }
  | { kind: 'no-json' }
  | { kind: 'unbalanced' }
  | { kind: 'parse-error'; message: string };

/** 从模型回复提取首个配平的 JSON 对象（cleanReply → 去 fence → 花括号配平）。 */
function extractJsonReply(reply: string): ComicExtractOutcome {
  const cleaned = cleanReply(reply);
  const start = cleaned.indexOf('{');
  if (start === -1) return { kind: 'no-json' };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, i + 1));
          return parsed && typeof parsed === 'object'
            ? { kind: 'ok', record: parsed as Record<string, unknown> }
            : { kind: 'parse-error', message: '解析结果不是 JSON 对象' };
        } catch (error) {
          return { kind: 'parse-error', message: error instanceof Error ? error.message : String(error) };
        }
      }
    }
  }
  return { kind: 'unbalanced' };
}

/** LLM 主动报错形态：{"ok":false,"reason":"…"} → 抛 Refusal（UI 拦截技术细节）。 */
function assertNotRefusal(record: Record<string, unknown>): void {
  if (record.ok === false && typeof record.reason === 'string' && record.reason.trim()) {
    throw new ComicPlannerRefusalError(record.reason.trim());
  }
}

// ---------------------------------------------------------------------------
// 通道（role=comic_planner；零计费 BYOK 通道，同 batchPlanner）
// ---------------------------------------------------------------------------

/**
 * 阶段事件（Progress Honesty / Stage-Anchored Progress，规则 29/32）：
 * 只在真实管道边界发事件——planning（请求发出）/ validating（回复解析校验）/
 * retrying（首次结果无效，进入第二次尝试）。LLM 内部阶段不可观察，不伪造。
 */
export type ComicPlannerStage = 'planning' | 'validating' | 'retrying';
export type ComicPlannerStageListener = (stage: ComicPlannerStage) => void;

/**
 * 输出预算（V4.2.7 comic-concepts 根因修复的实测数据）：
 * GLM-5.3（coding_plan）对"3 个 story-first 方案"的典型输出 =
 * reasoning ~3.4k tokens + 正文 JSON ~2.3k tokens；max_tokens=4096 时
 * finish_reason=length、JSON 中途截断 → 结构化解析必然失败。
 * 大 JSON 输出的 planner 调用显式传 8192（智谱 / DeepSeek / GPT 系当前
 * 模型输出上限均 ≥8k）；小输出调用（补丁 / 单角色）维持默认 4096。
 */
const COMIC_PLANNER_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// 开发诊断（V4.2.7 §二）：requestId + attempt + 各解析阶段真实事件。
// Production（import.meta.env.DEV=false）完全静默；日志绝不包含
// API Key / Authorization / Base URL / Token——raw_head 只截模型正文前 300 字符。
// ---------------------------------------------------------------------------

const COMIC_PLANNER_DIAG = import.meta.env.DEV;
const RAW_HEAD_LIMIT = 300;

function comicPlannerDiag(message: string): void {
  if (COMIC_PLANNER_DIAG) console.log(`[ComicPlanner] ${message}`);
}

function newComicRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

/** interpret 结果契约：失败必须携带具体 problems（repair 指令与诊断日志的输入）。 */
type ComicInterpretOutcome<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** 提取失败 → 一句可读问题（进 repair 指令 + 诊断日志）。 */
function describeExtractFailure(outcome: ExtractFailure, finishReason?: string): string {
  if (outcome.kind === 'no-json') return '回复中找不到 JSON 对象（可能整段是解释文字）';
  if (outcome.kind === 'unbalanced') {
    return finishReason === 'length'
      ? '输出达到长度上限被截断（finish_reason=length），JSON 未闭合'
      : 'JSON 未闭合（疑似中途截断）';
  }
  return `JSON 解析失败（${outcome.message}）`;
}
type ExtractFailure = Exclude<ComicExtractOutcome, { kind: 'ok' }>;

/** 第二次尝试的 user content：原始需求 + 针对性修复指令（保持故事内容不变）。
 *  repairPreamble（V4.2.8 §19）：fixed 形式约束的修复会先声明「硬约束不可改」。 */
function buildRepairUserContent(original: string, problems: string[], repairPreamble?: string): string {
  return [
    original,
    '',
    '—— 修复指令 ——',
    ...(repairPreamble ? [repairPreamble, ''] : []),
    '上一次输出未通过结构化校验，具体问题：',
    ...problems.map(problem => `- ${problem}`),
    '请重新输出：保持故事内容不变，只输出一个完整闭合的 JSON 对象（不要解释、前言或 Markdown）；'
      + '如字段过长请压缩描述性文字，确保 JSON 完整输出到结束。',
  ].join('\n');
}

async function runPlanner(
  byok: ResolvedPlanner,
  args: { systemPrompt: string; userContent: string; feature: string; maxTokens?: number },
): Promise<{ ok: true; reply: string; finishReason?: string } | { ok: false; error: string }> {
  try {
    const runResult = await api.runAgentRequest({
      mode: 'chat',
      role: 'comic_planner',
      feature: args.feature,
      base_url: byok.baseUrl,
      token: byok.token,
      model: byok.model,
      billing_mode: byok.billingMode,
      system_prompt: args.systemPrompt,
      messages: [{ role: 'user', content: args.userContent }],
      ...(args.maxTokens ? { max_tokens: args.maxTokens } : {}),
    }) as AgentRunResult;
    if (!runResult.ok) {
      const providerError = buildProviderError({
        providerId: byok.profileId,
        providerType: byok.providerType,
        providerName: byok.profileName,
        billingMode: byok.billingMode,
        modelId: byok.model,
        failure: {
          ok: false,
          error_kind: runResult.error_kind,
          error_message: runResult.error_message,
          status: runResult.status,
        },
      });
      return { ok: false, error: providerErrorCompact(providerError) };
    }
    return { ok: true, reply: runResult.reply || '', finishReason: runResult.finish_reason };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'AI 漫画规划请求失败，请重试。' };
  }
}

function resolvePlannerOrError(feature: string) {
  const resolution = resolveModelForRole('comic_planner');
  if (!resolution.ok || !resolution.connection) {
    return { ok: false as const, error: resolution.ok ? '该功能没有可用的模型连接。' : resolution.error };
  }
  recordAiRoleUsage(resolution.resolved);
  logAiTransport(resolution.resolved, feature);
  return { ok: true as const, byok: resolution.connection };
}

function modelInfo(byok: ResolvedPlanner) {
  return { providerName: byok.profileName, modelName: byok.modelEntity.display_name || byok.model };
}

/**
 * 两轮尝试包装（V4.2.7 §七）：initial + repair = 2 次，不做更多。
 * 第二次不是原样重发——把第一次的具体失败原因（截断 / JSON 解析错误 /
 * 校验 problems）转成修复指令追加到 user content，要求"保持内容、只修结构"。
 * Refusal（{"ok":false,"reason"}）立即上抛，不重试。
 */
async function runWithRetry<T>(
  byok: ResolvedPlanner,
  args: { systemPrompt: string; userContent: string; feature: string; maxTokens?: number; onStage?: ComicPlannerStageListener; repairPreamble?: string },
  interpret: (record: Record<string, unknown>) => ComicInterpretOutcome<T>,
  fallbackError: string,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const requestId = newComicRequestId();
  let problems: string[] = [];
  let finalError = fallbackError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      args.onStage?.('retrying');
      comicPlannerDiag(`requestId=${requestId} attempt=${attempt} stage=repair problems=${problems.map(p => `[${p}]`).join('')}`);
    }
    const userContent = attempt === 1
      ? args.userContent
      : buildRepairUserContent(args.userContent, problems, args.repairPreamble);
    args.onStage?.('planning');
    comicPlannerDiag(`requestId=${requestId} attempt=${attempt} stage=request feature=${args.feature} model=${byok.model} max_tokens=${args.maxTokens ?? 'default'}`);
    const run = await runPlanner(byok, { ...args, userContent });
    if (!run.ok) return { ok: false, error: run.error };
    args.onStage?.('validating');
    if (COMIC_PLANNER_DIAG) {
      const rawHead = JSON.stringify(run.reply.slice(0, RAW_HEAD_LIMIT));
      comicPlannerDiag(`requestId=${requestId} attempt=${attempt} stage=reply content_chars=${run.reply.length} finish_reason=${run.finishReason ?? 'unknown'} raw_head=${rawHead}`);
    }
    const extracted = extractJsonReply(run.reply);
    if (extracted.kind !== 'ok') {
      problems = [describeExtractFailure(extracted, run.finishReason)];
      comicPlannerDiag(`requestId=${requestId} attempt=${attempt} stage=extract failed kind=${extracted.kind}`);
      finalError = run.finishReason === 'length' || extracted.kind === 'unbalanced'
        ? 'AI 返回的方案过长被截断，自动重试后仍未成功，请重试。'
        : 'AI 返回格式异常，已自动重试仍未成功，请重试。';
      continue;
    }
    comicPlannerDiag(`requestId=${requestId} attempt=${attempt} stage=extract ok keys=${Object.keys(extracted.record).join(',')}`);
    try {
      assertNotRefusal(extracted.record);
    } catch (error) {
      if (error instanceof ComicPlannerRefusalError) return { ok: false, error: error.message };
      throw error;
    }
    const outcome = interpret(extracted.record);
    if (outcome.ok) {
      comicPlannerDiag(`requestId=${requestId} attempt=${attempt} stage=validate ok`);
      return { ok: true, value: outcome.value };
    }
    problems = outcome.problems;
    comicPlannerDiag(`requestId=${requestId} attempt=${attempt} stage=validate failed problems=${problems.map(p => `\n  - ${p}`).join('')}`);
    finalError = fallbackError;
  }
  return { ok: false, error: finalError };
}

// ---------------------------------------------------------------------------
// 公开能力
// ---------------------------------------------------------------------------

export async function recommendComicConcepts(input: {
  requirement: string;
  count?: number;
  /** V4.2.8：漫画形式约束（auto = AI 自由；fixed = 三方案全部使用指定形式的硬约束）。 */
  presentationConstraint?: ComicPresentationConstraint;
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ concepts: ComicConcept[] }>> {
  const count = Math.min(6, Math.max(1, input.count ?? 3));
  const constraint = normalizeComicPresentationConstraint(input.presentationConstraint);
  const resolved = resolvePlannerOrError('comic-concepts');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const userContent = buildRecommendUserContent(input.requirement, count, constraint);
  const systemPrompt = RECOMMEND_SYSTEM_PROMPT + buildFixedConstraintPromptBlock(constraint);

  const run = await runWithRetry(
    byok,
    {
      systemPrompt,
      userContent,
      feature: 'comic-concepts',
      maxTokens: COMIC_PLANNER_MAX_TOKENS,
      onStage: input.onStage,
      repairPreamble: buildConstraintRepairPreamble(constraint),
    },
    record => {
      const rawConcepts = Array.isArray(record.concepts) ? record.concepts : null;
      if (!rawConcepts) return { ok: false, problems: ['根对象缺少 concepts 数组（顶层键为空或形状不符）'] };
      const concepts = rawConcepts.map(normalizeComicConcept).filter((item): item is ComicConcept => item !== null);
      if (concepts.length !== count) {
        const dropped = rawConcepts.length - concepts.length;
        return { ok: false, problems: [
          `concepts 有效数量为 ${concepts.length}（要求恰好 ${count} 个）`
          + (dropped > 0 ? `，其中 ${dropped} 项缺少 name 或 comicForm 被丢弃` : ''),
        ] };
      }
      // Story-first 铁律（§六）：完全没有故事内容的推荐不允许静默通过——
      // 至少一个方案要带可读故事（fullStory / oneLineStory / punchline 任一）。
      const hasAnyStory = concepts.some(concept => concept.fullStory || concept.oneLineStory || concept.punchline);
      if (!hasAnyStory) {
        return { ok: false, problems: ['所有方案都缺少故事内容（fullStory / oneLineStory / punchline 均为空）'] };
      }
      // V4.2.8 §18/§71：fixed 约束 = Validator 硬校验（presentation + beat 数量），
      // 违反 → problems → repair（§19 硬约束修复指令），仍违反 → 报错不静默接受。
      const constraintProblems = validateConceptsAgainstConstraint(concepts, constraint);
      if (constraintProblems.length > 0) {
        return { ok: false, problems: constraintProblems };
      }
      return { ok: true, value: { concepts } };
    },
    `AI 规划方案数量异常（期望 ${count} 个），请重新规划。`,
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, concepts: run.value.concepts, ...modelInfo(byok) };
}

/** 兜底必选槽位：preferred 位（越界钳到末位）提升 required，保证校验「至少一个必选主角」可过。 */
function ensureRequiredCharacterSlot(skill: ComicSkill, preferred: number): void {
  if (skill.characterSlots.some(slot => slot.required)) return;
  const index = Math.max(0, Math.min(preferred, skill.characterSlots.length - 1));
  if (index < 0 || index >= skill.characterSlots.length) return;
  skill.characterSlots = [
    ...skill.characterSlots.slice(0, index),
    { ...skill.characterSlots[index]!, required: true },
    ...skill.characterSlots.slice(index + 1),
  ];
}

/**
 * V4.2.8 §52：concept.characters 确定性并入 characterSlots——推荐故事里点名的角色
 * 不依赖 LLM 复述（与 layout 覆盖同族防线）。LLM 已生成的槽位保留；缺的角色按
 * concept 顺序追加（非必选）；全部槽位都非必选时优先把首个 concept 追加槽位提升为
 * 必选（它来自故事的实际角色表，比 LLM 任意槽位更可能是主角）。
 */
function mergeConceptCharacterSlots(skill: ComicSkill, concept: Pick<ComicConcept, 'characters'>): void {
  // V4.2.11 §A：身份键匹配（显式 characterKey / 净名吸收后缀），不再字符串全等——
  // 「小圆鸭（主角）」与「小圆鸭」是同一角色，禁止追加 concept-N 复制槽（19 审计 Q1）。
  const missing = (concept.characters ?? []).filter(
    character => character.name && !skill.characterSlots.some(
      slot => characterIdentitiesMatch(slot, character),
    ),
  );
  if (!missing.length) {
    ensureRequiredCharacterSlot(skill, 0);
    return;
  }
  const start = skill.characterSlots.length;
  const appended: ComicCharacterSlot[] = missing.map((character, index) => ({
    slotId: `concept-${start + index + 1}`,
    name: stripCharacterNameSuffix(character.name),
    characterKey: character.characterKey || characterNameBase(character.name) || undefined,
    required: false,
    displayRule: character.displayRule || undefined,
  }));
  skill.characterSlots = [...skill.characterSlots, ...appended];
  ensureRequiredCharacterSlot(skill, start);
}

export async function draftComicSkill(input: {
  requirement: string;
  concept: ComicConcept;
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ skill: ComicSkill }>> {
  const resolved = resolvePlannerOrError('comic-skill-draft');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const userContent = [
    '漫画创作需求：',
    input.requirement.trim(),
    '',
    '选定的方案概要（JSON）：',
    JSON.stringify(input.concept, null, 2),
  ].join('\n');

  const run = await runWithRetry(
    byok,
    { systemPrompt: DRAFT_SKILL_SYSTEM_PROMPT, userContent, feature: 'comic-skill-draft', maxTokens: COMIC_PLANNER_MAX_TOKENS, onStage: input.onStage },
    record => {
      const skill = normalizeComicSkill(record);
      // V4.2.7 §十五：展示形式是用户在推荐卡上看到的几何——确定性写入，
      // 不依赖 LLM 复述（concept.layout 已归一化，含 multi_page 的 pageCount）。
      if (input.concept?.layout) skill.layout = { ...input.concept.layout };
      // V4.2.8 §52：推荐角色 → 槽位确定性并入（进入角色步骤即见 Draft Slots）。
      if (input.concept?.characters) mergeConceptCharacterSlots(skill, input.concept);
      const errors = validateComicSkill(skill);
      return errors.length === 0 ? { ok: true, value: { skill } } : { ok: false, problems: errors };
    },
    'AI 起草的漫画 Skill 不完整（缺名称 / 槽位 / 必选主角），请重试。',
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, skill: run.value.skill, ...modelInfo(byok) };
}

function normalizePatchList(raw: unknown, kind: 'skill' | 'character' | 'panel'): ComicSkillPatch[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const whitelist = kind === 'skill'
    ? COMIC_SKILL_PATCH_FIELDS
    : kind === 'character' ? COMIC_CHARACTER_PATCH_FIELDS : COMIC_PANEL_PATCH_FIELDS;
  const patches: ComicSkillPatch[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const field = typeof record.field === 'string' ? record.field.trim() : '';
    if (!(whitelist as readonly string[]).includes(field)) continue;
    if (!('value' in record)) continue;
    const slotId = typeof record.slotId === 'string' ? record.slotId.trim() : undefined;
    if (field.startsWith('characterSlot.') && !slotId) continue;
    patches.push({
      field,
      value: record.value,
      slotId: slotId || undefined,
      reason: typeof record.reason === 'string' ? record.reason.trim() : undefined,
    });
  }
  return patches.length ? patches : null;
}

export async function patchComicSkill(input: {
  skill: ComicSkill;
  instruction: string;
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ patches: ComicSkillPatch[] }>> {
  const resolved = resolvePlannerOrError('comic-skill-patch');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const skillBrief = {
    name: input.skill.name,
    comicForm: input.skill.comicForm,
    visualStyle: input.skill.visualStyle,
    layout: input.skill.layout,
    storyPattern: input.skill.storyPattern,
    dialogueStyle: input.skill.dialogueStyle,
    humorStyle: input.skill.humorStyle,
    characterSlots: input.skill.characterSlots,
  };

  const userContent = [
    '当前漫画 Skill 概要（JSON）：',
    JSON.stringify(skillBrief, null, 2),
    '',
    '用户修改指令：',
    input.instruction.trim(),
  ].join('\n');

  const run = await runWithRetry(
    byok,
    { systemPrompt: PATCH_SKILL_SYSTEM_PROMPT, userContent, feature: 'comic-skill-patch', onStage: input.onStage },
    record => {
      const patches = normalizePatchList(record.patches, 'skill');
      return patches
        ? { ok: true, value: { patches } }
        : { ok: false, problems: ['patches 为空，或所有 field 都不在白名单内'] };
    },
    'AI 未返回任何白名单内的有效补丁，请换个说法重试。',
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, patches: run.value.patches, ...modelInfo(byok) };
}

export async function draftComicCharacter(input: {
  skill: ComicSkill;
  slotId: string;
  notes?: string;
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ character: ComicCharacter }>> {
  const resolved = resolvePlannerOrError('comic-character-draft');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const slot = input.skill.characterSlots.find(item => item.slotId === input.slotId);
  if (!slot) return { ok: false, error: '角色槽位不存在。' };

  const userContent = [
    '漫画 Skill 概要：',
    JSON.stringify({
      name: input.skill.name,
      comicForm: input.skill.comicForm,
      visualStyle: input.skill.visualStyle,
      humorStyle: input.skill.humorStyle,
    }, null, 2),
    '',
    '目标角色槽位（JSON）：',
    JSON.stringify(slot, null, 2),
    ...(input.notes?.trim() ? ['', '用户补充要求：', input.notes.trim()] : []),
  ].join('\n');

  const run = await runWithRetry(
    byok,
    { systemPrompt: DRAFT_CHARACTER_SYSTEM_PROMPT, userContent, feature: 'comic-character-draft', onStage: input.onStage },
    record => {
      const character = normalizeComicCharacter(record);
      return character
        ? { ok: true, value: { character } }
        : { ok: false, problems: ['角色对象缺少 name 字段（或不是 JSON 对象）'] };
    },
    'AI 起草的角色缺少名字，请重试。',
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, character: run.value.character, ...modelInfo(byok) };
}

export async function patchComicCharacter(input: {
  character: ComicCharacter;
  instruction: string;
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ patches: ComicSkillPatch[] }>> {
  const resolved = resolvePlannerOrError('comic-character-patch');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const userContent = [
    '当前角色（JSON）：',
    JSON.stringify({
      name: input.character.name,
      description: input.character.description,
      role: input.character.role,
      appearance: input.character.appearance,
      immutableTraits: input.character.immutableTraits,
      mutableTraits: input.character.mutableTraits,
      defaultClothing: input.character.defaultClothing,
      colorPalette: input.character.colorPalette,
      negativeConstraints: input.character.negativeConstraints,
    }, null, 2),
    '',
    '用户修改指令：',
    input.instruction.trim(),
  ].join('\n');

  const run = await runWithRetry(
    byok,
    { systemPrompt: PATCH_CHARACTER_SYSTEM_PROMPT, userContent, feature: 'comic-character-patch', onStage: input.onStage },
    record => {
      const patches = normalizePatchList(record.patches, 'character');
      return patches
        ? { ok: true, value: { patches } }
        : { ok: false, problems: ['patches 为空，或所有 field 都不在白名单内'] };
    },
    'AI 未返回任何白名单内的有效补丁，请换个说法重试。',
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, patches: run.value.patches, ...modelInfo(byok) };
}

/** §38.2 大白话改单格：只 patch 指令涉及的那一格（草稿态或已应用均可）。 */
export async function patchComicPanel(input: {
  panel: ComicPanel;
  instruction: string;
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ patches: ComicSkillPatch[] }>> {
  const resolved = resolvePlannerOrError('comic-panel-patch');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const userContent = [
    '当前这一格分镜（JSON）：',
    JSON.stringify({
      order: input.panel.order,
      scene: input.panel.scene,
      shotType: input.panel.shotType,
      camera: input.panel.camera,
      composition: input.panel.composition,
      characterActions: input.panel.characterActions,
      characterExpressions: input.panel.characterExpressions,
      background: input.panel.background,
      environmentText: input.panel.environmentText ?? null,
    }, null, 2),
    '',
    '用户修改指令：',
    input.instruction.trim(),
  ].join('\n');

  const run = await runWithRetry(
    byok,
    { systemPrompt: PATCH_PANEL_SYSTEM_PROMPT, userContent, feature: 'comic-panel-patch', onStage: input.onStage },
    record => {
      const patches = normalizePatchList(record.patches, 'panel');
      return patches
        ? { ok: true, value: { patches } }
        : { ok: false, problems: ['patches 为空，或所有 field 都不在白名单内'] };
    },
    'AI 未返回任何白名单内的有效补丁，请换个说法重试。',
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, patches: run.value.patches, ...modelInfo(byok) };
}

// ---------------------------------------------------------------------------
// Story Planner（Phase 5）：本期故事（结构化，不是一段 Prompt 字符串）
// ---------------------------------------------------------------------------

const PLAN_STORY_SYSTEM_PROMPT = `你是 CyImagePro 的漫画故事策划。用户给出漫画 Skill（规则）与 recurring 角色，你为「本期」规划一个结构化故事。

故事对象字段（全部简体中文）：
- title：本期标题（12 字内）
- topic：本期选题一句话
- summary：本期内容摘要（2-3 句）
- characterIds：出场角色 id 数组（只能用输入列出的角色 id）
- beats：叙事节拍数组，长度必须等于 panelCount；每拍一句话描述这一格发生什么（按 Skill 的 storyPattern 逐拍填充）
- endingType：结局类型 twist|punchline|warm|flat|custom
- panelCount：格数（必须等于输入指定的格数）

规则：
- 严格遵循 Skill 的 storyPattern 节奏与 humorStyle / intent 基调
- 每一拍是「画面可见的事实」（谁在哪做什么），不是抽象评论
- 只使用输入给出的角色；输入没列的角色不得出场

输出格式（严格遵守）：只输出一个 JSON 对象（故事本体），不要解释、前言或 Markdown 代码块。`;

export async function planComicStory(input: {
  skill: ComicSkill;
  characters: ComicCharacter[];
  requirement: string;
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ story: ComicStory }>> {
  const resolved = resolvePlannerOrError('comic-story-plan');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const panelCount = input.skill.layout.panelCount;
  const userContent = [
    '漫画 Skill（JSON）：',
    JSON.stringify({
      name: input.skill.name,
      comicForm: input.skill.comicForm,
      storyPattern: input.skill.storyPattern,
      humorStyle: input.skill.humorStyle,
      intent: input.skill.intent,
      layout: input.skill.layout,
      dialogueStyle: input.skill.dialogueStyle,
    }, null, 2),
    '',
    'recurring 角色（只能用这些 id）：',
    JSON.stringify(input.characters.map(character => ({
      id: character.id, name: character.name, role: character.role,
      description: character.description,
    })), null, 2),
    '',
    `格数：${panelCount}（beats 长度与 panelCount 都必须等于 ${panelCount}）`,
    '',
    '本期选题需求：',
    input.requirement.trim(),
  ].join('\n');

  const run = await runWithRetry(
    byok,
    { systemPrompt: PLAN_STORY_SYSTEM_PROMPT, userContent, feature: 'comic-story-plan', maxTokens: COMIC_PLANNER_MAX_TOKENS, onStage: input.onStage },
    record => {
      const story = normalizeComicStory(record);
      if (!story) return { ok: false, problems: ['故事对象缺少 title 或 beats（无法归一化）'] };
      const known = new Set(input.characters.map(character => character.id));
      story.characterIds = story.characterIds.filter(id => known.has(id));
      if (story.beats.length !== story.panelCount) story.panelCount = story.beats.length;
      return story.beats.length >= 1
        ? { ok: true, value: { story } }
        : { ok: false, problems: ['beats 节拍数组为空'] };
    },
    'AI 规划的故事缺少节拍（beats），请重试。',
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, story: run.value.story, ...modelInfo(byok) };
}

// ---------------------------------------------------------------------------
// Storyboard（Phase 6）：故事 → 分镜（无字底图）+ 对白草稿（文字层）
// ---------------------------------------------------------------------------

const STORYBOARD_SYSTEM_PROMPT = `你是 CyImagePro 的漫画分镜师。输入漫画 Skill 与本期故事（beats），你把它展开为逐格分镜 + 对白草稿。

分镜数组 panels，每项：
- order：格序（从 0 开始连续递增，等于节拍序号）
- scene：这一格的画面场景描述（无字底图：只写画面可见内容，禁止在对白/文字出现在画面里的语义）
- characterIds：本格出场角色 id（只能用输入列出的）
- shotType：景别（远景/全景/中景/近景/特写）
- camera：机位（平视/俯视/仰视/侧面）
- composition：构图（居中/三分/对角/留白方向）
- characterActions：角色动作数组（每格可变；遵守角色 displayRule 镜头限制）
- characterExpressions：角色表情数组
- props：道具数组（可为空）
- background：背景描述（具体环境，不是泛化词；见下方「场景表现」规则）
- time：这一格发生在什么时候（清晨/白天/傍晚/夜晚/课间/深夜…，每格必填）
- environmentText：画面内环境文字（店名/标语/招牌；仅当故事明确需要才填，否则空字符串）

对白数组 dialogues，每项：
- panelId：所属格（填该格的 id；格 id 格式为 panel-{order}，如 panel-0 / panel-1）
- speakerId：说话者角色 id；旁白用 "narrator"
- type：speech|thought|caption|title|subtitle
- text：台词（简体中文；遵循 Skill 的 dialogueStyle：短句口语化）
- position：{"x":0..1,"y":0..1} 归一化坐标（气泡在本格的建议位置，避开人物脸部）

规则：
- panels 数量必须严格等于节拍数；每格对应一拍
- 每格至少 1 条对白（除纯画面格）；对白属于文字层，画面本身始终无字
- 遵守角色槽位 displayRule（如「仅手部与麦克风，不露脸」的槽位，动作与构图不得露脸）

场景表现（V4.2.12 硬要求——背景不许接近纯色空白）：
- background 必须写「在哪里 + 有什么」，禁止只写「教室背景/室内/简单背景」这类泛化词。
  正确示例：「简化的幼儿园教室，浅色黑板、两排小课桌、墙上贴着歪歪扭扭的儿童画，背景保持萌系简笔风，不抢主体」
- 同一场景的多格 background 用完全相同的描述文字（保证背景跨格连续一致）
- background 只描述环境陈设，不得引入新的主要角色（背景最多出现无名路人剪影）
- shotType 全系列不许只用同一种：连续格之间至少有一格换景别（如第 1 格全景交代环境 → 第 2 格中景 → 第 3/4 格近景/特写抓情绪）
- characterActions 每格至少 1 个具体动作（走路/排队/写作业/照镜子/瘫坐…），不许空数组
- characterExpressions 用具体情绪词（开心/焦虑/疲惫/困惑/震惊/无奈…），不许空数组
- time 每格必填（同一场景多格可相同）

输出格式（严格遵守）：只输出一个 JSON 对象：{"panels":[…],"dialogues":[…]}，不要解释、前言或 Markdown 代码块。`;

export async function draftStoryboard(input: {
  skill: ComicSkill;
  story: ComicStory;
  characters: ComicCharacter[];
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ panels: ComicPanel[]; dialogues: ComicDialogue[] }>> {
  const resolved = resolvePlannerOrError('comic-storyboard');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const userContent = [
    '漫画 Skill（JSON）：',
    JSON.stringify({
      name: input.skill.name,
      visualStyle: input.skill.visualStyle,
      layout: input.skill.layout,
      dialogueStyle: input.skill.dialogueStyle,
      characterSlots: input.skill.characterSlots,
    }, null, 2),
    '',
    '本期故事（JSON）：',
    JSON.stringify(input.story, null, 2),
    '',
    '出场角色（只能用这些 id）：',
    JSON.stringify(input.characters.map(character => ({
      id: character.id, name: character.name, role: character.role,
      appearance: character.appearance, mutableTraits: character.mutableTraits,
    })), null, 2),
    '',
    `分镜数量：${input.story.panelCount}（panels 数组必须严格等于 ${input.story.panelCount} 个，order 从 0 连续递增）`,
  ].join('\n');

  const run = await runWithRetry(
    byok,
    { systemPrompt: STORYBOARD_SYSTEM_PROMPT, userContent, feature: 'comic-storyboard', maxTokens: COMIC_PLANNER_MAX_TOKENS, onStage: input.onStage },
    record => {
      const rawPanels = Array.isArray(record.panels) ? record.panels : [];
      const panels = rawPanels
        .map(normalizeComicPanel)
        .filter((panel): panel is ComicPanel => panel !== null);
      if (panels.length !== input.story.panelCount) {
        return { ok: false, problems: [
          `panels 有效数量为 ${panels.length}（要求严格等于故事格数 ${input.story.panelCount}）`
          + (rawPanels.length !== panels.length ? `，原始 ${rawPanels.length} 项中 ${rawPanels.length - panels.length} 项缺少 scene 被丢弃` : ''),
        ] };
      }
      // 统一 id 为 panel-{order} 并按 order 重排（LLM id 漂移容错）
      panels.sort((a, b) => a.order - b.order);
      const idMap = new Map<string, string>();
      panels.forEach((panel, index) => {
        const canonical = `panel-${index}`;
        idMap.set(panel.id, canonical);
        panel.id = canonical;
        panel.order = index;
      });
      const knownCharacters = new Set(input.characters.map(character => character.id));
      for (const panel of panels) {
        panel.characterIds = panel.characterIds.filter(id => knownCharacters.has(id));
      }
      const rawDialogues = Array.isArray(record.dialogues) ? record.dialogues : [];
      const dialogues = rawDialogues
        .map(item => {
          if (!item || typeof item !== 'object') return null;
          const recordDialogue = item as Record<string, unknown>;
          const mapped = idMap.get(typeof recordDialogue.panelId === 'string' ? recordDialogue.panelId.trim() : '')
            ?? (typeof recordDialogue.panelId === 'string' && recordDialogue.panelId.trim() ? recordDialogue.panelId.trim() : '');
          if (mapped) recordDialogue.panelId = mapped;
          return normalizeComicDialogue(recordDialogue);
        })
        .filter((dialogue): dialogue is ComicDialogue => dialogue !== null)
        .filter(dialogue => panels.some(panel => panel.id === dialogue.panelId));
      if (dialogues.length === 0) return { ok: false, problems: ['dialogues 为空，或所有对白都未能关联到有效分镜'] };
      return { ok: true, value: { panels, dialogues } };
    },
    'AI 分镜数量与故事格数不符或缺少对白，请重试。',
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, ...run.value, ...modelInfo(byok) };
}

// ---------------------------------------------------------------------------
// V4.2.14 AI 对白导演（Dialogue Director，docs/ai-comic/27 §2）：
// 已有面板/成图项目的事后对白生成（Planner 模式只产 text / structure，绝不产图）
// ---------------------------------------------------------------------------

export type ComicDialogueDirectMode = 'fill' | 'panel' | 'page';

export interface ComicDialogueProposal {
  /** 目标格（panel order，从 0 开始） */
  order: number;
  /** 说话人：角色快照 id 或 'narrator' */
  speakerId: string;
  text: string;
  type: ComicDialogue['type'];
  suggestedStyle: ComicDialogue['bubbleStyle'];
}

const DIRECT_DIALOGUE_SYSTEM_PROMPT = `你是 CyImagePro 的漫画对白导演。输入本期故事、逐格分镜与出场角色，你为每一格写漫画对白 / 旁白。

输出数组 panels，每项：
- order：格序（从 0 开始，与输入分镜一一对应）
- speaker：说话角色名（必须与输入角色名完全一致；旁白填 "narrator"）
- text：这一格的台词或旁白（简体中文）
- type：speech|thought|caption|title|subtitle
- suggestedStyle：建议气泡样式 id（见下方白名单）

写作铁律：
- 你只写对白：不得改写故事剧情、节拍或结尾，不得发明输入之外的新情节与新角色
- 漫画对白不是作文：每格一句或一个短句，中文 8~24 字以内（maxCharsHint 优先）
- 遵循 Skill 的 dialogueStyle（如短句口语化）；口吻跟角色 role（孩子=稚气、妈妈=温和、老师=教师口吻）
- 最后一格优先保持包袱 / punchline 的爆点，不要解释笑点
- 补全模式（只补空白格）：已有对白的格一律不输出
- 台词要配得上画面（scene 描述），不得与画面事实矛盾

suggestedStyle 白名单（只能填这些 id）：
rounded, soft, cloud-talk, rect, cloud, spiky, sharp, whisper, box-light, box, title-bar, subtitle-bar, hand, stroke-black, stroke-white, plain

输出格式（严格遵守）：只输出一个 JSON 对象：{"panels":[…]}，不要解释、前言或 Markdown 代码块。`;

const DIRECT_STYLE_WHITELIST = new Set([
  'rounded', 'soft', 'cloud-talk', 'rect', 'cloud', 'spiky', 'sharp', 'whisper',
  'box-light', 'box', 'title-bar', 'subtitle-bar', 'hand', 'stroke-black', 'stroke-white', 'plain',
]);

const DIRECT_TYPE_SET = new Set(['speech', 'thought', 'caption', 'title', 'subtitle']);

/**
 * Story + Panels + Characters → 每格对白建议（V4.2.14 §31~§37）。
 * mode：fill = 只补无对白的格（默认，绝不覆盖人工内容）；panel = 重新生成本格；
 * page = 重新生成整页（覆盖策略由 UI 二次确认后才提交）。
 */
export async function directComicDialogues(input: {
  skill: Pick<ComicSkill, 'name' | 'dialogueStyle' | 'humorStyle'>;
  story: ComicStory | null;
  panels: Array<Pick<ComicPanel, 'id' | 'order' | 'scene' | 'characterIds'>>;
  characters: Array<Pick<ComicCharacter, 'id' | 'name' | 'role'>>;
  existingDialogues: Array<Pick<ComicDialogue, 'panelId' | 'text'>>;
  mode: ComicDialogueDirectMode;
  targetPanelOrder?: number;
  maxCharsHint?: number;
  onStage?: ComicPlannerStageListener;
}): Promise<ComicPlannerOutcome<{ proposals: ComicDialogueProposal[] }>> {
  const maxChars = input.maxCharsHint ?? 24;
  // 可见性 = 有文字（与 applyDialogueDrafts 的 fill 铁律同一语义）：空文字对白
  // 只存在于内存编辑态，不算「已有对白」，对应的格仍是 fill 的合法目标。
  const panelsWithDialogue = new Set(
    input.existingDialogues
      .filter(item => item.text.trim().length > 0)
      .map(item => item.panelId),
  );

  // 零成本前置守卫（V4.2.13 残留修复）：fill 模式在「所有格都已有对白」的项目里
  // 结构上不可能产出合法建议——此前仍白跑两轮模型调用，再报通用的「请重试」错误
  // （重试永不可能成功），真实 GUI 表现即「AI 生成对白一点就报错」。这里在发起
  // 任何模型调用前直接给出可行动的明确错误。
  if (input.panels.length === 0) {
    return { ok: false, error: '还没有可写对白的分镜：请先在「分镜草稿」阶段生成分镜。' };
  }
  if (input.mode === 'fill' && input.panels.every(panel => panelsWithDialogue.has(panel.id))) {
    return {
      ok: false,
      error: '当前所有格都已有对白，「只补空白格」没有可生成的格。请换「重新生成本格」或「重新生成整页」。',
    };
  }
  if (input.mode === 'panel' && !input.panels.some(panel => panel.order === (input.targetPanelOrder ?? 0))) {
    return { ok: false, error: `目标格不存在（order = ${input.targetPanelOrder ?? 0}），请重新选择目标格。` };
  }

  const resolved = resolvePlannerOrError('comic-dialogue-direct');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;
  const modeLine = input.mode === 'fill'
    ? `补全模式：只输出当前没有对白的格（共 ${input.panels.filter(panel => !panelsWithDialogue.has(panel.id)).length} 格待补）；已有对白的格一律不要输出。`
    : input.mode === 'panel'
      ? `重新生成本格：只输出 order = ${input.targetPanelOrder ?? 0} 这一格。`
      : '重新生成整页：每一格都输出一条对白建议。';

  const userContent = [
    '漫画 Skill（JSON）：',
    JSON.stringify({
      name: input.skill.name,
      dialogueStyle: input.skill.dialogueStyle,
      humorStyle: input.skill.humorStyle,
    }, null, 2),
    '',
    input.story
      ? `本期故事（含结尾节拍，JSON）：\n${JSON.stringify({
        title: input.story.title,
        summary: input.story.summary,
        beats: input.story.beats,
        endingType: input.story.endingType,
      }, null, 2)}`
      : '本期故事：暂无（按分镜画面直接写对白）',
    '',
    '逐格分镜（order 与 scene 一一对应）：',
    JSON.stringify(input.panels.map(panel => ({
      order: panel.order,
      scene: panel.scene,
      characters: panel.characterIds
        .map(id => input.characters.find(character => character.id === id)?.name)
        .filter((name): name is string => Boolean(name)),
      hasDialogue: panelsWithDialogue.has(panel.id),
    })), null, 2),
    '',
    '出场角色（口吻跟 role）：',
    JSON.stringify(input.characters.map(character => ({
      name: character.name, role: character.role,
    })), null, 2),
    '',
    `本次任务：${modeLine}`,
    `每格字数上限：${maxChars} 字（一句或一个短句）`,
  ].join('\n');

  const run = await runWithRetry(
    byok,
    { systemPrompt: DIRECT_DIALOGUE_SYSTEM_PROMPT, userContent, feature: 'comic-dialogue-direct', maxTokens: COMIC_PLANNER_MAX_TOKENS, onStage: input.onStage },
    record => {
      const rawPanels = Array.isArray(record.panels) ? record.panels : [];
      const byOrder = new Map(input.panels.map(panel => [panel.order, panel]));
      const nameToId = new Map(input.characters.map(character => [character.name, character.id]));
      const proposals: ComicDialogueProposal[] = [];
      for (const item of rawPanels) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        const order = Number(raw.order);
        const panel = Number.isInteger(order) ? byOrder.get(order) : undefined;
        if (!panel) continue;
        const text = typeof raw.text === 'string' ? raw.text.trim() : '';
        if (!text) continue;
        const speaker = typeof raw.speaker === 'string' ? raw.speaker.trim() : 'narrator';
        const speakerId = speaker === 'narrator' || speaker === '旁白'
          ? 'narrator'
          : nameToId.get(speaker) ?? input.characters.find(c => c.id === speaker)?.id ?? 'narrator';
        const typeRaw = typeof raw.type === 'string' ? raw.type : 'speech';
        const type: ComicDialogue['type'] = DIRECT_TYPE_SET.has(typeRaw)
          ? typeRaw as ComicDialogue['type']
          : 'speech';
        const styleRaw = typeof raw.suggestedStyle === 'string' ? raw.suggestedStyle : '';
        const suggestedStyle = (DIRECT_STYLE_WHITELIST.has(styleRaw) ? styleRaw : 'rounded') as ComicDialogue['bubbleStyle'];
        proposals.push({ order, speakerId, text: text.slice(0, maxChars), type, suggestedStyle });
      }
      if (proposals.length === 0) {
        return { ok: false, problems: ['proposals 为空，或全部建议都未能关联到有效分镜'] };
      }
      if (input.mode === 'panel') {
        const only = proposals.filter(proposal => proposal.order === input.targetPanelOrder);
        if (only.length === 0) return { ok: false, problems: [`重新生成本格模式要求只输出 order = ${input.targetPanelOrder ?? 0} 的建议`] };
        return { ok: true, value: { proposals: only } };
      }
      if (input.mode === 'fill') {
        const fillOnly = proposals.filter(proposal => !panelsWithDialogue.has(byOrder.get(proposal.order)!.id));
        if (fillOnly.length === 0) return { ok: false, problems: ['补全模式不允许输出已有对白的格（当前所有格都已有对白？请换「重新生成本格/整页」）'] };
        return { ok: true, value: { proposals: fillOnly } };
      }
      return { ok: true, value: { proposals } };
    },
    'AI 对白建议为空或未关联到有效分镜，请重试。',
  );
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, proposals: run.value.proposals, ...modelInfo(byok) };
}
