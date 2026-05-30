export const GALLERY_RECALL_PATTERN =
  /(我记得|之前|以前|上次|曾经|好像有|有没有|翻一下|找出来).*(照片|相片|图|图片|模特|女生|人像|人物)|(图库|图片库|素材库|找|检索|搜索|筛选).*(图|图片|照片|相片|模特|女生|人像|产品)|(最新|最近|昨天|上个月|本月|今天).*(生成|图|图片|照片)|(最新|最近).*(有哪些|哪些图片|哪些照片)/i;

export const IMAGE_UNDERSTANDING_PATTERN =
  /(这些|这几张|这张).*(是什么|哪里|题材|风格|类型|内容|分析|识别|描述|解释)|\b(what|where|subject|theme|style|describe|analy[sz]e)\b/i;

export const REMOVE_BACKGROUND_PATTERN =
  /(透明背景|去背景|去除背景|移除背景|抠图|扣图|去底|无背景|remove\s*bg)/i;

export const IMAGE_EDIT_PATTERN =
  /(改成|修改|编辑|替换|换成|去掉|去除|移除|抠图|扣图|参考|按照|基于|变成|修复|增强|重绘|加入|加上|放到|融入|保留人物|换背景)/i;

export const EXPLICIT_IMAGE_GENERATION_PATTERN =
  /(生成|创建|画|设计|做一张|做几张|帮我做|给我来).*(图|图片|图像|海报|头像|图标|logo|主图)|(^|\\s)(做图|出图|生图)($|\\s)/i;

export const TIME_TODAY_PATTERN = /今天/;
export const TIME_YESTERDAY_PATTERN = /昨天/;
export const TIME_LAST_WEEK_PATTERN = /上周/;
export const TIME_LAST_7_DAYS_PATTERN = /(最近|近)\s*(7|七)\s*天|近一周/;
export const TIME_LAST_30_DAYS_PATTERN = /(最近|近)\s*30\s*天|近一个月/;
export const TIME_LAST_MONTH_PATTERN = /上个月|上月/;
export const TIME_THIS_MONTH_PATTERN = /本月|这个月/;

export const ORIENTATION_LANDSCAPE_PATTERN = /横图|横版/;
export const ORIENTATION_PORTRAIT_PATTERN = /竖图|竖版/;
export const ORIENTATION_SQUARE_PATTERN = /方图|正方形/;

export const SUBJECT_PERSON_PATTERN = /模特|人像|人物|真人|女生/;
export const SUBJECT_PRODUCT_PATTERN = /产品|商品/;
export const SUBJECT_ICON_PATTERN = /图标|icon/i;
export const SUBJECT_SCENE_PATTERN = /场景|背景/;
export const SUBJECT_POSTER_PATTERN = /海报/;
export const SUBJECT_TRANSPARENT_PATTERN = /透明|抠图|扣图/;

export const STYLE_WESTERN_PATTERN = /欧美|西方|外国/;
export const STYLE_WHITE_BG_PATTERN = /白底|白色背景/;
export const STYLE_ANIME_PATTERN = /二次元|动漫/;
export const STYLE_REALISTIC_PATTERN = /写实|真实/;
export const STYLE_DARK_PATTERN = /暗黑|恐怖|阴森/;
export const STYLE_COMMERCE_PATTERN = /电商|商业/;

export const USAGE_REFERENCE_PATTERN = /找参考|参考图|图生图/;
export const USAGE_REMOVE_BG_PATTERN = /透明背景|去背景|抠图|扣图/;
export const USAGE_UPSCALE_PATTERN = /高清|放大/;

export const SEMANTIC_SEARCH_PATTERN =
  /(欧美|模特|人物|人像|产品|商品|白底|透明|图标|海报|场景|二次元|写实|暗黑|电商|真实|风格|类似)/;

export const GALLERY_STOP_WORD_PATTERN = /^(?:图库|图片|素材|帮我|查找|搜索|筛选|生成)$/;

export const TIME_OPTIONS = ['今天', '最近 7 天', '最近 30 天', '上个月', '自定义时间'] as const;
export const SUBJECT_OPTIONS = ['人物/模特', '产品', '图标', '场景', '海报', '透明背景', '其他'] as const;
export const STYLE_OPTIONS = ['欧美', '二次元', '写实', '白底', '暗黑', '商业电商'] as const;
export const ORIENTATION_OPTIONS = ['不限', '横图', '竖图', '方图'] as const;
export const USAGE_OPTIONS = ['仅查看', '找参考图', '继续图生图', '透明背景', '高清放大'] as const;
