/**
 * 共享字体选择器（V4.2.12 §30~§37）——项目内字体族选择的唯一实现：
 *  - 只列本机/系统常见字体（不加载外部字体）；
 *  - 触发器恒显示当前选中字体（原生 select 受控值，结构上不会空白）；
 *  - 下拉项 = 字体名 + 示例文字，并按该字体渲染（Chromium/WebView 支持 option 字体样式）；
 *  - 选中了本机不存在的字体（旧项目 / 换机器）→ 追加「原名（不可用）」回退项，
 *    永不出现空白；字体名不在列表也照样显示。
 * 使用方：漫画文字层（首个消费方）。禁止在业务组件里再造平行字体下拉。
 */

export interface FontOption {
  /** CSS font-family 值（可带引号的字体名） */
  value: string;
  /** 中文显示名 */
  label: string;
  sample: string;
}

/** 常见本机字体（Windows 桌面环境优先 + 通用西文兜底；全部本地存在，无网络加载）。 */
export const KNOWN_FONTS: readonly FontOption[] = [
  { value: 'Microsoft YaHei', label: '微软雅黑', sample: '你好漫画 Aa' },
  { value: 'SimHei', label: '黑体', sample: '你好漫画 Aa' },
  { value: 'SimSun', label: '宋体', sample: '你好漫画 Aa' },
  { value: 'KaiTi', label: '楷体', sample: '你好漫画 Aa' },
  { value: 'FangSong', label: '仿宋', sample: '你好漫画 Aa' },
  { value: 'YouYuan', label: '幼圆', sample: '你好漫画 Aa' },
  { value: 'STKaiti', label: '华文楷体', sample: '你好漫画 Aa' },
  { value: 'Segoe UI', label: 'Segoe UI', sample: 'Hello 漫画' },
  { value: 'Georgia', label: 'Georgia', sample: 'Hello 漫画' },
  { value: 'Comic Sans MS', label: 'Comic Sans', sample: 'Hello 漫画' },
];

export const DEFAULT_FONT_LABEL = '默认（跟随导出样式）';

export interface FontSelectProps {
  id?: string;
  /** 当前字体族；undefined/'' = 默认字体 */
  value?: string;
  onChange: (family: string | undefined) => void;
  disabled?: boolean;
}

export default function FontSelect(props: FontSelectProps) {
  const { value } = props;
  const known = value ? KNOWN_FONTS.find(font => font.value === value) : undefined;
  return (
    <select
      id={props.id}
      className="comic-font-select"
      value={value ?? ''}
      disabled={props.disabled}
      onChange={e => props.onChange(e.target.value || undefined)}
    >
      <option value="">{DEFAULT_FONT_LABEL}</option>
      {value && !known && (
        <option value={value}>{`${value}（不可用）`}</option>
      )}
      {KNOWN_FONTS.map(font => (
        <option key={font.value} value={font.value} style={{ fontFamily: `'${font.value}', sans-serif` }}>
          {`${font.label} · ${font.sample}`}
        </option>
      ))}
    </select>
  );
}
