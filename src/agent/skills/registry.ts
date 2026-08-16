/**
 * CyImagePro Agent Skill System - Skill Registry
 *
 * 注册 9 个内置 Skill
 * Skill ID 统一使用 snake_case，不带 "_skill" 后缀
 */

import type { SkillDefinition } from './types';

// ============================================
// Skill Definitions
// ============================================

const generalChatSkill: SkillDefinition = {
  id: 'general_chat',
  name: '普通对话',
  shortName: '对话',
  category: 'chat',
  description: '普通聊天、问答、闲聊，不涉及图片任务',
  keywords: [],
  priority: 0,
  outputMode: 'text',
  buildSystemPrompt: () => '',
};

const promptOptimizeSkill: SkillDefinition = {
  id: 'prompt_optimize',
  name: '提示词优化',
  shortName: '优化',
  category: 'utility',
  description: '优化、改写、翻译图片生成提示词',
  keywords: [
    '优化提示词', '优化 prompt', '优化prompt',
    '改写提示词', '改写prompt',
    '翻译提示词', '翻译prompt',
    '提示词优化', 'prompt优化',
    '帮我写提示词', '帮我写prompt',
    '更好的提示词', '更好的prompt',
  ],
  excludeKeywords: ['生成', '出图', '画一张'],
  priority: 40,
  outputMode: 'text',
  buildSystemPrompt: () => `当前任务：提示词优化

你的职责是帮助用户优化图片生成提示词。

输出规则：
1. 输出优化后的中文提示词
2. 可选输出英文版本（适合 Midjourney/DALL-E 等模型）
3. 不创建任务，只提供可复制的提示词
4. 提示词应包含：主体描述、风格、场景、光线、构图等关键要素
5. 对于商业图片，强调产品突出、背景干净、适合平台规范`,
};

const textToImageSkill: SkillDefinition = {
  id: 'text_to_image',
  name: '文生图',
  shortName: '生图',
  category: 'generate',
  description: '根据文字描述生成图片',
  keywords: [
    '文生图', '生成一张', '画一张', '做一张',
    '出图', '生成图片', '帮我生成', '给我生成',
    '设计一张', '制作一张', '创建一张',
  ],
  excludeKeywords: [],
  requiresImage: false,
  priority: 30,
  outputMode: 'task_draft',
  buildSystemPrompt: () => `当前任务：文生图

你的职责是理解用户的图片生成需求，给出执行建议。

输出规则：
1. 先确认理解用户需求
2. 如缺少关键信息（主体、风格、场景等），主动询问
3. 可输出任务建议，但需用户确认后才执行
4. 不自动扣费，不自动创建任务

如需创建任务建议，可输出结构化块：
\`\`\`json
{
  "type": "cyimagepro_task_draft",
  "skill": "text_to_image",
  "action": "create_image_task",
  "requires_confirmation": true,
  "task_draft": {
    "prompt": "...",
    "size": "1024x1024",
    "count": 4
  }
}
\`\`\`

注意：只输出建议，等待用户确认。`,
};

const imageToImageSkill: SkillDefinition = {
  id: 'image_to_image',
  name: '图生图',
  shortName: '图生图',
  category: 'edit',
  description: '基于参考图进行编辑、换背景、风格迁移',
  keywords: [
    '图生图', '参考图', '参考这张图', '基于这张图',
    '换背景', '改背景', '换成', '改成',
    '修改这张图', '编辑这张图', '调整这张图',
    '保持人物', '保持产品', '保留原图',
    '风格迁移', '换风格',
  ],
  excludeKeywords: ['去背景', '抠图', '透明底'],
  requiresEditableImage: true,
  priority: 50,
  outputMode: 'task_draft',
  buildSystemPrompt: () => `当前任务：图生图

你的职责是帮助用户基于参考图进行编辑。

核心原则：
1. 必须保留原图主体（人物、产品等核心元素）
2. 只修改用户指定区域或风格
3. 避免让模型自由重画导致产品变化

输出规则：
1. 如用户未上传参考图，提醒先上传
2. 确认用户想修改什么（背景、风格、颜色等）
3. 输出任务建议，需用户确认后执行
4. 不自动扣费

如需创建任务建议，可输出结构化块：
\`\`\`json
{
  "type": "cyimagepro_task_draft",
  "skill": "image_to_image",
  "action": "create_image_task",
  "requires_confirmation": true,
  "task_draft": {
    "prompt": "...",
    "source_images": ["用户上传的图片路径"]
  }
}
\`\`\``,
};

