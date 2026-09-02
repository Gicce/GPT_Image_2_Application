/**
 * 气泡样式视觉选择器（V4.2.12 §12 建立 / V4.2.14 Bubble Library V2）——
 * 十六类样式按四分组（对白 / 情绪 / 旁白 / 无框文字）逐卡渲染真实迷你预览
 * （复用 ComicBubbleBox → bubbleShape 共享几何 + dialogueLayout 引擎，与画布 /
 * 导出同源）。切换即时重画画布（受控 value → 父级 upsertDialogue）。
 */

import type { ComicDialogue, ComicDialogueBubble } from '../types';
import {
  COMIC_BUBBLE_GROUP_LABELS,
  comicBubbleStyleMeta,
  comicBubbleStylesByGroup,
  type ComicBubbleStyleGroup,
} from '../bubbleShape';
import ComicBubbleBox from './ComicBubbleBox';

export interface BubbleStylePickerProps {
  value: ComicDialogueBubble;
  onChange: (style: ComicDialogueBubble) => void;
  id?: string;
}

/** Picker 卡预览画布（逻辑像素；inline 帧的 Panel Content Rect）。 */
const PREVIEW_PANEL = { width: 96, height: 54 };

const GROUP_ORDER: ComicBubbleStyleGroup[] = ['dialogue', 'emotion', 'narration', 'frameless'];

/** 预览用最小对白（固定小尺寸，文字用样式样例）。 */
function previewDialogue(style: ComicDialogueBubble): ComicDialogue {
  const meta = comicBubbleStyleMeta(style);
  return {
    id: `preview-${meta.id}`,
    panelId: 'preview',
    speakerId: 'narrator',
    type: 'speech',
    text: meta.sample,
    position: { x: 0.5, y: 0.5 },
    alignment: 'center',
    fontStyle: { size: 8, weight: 600 },
    bubbleStyle: meta.id,
    tail: 'bottom-left',
  };
}

export default function BubbleStylePicker(props: BubbleStylePickerProps) {
  // legacy `none` 在 Picker 中呈现为其渲染等价样式（stroke-black）的选中态
  const selectedId = comicBubbleStyleMeta(props.value).id;
  return (
    <div className="comic-bubble-picker" id={props.id} role="radiogroup" aria-label="气泡样式">
      {GROUP_ORDER.map(group => (
        <div key={group} className="comic-bubble-picker-group" data-group={group}>
          <span className="comic-bubble-picker-group-label">{COMIC_BUBBLE_GROUP_LABELS[group]}</span>
          <div className="comic-bubble-picker-grid">
            {comicBubbleStylesByGroup(group).map(meta => {
              const selected = selectedId === meta.id;
              return (
                <button
                  key={meta.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`comic-bubble-picker-card${selected ? ' is-selected' : ''}`}
                  title={meta.hint}
                  onClick={() => props.onChange(meta.id)}
                >
                  <span className="comic-bubble-picker-preview">
                    <ComicBubbleBox dialogue={previewDialogue(meta.id)} frame="inline" panel={PREVIEW_PANEL} />
                  </span>
                  <span className="comic-bubble-picker-label">{meta.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
