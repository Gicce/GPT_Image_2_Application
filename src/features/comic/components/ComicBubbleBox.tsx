/**
 * 漫画气泡共享渲染组件（V4.2.12 §22 建立 / V4.2.14 引擎化重构）——DOM 侧唯一
 * 气泡绘制入口：
 *  - 布局 = dialogueLayout.calculateDialogueLayout（唯一 wrap / 盒尺寸 / 字号 /
 *    基线事实源，docs/ai-comic/28）；本组件只做绘制 backend：
 *    SVG path（bubbleShape 共享几何，与导出 Path2D 同一条字符串）+ 逐行 span
 *    （white-space:pre，禁止浏览器自动换行）；
 *  - 文字呈现 = bubbleShape.dialogueTextPaint（无框漫画字描边/阴影/加粗预设）；
 *  - frame='float'：画布 overlay（panel 像素坐标系，由父级传入 Panel Content Rect）；
 *  - frame='inline'：Picker 卡 / 列表内的静态预览（panel = 预览容器逻辑尺寸）；
 *  - mode='edit'：可交互（选中描边高亮 + 四角 Resize 手柄），拖动/缩放由父级
 *    ComicTextStage 用 Pointer Events 处理（坐标铁律：状态只存 0..1 归一化值）。
 */

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { ComicDialogue } from '../types';
import {
  BUBBLE_CANVAS,
  BUBBLE_DASH_PATTERN,
  BUBBLE_STROKE_WIDTH_RATIO,
  DIALOGUE_SOFT_SHADOW,
  bubbleGeometry,
  dialogueEffectiveWeight,
  dialogueFontStack,
  dialogueTextPaint,
} from '../bubbleShape';
import {
  calculateDialogueLayout,
  runtimeMeasure,
  type DialoguePanelRect,
} from '../dialogueLayout';

export type BubbleResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export interface ComicBubbleBoxProps {
  dialogue: ComicDialogue;
  /** Panel Content Rect（编辑器 figure 内容盒 / Picker 预览容器的逻辑像素尺寸）。 */
  panel: DialoguePanelRect;
  frame?: 'float' | 'inline';
  mode?: 'static' | 'edit';
  selected?: boolean;
  className?: string;
  children?: ReactNode;
  onBubblePointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerDown?: (corner: BubbleResizeCorner, event: ReactPointerEvent<HTMLSpanElement>) => void;
  onDoubleClick?: () => void;
}