const productMainImageSkill: SkillDefinition = {
  id: 'product_main_image',
  name: '商品主图',
  shortName: '主图',
  category: 'generate',
  description: '商品主图、电商主图、淘宝图、闲鱼图、抖音商品图',
  keywords: [
    '主图', '商品图', '产品图', '电商图',
    '商品主图', '产品主图',
    '淘宝主图', '淘宝图',
    '闲鱼图', '闲鱼主图',
    '抖音商品图', '抖音主图',
    '卖点图', '白底图',
    '电商', '淘宝', '闲鱼', '抖音',
  ],
  excludeKeywords: ['去背景', '抠图'],
  priority: 60,
  outputMode: 'task_draft',
  buildSystemPrompt: () => `当前任务：商品主图

你的职责是帮助用户生成电商商品主图。

核心原则：
1. 产品必须突出、清晰
2. 背景干净、适合平台规范
3. 强调卖点视觉呈现
4. 符合淘宝/抖音/闲鱼等平台主图规范

输出规则：
1. 如用户未上传产品图，提醒先上传产品白底图或产品照片
2. 不要瞎编产品外观，必须基于用户提供的图片或描述
3. 建议合适的尺寸（通常 800x800 或 1024x1024）
4. 输出任务建议，需用户确认后执行
5. 不自动扣费

如需创建任务建议，可输出结构化块：
\`\`\`json
{
  "type": "cyimagepro_task_draft",
  "skill": "product_main_image",
  "action": "create_image_task",
  "requires_confirmation": true,
  "task_draft": {
    "prompt": "...",
    "size": "1024x1024",
    "count": 4,
    "source_images": []
  }
}
\`\`\``,
};

const backgroundRemoveSkill: SkillDefinition = {
  id: 'background_remove',
  name: '去背景',
  shortName: '去背景',
  category: 'edit',
  description: '去背景、抠图、透明底',
  keywords: [
    '去背景', '去除背景', '移除背景',
    '抠图', '扣图', '去底',
    '透明背景', '透明底', '无背景',
    'remove bg', 'removebg', 'remove background',
  ],
  excludeKeywords: [],
  requiresEditableImage: true,
  priority: 70,
  outputMode: 'task_draft',
  buildSystemPrompt: () => `当前任务：去背景 / 抠图

你的职责是帮助用户去除图片背景，输出透明 PNG。

核心原则：
1. 识别主体边缘，保持细节完整
2. 输出透明背景 PNG
3. 推荐先抠图，再询问是否需要换背景

输出规则：
1. 如用户未上传图片，提醒先上传
2. 确认用户是否想去背景
3. 输出任务建议，需用户确认后执行
4. 不自动扣费

如需创建任务建议，可输出结构化块：
\`\`\`json
{
  "type": "cyimagepro_task_draft",
  "skill": "background_remove",
  "action": "create_image_task",
  "requires_confirmation": true,
  "task_draft": {
    "source_images": ["用户上传的图片路径"]
  }
}
\`\`\``,
};

