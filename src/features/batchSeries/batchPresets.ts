/**
 * V4.2.4 通用批量预设引擎 —— 纯数据层。
 *
 * 预设 = 一组可枚举的变量取值（十二生肖 / 十二星座 / 四季节气 / 套装颜色…）。
 * 组件绝不硬编码任何具体预设的内容（十二生肖只出现在本文件的注册表里）；
 * 新增预设 = 注册表加一条，零组件改动。
 */

export interface BatchPresetItem {
  /** 稳定 id（预设内唯一，如 'zodiac-rat'） */
  id: string;
  /** 展示名（如「鼠」） */
  label: string;
  /** 渲染进 Prompt 的变量值（如「机灵的小老鼠」或「鼠」——由预设定义粒度） */
  value: string;
}

export interface BatchPreset {
  id: string;
  name: string;
  /** 变量槽 key（模板里 {{zodiac}} 的名字；同一模板可有多预设共用一个 key） */
  variableKey: string;
  /** 模板中槽位的展示名（如「生肖」），用于 UI 行内提示 */
  variableLabel: string;
  /** 完成主题检测词表：来源任务 Prompt 含任一 item.label / value 即视为该主题已完成（用户可改判） */
  items: BatchPresetItem[];
}

/** 十二生肖：鼠牛虎兔龙蛇马羊猴鸡狗猪（预设注册表唯一事实源，禁止散落组件） */
const CHINESE_ZODIAC_PRESET: BatchPreset = {
  id: 'chinese-zodiac',
  name: '十二生肖',
  variableKey: 'zodiac',
  variableLabel: '生肖',
  items: [
    { id: 'zodiac-rat', label: '鼠', value: '鼠' },
    { id: 'zodiac-ox', label: '牛', value: '牛' },
    { id: 'zodiac-tiger', label: '虎', value: '虎' },
    { id: 'zodiac-rabbit', label: '兔', value: '兔' },
    { id: 'zodiac-dragon', label: '龙', value: '龙' },
    { id: 'zodiac-snake', label: '蛇', value: '蛇' },
    { id: 'zodiac-horse', label: '马', value: '马' },
    { id: 'zodiac-goat', label: '羊', value: '羊' },
    { id: 'zodiac-monkey', label: '猴', value: '猴' },
    { id: 'zodiac-rooster', label: '鸡', value: '鸡' },
    { id: 'zodiac-dog', label: '狗', value: '狗' },
    { id: 'zodiac-pig', label: '猪', value: '猪' },
  ],
};

/** 预设注册表（新预设在这里加一条即可） */
const REGISTRY: BatchPreset[] = [CHINESE_ZODIAC_PRESET];

export function listBatchPresets(): BatchPreset[] {
  return REGISTRY;
}

export function getBatchPreset(id: string): BatchPreset | null {
  return REGISTRY.find(preset => preset.id === id) ?? null;
}
