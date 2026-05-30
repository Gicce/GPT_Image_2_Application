import type { GallerySearchCriteria } from '../../types';
import {
  GALLERY_STOP_WORD_PATTERN,
  ORIENTATION_LANDSCAPE_PATTERN,
  ORIENTATION_OPTIONS,
  ORIENTATION_PORTRAIT_PATTERN,
  ORIENTATION_SQUARE_PATTERN,
  SEMANTIC_SEARCH_PATTERN,
  STYLE_ANIME_PATTERN,
  STYLE_COMMERCE_PATTERN,
  STYLE_DARK_PATTERN,
  STYLE_OPTIONS,
  STYLE_REALISTIC_PATTERN,
  STYLE_WESTERN_PATTERN,
  STYLE_WHITE_BG_PATTERN,
  SUBJECT_ICON_PATTERN,
  SUBJECT_OPTIONS,
  SUBJECT_PERSON_PATTERN,
  SUBJECT_POSTER_PATTERN,
  SUBJECT_PRODUCT_PATTERN,
  SUBJECT_SCENE_PATTERN,
  SUBJECT_TRANSPARENT_PATTERN,
  TIME_LAST_30_DAYS_PATTERN,
  TIME_LAST_7_DAYS_PATTERN,
  TIME_LAST_MONTH_PATTERN,
  TIME_LAST_WEEK_PATTERN,
  TIME_OPTIONS,
  TIME_THIS_MONTH_PATTERN,
  TIME_TODAY_PATTERN,
  USAGE_OPTIONS,
  USAGE_REFERENCE_PATTERN,
  USAGE_REMOVE_BG_PATTERN,
  USAGE_UPSCALE_PATTERN,
} from './agentPatterns';

export type TimeRange = { start: number; end: number; label: string };

export type GalleryPreset = {
  label: string;
  criteria: Partial<GallerySearchCriteria>;
};

export const DEFAULT_GALLERY_CRITERIA: GallerySearchCriteria = {
  timeRange: '',
  subjects: [],
  styles: [],
  orientation: '不限',
  usage: '仅查看',
  extra: '',
};

export {
  TIME_OPTIONS,
  SUBJECT_OPTIONS,
  STYLE_OPTIONS,
  ORIENTATION_OPTIONS,
  USAGE_OPTIONS,
};

const TIME_YESTERDAY_PATTERN = /昨天/;

export function parseGalleryTimeRange(text: string): TimeRange | null {
  const now = new Date();

  if (TIME_YESTERDAY_PATTERN.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: start.getTime(), end: end.getTime(), label: '昨天' };
  }

  if (TIME_LAST_MONTH_PATTERN.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: start.getTime(), end: end.getTime(), label: '上个月' };
  }

  if (TIME_THIS_MONTH_PATTERN.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: start.getTime(), end: now.getTime() + 1, label: '本月' };
  }

  if (TIME_LAST_WEEK_PATTERN.test(text)) {
    const day = now.getDay() || 7;
    const thisWeekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
    const start = new Date(thisWeekStart);
    start.setDate(thisWeekStart.getDate() - 7);
    return { start: start.getTime(), end: thisWeekStart.getTime(), label: '上周' };
  }

  if (TIME_LAST_7_DAYS_PATTERN.test(text)) {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    return { start: start.getTime(), end: now.getTime() + 1, label: '最近 7 天' };
  }

  if (TIME_LAST_30_DAYS_PATTERN.test(text)) {
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    return { start: start.getTime(), end: now.getTime() + 1, label: '最近 30 天' };
  }

  if (TIME_TODAY_PATTERN.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: start.getTime(), end: now.getTime() + 1, label: '今天' };
  }

  return null;
}

function pushUnique(target: string[], value: string, condition: boolean) {
  if (condition && !target.includes(value)) target.push(value);
}

export function createGalleryCriteriaFromText(text: string): GallerySearchCriteria {
  const criteria: GallerySearchCriteria = { ...DEFAULT_GALLERY_CRITERIA, subjects: [], styles: [] };

  if (TIME_YESTERDAY_PATTERN.test(text)) criteria.timeRange = '昨天';
  else if (TIME_TODAY_PATTERN.test(text)) criteria.timeRange = '今天';
  else if (TIME_LAST_MONTH_PATTERN.test(text)) criteria.timeRange = '上个月';
  else if (TIME_LAST_7_DAYS_PATTERN.test(text)) criteria.timeRange = '最近 7 天';
  else if (TIME_LAST_30_DAYS_PATTERN.test(text)) criteria.timeRange = '最近 30 天';

  pushUnique(criteria.styles, '欧美', STYLE_WESTERN_PATTERN.test(text));
  pushUnique(criteria.subjects, '人物/模特', SUBJECT_PERSON_PATTERN.test(text));
  pushUnique(criteria.subjects, '产品', SUBJECT_PRODUCT_PATTERN.test(text));
  pushUnique(criteria.subjects, '图标', SUBJECT_ICON_PATTERN.test(text));
  pushUnique(criteria.subjects, '海报', SUBJECT_POSTER_PATTERN.test(text));
  pushUnique(criteria.subjects, '场景', SUBJECT_SCENE_PATTERN.test(text));
  pushUnique(criteria.subjects, '透明背景', SUBJECT_TRANSPARENT_PATTERN.test(text));
  pushUnique(criteria.styles, '白底', STYLE_WHITE_BG_PATTERN.test(text));
  pushUnique(criteria.styles, '二次元', STYLE_ANIME_PATTERN.test(text));
  pushUnique(criteria.styles, '写实', STYLE_REALISTIC_PATTERN.test(text));
  pushUnique(criteria.styles, '暗黑', STYLE_DARK_PATTERN.test(text));
  pushUnique(criteria.styles, '商业电商', STYLE_COMMERCE_PATTERN.test(text));

  if (ORIENTATION_LANDSCAPE_PATTERN.test(text)) criteria.orientation = '横图';
  if (ORIENTATION_PORTRAIT_PATTERN.test(text)) criteria.orientation = '竖图';
  if (ORIENTATION_SQUARE_PATTERN.test(text)) criteria.orientation = '方图';

  if (USAGE_REFERENCE_PATTERN.test(text)) criteria.usage = '找参考图';
  if (USAGE_REMOVE_BG_PATTERN.test(text)) criteria.usage = '透明背景';
  if (USAGE_UPSCALE_PATTERN.test(text)) criteria.usage = '高清放大';

  return criteria;
}

