/**
 * Runtime Skill Registry（V4.2）—— CyImagePro 应用运行时技能注册表。
 *
 * 与 .claude/skills/（Claude Code 开发 Skill）无关；这里是客户端运行时的
 * 「可解释执行层」描述符：把既有 Contract / Rule 系统（人物替换合同、
 * 维度锁定、表情锁定、服装状态机、混合媒介结构、Prompt Compiler……）
 * 按用户能看懂的名字登记，供 Skill Center / Trace / History 展示。
 *
 * 铁律（ADR-018 候选）：Contract 是业务真相，Skill 只是执行与解释层——
 * 本注册表只登记「是什么 / 能不能关」，绝不携带第二份业务状态。
 */

import type { RuntimeSkillCategory } from '../../../types';

export interface RuntimeSkillDefinition {
  /** 稳定英文 id（测试锚点 / 持久化引用）。 */
  id: string;
  /** 用户可见中文名（UI 一律用中文名，内部一律用 id）。 */
  name: string;
  description: string;
  version: string;
  category: RuntimeSkillCategory;
  builtIn: boolean;
  /** false = 核心技能（Skill Center 显示「核心技能 · 始终启用」，禁止假开关）。 */
  canDisable: boolean;
  /** 条件满足时自动启用（如混合媒介模板）。 */
  autoEnable?: boolean;
  /** 适用功能域（当前只有视觉理解复刻工作流）。 */
  applicableTo: string[];
  /**
   * 执行优先级（大者先执行；缺省 0）。执行顺序绝不依赖对象遍历顺序，
   * 引擎按 priority 派生执行序（analysis → identity → clothing → pose/
   * expression → media → anime character → detail sync → locks →
   * optimization → compiler → validator）。
   */
  priority?: number;
  /** 依赖技能（顺序约束：被依赖者先执行；skipped 状态不阻塞依赖者）。 */
  dependsOn?: string[];
}

export const RUNTIME_SKILL_CATEGORY_LABELS: Record<RuntimeSkillCategory, string> = {
  analysis: '分析',
  constraint: '约束',
  optimization: '优化',
  compiler: '编译',
};

export const BUILT_IN_RUNTIME_SKILLS: readonly RuntimeSkillDefinition[] = [
  {
    id: 'visual_analysis',
    name: '视觉模板分析',
    description: '识别画面九维度基线、逐主体姿态与媒介结构并冻结为模板快照（只复用既有分析结果，不重复调用视觉模型）。',
    version: '1.0.0',
    category: 'analysis',
    builtIn: true,
    canDisable: false,
    priority: 100,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'person_replacement',
    name: '人物替换',
    description: '控制人物身份来源、替换范围和模板人物处理（执行人物替换合同 V2）。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    priority: 90,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'clothing_source',
    name: '服装来源',
    description: '决定服装沿用模板、采用人物参考还是自定义描述（执行服装合同与 A/B/C 不变量）。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    priority: 80,
    dependsOn: ['person_replacement'],
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'pose_preservation',
    name: '动作保持',
    description: '锁定未修改主体的姿态、手势、方向（分主体冻结，人物替换不连带改动作）。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    priority: 70,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'expression_preservation',
    name: '表情保持',
    description: '保持 wink、闭眼、视线和面部表情（动作未修改时表情独立锁定，禁止稀释成半眯眼）。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    priority: 65,
    dependsOn: ['pose_preservation'],
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'composition_preservation',
    name: '构图保持',
    description: '未修改构图时锁定主体布局、对称与裁切基线。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    priority: 60,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'camera_preservation',
    name: '镜头保持',
    description: '未修改镜头时锁定景别、角度与景深基线。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    priority: 55,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'hybrid_media_preservation',
    name: '混合媒介保持',
    description: '保持真人、动漫、平面设计不同媒介层（模板为混合媒介时自动启用，禁止整图统一成单一媒介）。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    autoEnable: true,
    priority: 50,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'anime_character_consistency',
    name: '动漫角色一致性',
    description: '把「Person Identity + 模板动漫媒介结构」派生为唯一 Canonical Anime Character 角色卡；次要动漫主体与全部动漫局部插图复用同一角色设计，禁止各自独立动漫化。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    autoEnable: true,
    priority: 45,
    dependsOn: ['person_replacement', 'clothing_source', 'hybrid_media_preservation'],
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'detail_insert_sync',
    name: '细节插图同步',
    description: '全部动漫局部插图（相框头像 / 眼部 / 发型特写）绑定动漫主角色卡：锁定发型 / 脸型 / 眼型 / 服装基底，只允许裁切与构图变化。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: false,
    autoEnable: true,
    priority: 40,
    dependsOn: ['anime_character_consistency'],
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'region_replacement',
    name: '区域替换',
    description: '在指定矩形 / 画笔区域内执行替换（空间指令 + 真实 mask；停用后区域合同不编译进 Prompt）。',
    version: '1.0.0',
    category: 'constraint',
    builtIn: true,
    canDisable: true,
    priority: 35,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'replication_boost',
    name: '复刻度增强',
    description: '加强模板复刻约束：未开放修改的构图 / 风格 / 氛围从严保持，绝不作用于人物身份。',
    version: '1.0.0',
    category: 'optimization',
    builtIn: true,
    canDisable: true,
    priority: 30,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'prompt_optimization',
    name: 'Prompt 优化',
    description: '由视觉优化模型把已确定合同表达成更好的生成语言；只能表达，不能推翻硬性合同。',
    version: '1.0.0',
    category: 'optimization',
    builtIn: true,
    canDisable: false,
    autoEnable: true,
    priority: 20,
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'prompt_compilation',
    name: 'Prompt 编译',
    description: '把图片角色 / 人物 / 区域 / 媒介 / 动漫角色 / 细节插图 / 表情 / 服装 / 维度 / 模板保留各层合同确定性编译进最终 Prompt。',
    version: '1.0.0',
    category: 'compiler',
    builtIn: true,
    canDisable: false,
    priority: 10,
    dependsOn: ['detail_insert_sync'],
    applicableTo: ['vision_recreation'],
  },
  {
    id: 'contract_validation',
    name: '合同校验',
    description: '生成前结构化校验锁定维度、动漫角色绑定与模板基线冲突，冲突即阻断（绝不静默放行）。',
    version: '1.0.0',
    category: 'compiler',
    builtIn: true,
    canDisable: false,
    priority: 5,
    dependsOn: ['prompt_compilation'],
    applicableTo: ['vision_recreation'],
  },
];

const BY_ID = new Map(BUILT_IN_RUNTIME_SKILLS.map(skill => [skill.id, skill]));

export function runtimeSkillById(id: string): RuntimeSkillDefinition | undefined {
  return BY_ID.get(id);
}

/** 生效技能（Skill Center 停用只影响可停用项；核心技能恒生效）。 */
export function effectiveRuntimeSkills(disabledSkillIds: ReadonlyArray<string>): RuntimeSkillDefinition[] {
  const disabled = new Set(disabledSkillIds);
  return BUILT_IN_RUNTIME_SKILLS.filter(skill => !(skill.canDisable && disabled.has(skill.id)));
}

/**
 * 按 priority 派生执行序（稳定排序：priority 相同按注册顺序）。
 * 执行顺序绝不依赖对象遍历顺序；dependsOn 的拓扑正确性由注册表测试守护。
 */
export function runtimeSkillExecutionOrder(): RuntimeSkillDefinition[] {
  return [...BUILT_IN_RUNTIME_SKILLS].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