const batchTaskSkill: SkillDefinition = {
  id: 'batch_task',
  name: '批量任务',
  shortName: '批量',
  category: 'utility',
  description: '批量生成、多张图、多组 prompt、批量任务',
  keywords: [
    '批量', '批处理',
    '这些图', '全部图', '每张图',
    '多张', '多组', '多个',
    '100张', '50张', '20张', '10张',
  ],
  excludeKeywords: [],
  priority: 55,
  outputMode: 'task_draft',
  buildSystemPrompt: () => `当前任务：批量处理

你的职责是帮助用户规划批量图片任务。

核心原则：
1. 只生成批量计划，不自动执行
2. 必须用户确认后才执行
3. 避免误扣费

输出规则：
1. 先确认批量的具体内容（多少张、什么内容、什么尺寸）
2. 输出批量计划摘要
3. 明确告知费用预估
4. 需用户点击确认后才执行
5. 不自动扣费，不自动创建任务

如需创建任务建议，可输出结构化块：
\`\`\`json
{
  "type": "cyimagepro_task_draft",
  "skill": "batch_task",
  "action": "create_batch_task",
  "requires_confirmation": true,
  "task_draft": {
    "prompt": "...",
    "count": 10,
    "size": "1024x1024"
  }
}
\`\`\`

警告：批量任务可能产生较高费用，务必先让用户确认！`,
};

const visionAnalyzeSkill: SkillDefinition = {
  id: 'vision_analyze',
  name: '视觉理解',
  shortName: '理解',
  category: 'analyze',
  description: '分析图片内容、题材、风格',
  keywords: [
    '分析图片', '分析这张图', '图片分析',
    '识别图片', '识别这张图', '图片识别',
    '这张图是什么', '图片里有什么',
    '看看这张图', '看下这张图',
    '图片内容', '图片题材', '图片风格',
    '描述图片', '描述这张图',
  ],
  excludeKeywords: ['生成', '修改', '换背景'],
  requiresImage: true,
  priority: 65,
  outputMode: 'text',
  buildSystemPrompt: () => `当前任务：图片理解 / 视觉分析

你的职责是分析用户上传的图片内容。

输出规则：
1. 详细描述图片主体、场景、风格、色调
2. 给出 5-8 个关键词标签
3. 可建议后续用途（图生图、风格参考等）
4. 不输出 JSON，自然语言回复
5. 不自动创建任务`,
};

const accountHelpSkill: SkillDefinition = {
  id: 'account_help',
  name: '账户帮助',
  shortName: '账户',
  category: 'utility',
  description: '余额、充值、退款、Token、用量、账号问题',
  keywords: [
    '余额', '账户余额', '我的余额',
    '充值', '怎么充值', '如何充值', '充值方式',
    '退款', '怎么退款', '申请退款',
    'Token', 'token', '代币',
    '用量', '使用量', '消费记录',
    '扣费', '怎么扣费', '扣费规则',
    '账号', '账户问题',
    '多少钱', '价格', '收费标准',
  ],
  excludeKeywords: [],
  priority: 35,
  outputMode: 'text',
  buildSystemPrompt: () => `当前任务：账户帮助

你的职责是帮助用户解答账户相关问题。

输出规则：
1. 只解释余额、充值、退款、Token、用量等问题
2. 不新增后端请求，不读取敏感信息
3. 可基于当前页面已有的账户信息回答
4. 如涉及敏感操作（退款、充值），建议用户去"我的账户"页面操作
5. 不输出 JSON，自然语言回复
6. 不自动创建任务`,
};

// ============================================
// Skill Registry
// ============================================

export const SKILL_REGISTRY: SkillDefinition[] = [
  backgroundRemoveSkill,   // priority 70
  visionAnalyzeSkill,      // priority 65
  productMainImageSkill,   // priority 60
  batchTaskSkill,          // priority 55
  imageToImageSkill,       // priority 50
  promptOptimizeSkill,     // priority 40
  accountHelpSkill,        // priority 35
  textToImageSkill,        // priority 30
  generalChatSkill,        // priority 0 (fallback)
];

// ============================================
// Helper Functions
// ============================================

export function getSkillById(id: string): SkillDefinition | undefined {
  return SKILL_REGISTRY.find(skill => skill.id === id);
}

export function getSkillNameById(id: string): string {
  return getSkillById(id)?.name ?? '普通对话';
}

export function getSkillShortNameById(id: string): string {
  return getSkillById(id)?.shortName ?? '对话';
}