export function getGalleryPresets(text: string): GalleryPreset[] {
  const wantsProduct = SUBJECT_PRODUCT_PATTERN.test(text) || STYLE_WHITE_BG_PATTERN.test(text) || STYLE_COMMERCE_PATTERN.test(text);
  const wantsPeople = STYLE_WESTERN_PATTERN.test(text) || SUBJECT_PERSON_PATTERN.test(text);

  if (wantsProduct) {
    return [
      { label: '最近 7 天 + 产品图 + 高分辨率', criteria: { timeRange: '最近 7 天', subjects: ['产品'], styles: ['白底', '商业电商'], usage: '找参考图' } },
      { label: '最近 30 天 + 白底/电商', criteria: { timeRange: '最近 30 天', subjects: ['产品'], styles: ['白底', '商业电商'], usage: '仅查看' } },
      { label: '上个月 + 产品素材', criteria: { timeRange: '上个月', subjects: ['产品'], styles: ['商业电商'], usage: '仅查看' } },
    ];
  }

  if (wantsPeople) {
    return [
      { label: '最近 7 天 + 人物/模特', criteria: { timeRange: '最近 7 天', subjects: ['人物/模特'], styles: ['欧美'], orientation: '不限', usage: '找参考图' } },
      { label: '最近 30 天 + 竖图优先', criteria: { timeRange: '最近 30 天', subjects: ['人物/模特'], styles: ['欧美'], orientation: '竖图', usage: '找参考图' } },
      { label: '上个月 + 人像素材', criteria: { timeRange: '上个月', subjects: ['人物/模特'], orientation: '不限', usage: '仅查看' } },
    ];
  }

  return [
    { label: '最近 7 天 + 按时间最新 + 不限题材', criteria: { timeRange: '最近 7 天', subjects: [], styles: [], orientation: '不限', usage: '仅查看' } },
    { label: '最近 30 天 + 优先高分辨率', criteria: { timeRange: '最近 30 天', subjects: [], styles: [], orientation: '不限', usage: '仅查看' } },
    { label: '上个月 + 已生成图片', criteria: { timeRange: '上个月', subjects: [], styles: [], orientation: '不限', usage: '仅查看' } },
  ];
}

export function mergeGalleryCriteria(base: GallerySearchCriteria, patch: Partial<GallerySearchCriteria>): GallerySearchCriteria {
  return {
    ...base,
    ...patch,
    subjects: patch.subjects ? [...patch.subjects] : base.subjects,
    styles: patch.styles ? [...patch.styles] : base.styles,
  };
}

export function galleryCriteriaToQuery(query: string, criteria: GallerySearchCriteria): string {
  return [
    query,
    criteria.timeRange,
    ...criteria.subjects,
    ...criteria.styles,
    criteria.orientation && criteria.orientation !== '不限' ? criteria.orientation : '',
    criteria.usage && criteria.usage !== '仅查看' ? criteria.usage : '',
    criteria.extra,
  ].filter(Boolean).join(' ');
}

export function shouldUseSemanticSearch(criteria: GallerySearchCriteria, query: string): boolean {
  const semanticText = [...criteria.subjects, ...criteria.styles, criteria.extra].join(' ');
  return SEMANTIC_SEARCH_PATTERN.test(semanticText || query);
}

export function queryTerms(text: string): string[] {
  const terms = new Set<string>();
  const groups: Array<[RegExp, string[]]> = [
    [STYLE_WESTERN_PATTERN, ['欧美', '西方', '外国', 'western', 'caucasian', 'european', 'american']],
    [SUBJECT_PERSON_PATTERN, ['模特', '人像', '人物', '真人', '女生', 'model', 'portrait', 'person']],
    [STYLE_WHITE_BG_PATTERN, ['白底', '白色背景', 'white background']],
    [SUBJECT_PRODUCT_PATTERN, ['产品', '商品', 'product']],
    [SUBJECT_ICON_PATTERN, ['图标', 'icon']],
    [SUBJECT_TRANSPARENT_PATTERN, ['透明', '抠图', 'transparent']],
  ];

  for (const [regex, values] of groups) {
    if (regex.test(text)) values.forEach(value => terms.add(value.toLowerCase()));
  }

  text
    .toLowerCase()
    .split(/[\s,，。？！、-]+/)
    .filter(term => term.length >= 2 && !GALLERY_STOP_WORD_PATTERN.test(term))
    .forEach(term => terms.add(term));

  return Array.from(terms);
}

export function textMatchScore(terms: string[], haystack: string): number {
  if (terms.length === 0) return 0;
  const value = haystack.toLowerCase();
  return terms.reduce((score, term) => score + (value.includes(term) ? 18 : 0), 0);
}
