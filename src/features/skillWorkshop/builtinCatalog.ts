import type { SkillCatalogItem, SkillPackage } from './types';

export const BUILTIN_DESK_PACKAGE: SkillPackage = {
  schema_version: 1, skill_id: 'professional_desk_setup', version: '1.0.0', name: '专业桌搭', domain: 'desk_setup',
  summary: '真实产品、人体工学与商业摄影约束下的可落地专业桌搭。', readiness: 'ready',
  wizard_steps: ['选择模板', '填写用途', '上传素材', '视觉分析', '确认素材卡', '风格与配置', '摘要与报价', '确认生成'],
  asset_roles: ['brand_logo', 'product', 'space', 'device', 'style_reference'],
  defaults: { base: 'business-walnut', style: 'business', theme: 'none', platform: 'general' },
  profiles: [
    { id: 'business-walnut', name: 'Business Walnut', kind: 'base', prompt: '浅胡桃木专业升降桌，32英寸横向主屏居中、27英寸竖屏在左，同一套双臂桌夹支架，MX Keys S 与 MX Master 3S，JONSBO TK-1 黑色机箱，暖白光，极简摆件。' },
    { id: 'business', name: '商务', kind: 'style', prompt: '克制的黑灰与胡桃木商务设计，干净、成熟、专业。' },
    { id: 'minimal', name: '极简', kind: 'style', prompt: '大面积留白、低饱和材质、极少装饰。' },
    { id: 'creator', name: 'Creator', kind: 'style', prompt: '创作者工作流，加入少量真实内容制作设备。' },
    { id: 'gaming', name: '电竞', kind: 'style', prompt: '高级克制电竞语言，不使用彩虹 RGB 或廉价霓虹。' },
    { id: 'industrial', name: '工业', kind: 'style', prompt: '金属、深色结构与真实工业材质。' },
    { id: 'cozy', name: '温馨', kind: 'style', prompt: '柔和布艺、暖光与少量植物，保持专业操作区。' },
    { id: 'cute', name: '可爱', kind: 'style', prompt: '少女感或可爱元素限制在整体约25–30%，甜而不幼稚。' },
    { id: 'none', name: '无主题', kind: 'theme', prompt: '不加入额外主题或 IP 元素。' },
    { id: 'original-cute', name: '原创可爱', kind: 'theme', prompt: '只使用原创抽象可爱元素，不模仿第三方 IP。' },
    { id: 'custom', name: '自定义素材主题', kind: 'theme', prompt: '主题只来自用户合法提供并确认的参考素材，不改变专业结构。' },
    { id: 'general', name: '通用图片', kind: 'platform', prompt: '适合通用展示，主体完整，画面边缘保留安全空间。' },
  ],
  core_rules: [
    '产品必须真实可购买，结构、尺寸、材质与承重逻辑可信。', '主显示器居中，键盘与主屏中轴对齐，鼠标在右侧自然操作区。',
    '双显示器共用一个桌夹底座、一个主立柱和两支独立机械臂，使用真实 VESA 安装。', '桌下隐藏插线板、适配器与线材，桌面无明显杂乱电线。',
    '主机保留合理散热空间，摆件不得侵占键鼠操作区。', '使用35–50mm等效镜头的专业商业摄影，避免超广角畸变。',
  ],
  review_rubric: ['主屏居中与人体工学', '单套双臂桌夹结构', '真实产品与比例', '理线与散热', '主题强度与操作区', '摄影与材质真实性'],
};

export const BUILTIN_CATALOG: SkillCatalogItem[] = [
  { skill_id: 'professional_desk_setup', version: '1.0.0', name: '专业桌搭', domain: 'desk_setup', summary: BUILTIN_DESK_PACKAGE.summary, readiness: 'ready' },
  ...([['ecommerce', '电商图片'], ['product', '产品摄影'], ['brand_ad', '品牌广告'], ['interior', '室内空间'], ['sports', '运动视觉'], ['ui', 'UI 视觉']] as const)
    .map(([domain, name]) => ({ skill_id: `${domain}_foundation`, version: '0.1.0', name, domain, summary: '领域结构已建立，正在专业验收。', readiness: 'testing' as const })),
];