export default function ComicBubbleBox(props: ComicBubbleBoxProps) {
  const { dialogue, panel } = props;
  const frame = props.frame ?? 'float';
  const mode = props.mode ?? 'static';
  const measure = runtimeMeasure();
  const layout = calculateDialogueLayout(dialogue, panel, measure);
  const geometry = bubbleGeometry(dialogue.bubbleStyle, BUBBLE_CANVAS, BUBBLE_CANVAS, layout.tail);
  const paint = dialogueTextPaint(dialogue, geometry.fill);
  const weight = dialogueEffectiveWeight(dialogue);
  const isNarration = geometry.fill === 'narration';

  // 盒定位：panel 像素坐标（WYSIWYG 契约：与导出 drawDialogue 同一 layout.box）
  const frameStyle: CSSProperties =
    frame === 'float'
      ? {
        position: 'absolute',
        left: layout.box.x,
        top: layout.box.y,
        width: layout.box.width,
        height: layout.box.height,
      }
      : {
        position: 'relative',
        width: layout.box.width,
        height: layout.box.height,
        maxWidth: '100%',
      };

  // 文字块：textRect 内垂直居中；逐行渲染（white-space:pre，浏览器不重排）
  const textBlockHeight = layout.lines.length * layout.lineHeight;
  const textBlockTop = layout.textRect.y
    + Math.max(0, (layout.textRect.height - textBlockHeight) / 2)
    - layout.box.y;
  const textStyle: CSSProperties = {
    position: 'absolute',
    left: layout.textRect.x - layout.box.x,
    top: textBlockTop,
    width: layout.textRect.width,
    fontSize: layout.fontPx,
    fontWeight: weight,
    fontFamily: dialogueFontStack(dialogue.fontStyle.family),
    color: paint.fill,
    textAlign: dialogue.alignment,
    lineHeight: `${layout.lineHeight}px`,
    whiteSpace: 'pre',
    ...(paint.stroke
      ? {
        WebkitTextStrokeWidth: `${Math.max(1, paint.stroke.width * layout.fontPx)}px`,
        WebkitTextStrokeColor: paint.stroke.color,
        paintOrder: 'stroke fill',
      }
      : {}),
    ...(paint.shadow === 'soft'
      ? {
        // B5 修复：阴影随字号等比（bubbleShape 共享常量，导出 canvas shadow 同源）
        textShadow: `0 ${DIALOGUE_SOFT_SHADOW.offsetY * layout.fontPx}px ${DIALOGUE_SOFT_SHADOW.blur * layout.fontPx}px ${DIALOGUE_SOFT_SHADOW.dropColor}, 0 0 ${DIALOGUE_SOFT_SHADOW.halo * layout.fontPx}px ${DIALOGUE_SOFT_SHADOW.haloColor}`,
      }
      : {}),
  };

  // 气泡描边 / 虚线（B2/B3 修复）：panel 宽比例（bubbleShape 共享常量）。
  // SVG viewBox 100 单位映射 box 像素 → 属性值 ×（BUBBLE_CANVAS/box.width）换算，
  // 渲染后描边宽 = RATIO × panel.width，与导出 canvas lineWidth 同一比例。
  const strokeUnit = BUBBLE_STROKE_WIDTH_RATIO * panel.width * BUBBLE_CANVAS / layout.box.width;
  const pathStyle: CSSProperties = {
    strokeWidth: strokeUnit,
    ...(geometry.dashed
      ? {
        strokeDasharray: `${BUBBLE_DASH_PATTERN.on * panel.width * BUBBLE_CANVAS / layout.box.width} ${BUBBLE_DASH_PATTERN.off * panel.width * BUBBLE_CANVAS / layout.box.width}`,
      }
      : {}),
  };

  const classes = [
    'comic-bubble-box',
    // V4.2.13 根因修复延续：inline 帧自带定位上下文（is-inline → position:relative）
    frame === 'inline' ? 'is-inline' : '',
    `comic-bubble-${dialogue.bubbleStyle}`,
    isNarration ? 'is-narration' : 'is-bubble',
    geometry.dashed ? 'is-dashed' : '',
    geometry.body ? '' : 'is-none',
    mode === 'edit' ? 'is-editable' : '',
    props.selected ? 'is-selected' : '',
    layout.overflow ? 'is-overflow' : '',
    props.className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      style={frameStyle}
      onPointerDown={props.onBubblePointerDown}
      onDoubleClick={props.onDoubleClick}
      role={mode === 'edit' ? 'button' : undefined}
      aria-label={mode === 'edit' ? `对白：${dialogue.text || '（空）'}` : undefined}
      data-dialogue-id={dialogue.id}
    >
      {geometry.body && (
        <svg
          className="comic-bubble-svg"
          viewBox={`0 0 ${BUBBLE_CANVAS} ${BUBBLE_CANVAS}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={geometry.body} style={pathStyle} />
          {geometry.extras.map(circle => (
            <circle key={`${circle.cx}-${circle.cy}`} cx={circle.cx} cy={circle.cy} r={circle.r} />
          ))}
        </svg>
      )}
      {layout.lines.length > 0 ? (
        <span className="comic-bubble-text" style={textStyle} data-testid="comic-bubble-text">
          {layout.lines.map((line, index) => (
            <span key={index} className="comic-bubble-line">{line}</span>
          ))}
        </span>
      ) : (
        mode === 'edit' && <span className="comic-bubble-text comic-bubble-placeholder">输入文字…</span>
      )}
      {props.children}
      {mode === 'edit' && props.selected && (
        <>
          {(['nw', 'ne', 'sw', 'se'] as BubbleResizeCorner[]).map(corner => (
            <span
              key={corner}
              className={`comic-bubble-handle comic-bubble-handle-${corner}`}
              data-corner={corner}
              role="button"
              aria-label={`调整气泡大小（${corner}）`}
              onPointerDown={event => {
                event.stopPropagation();
                props.onResizePointerDown?.(corner, event);
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}
