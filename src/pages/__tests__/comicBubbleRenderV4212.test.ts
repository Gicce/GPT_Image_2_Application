/**
 * 气泡 DOM 渲染测试（V4.2.12 §15/§22 建立，V4.2.13 引擎化刷新）——Picker 预览 /
 * 画布编辑共用 ComicBubbleBox（bubbleShape 共享几何的唯一 DOM 消费方），用
 * renderToStaticMarkup 做真实渲染断言（本仓库无 @testing-library，SSR 渲染是
 * 组件级行为测试的仓库惯例补充）：
 *  - Bubble Library V2 十六类四分组（对话/情绪/旁白/无框文字各 4）；
 *  - DOM 定位 = 共享布局引擎 calculateDialogueLayout 的 px 输出（WYSIWYG 契约：
 *    编辑器内联 left/top/width/height 与导出 canvas 同一 layout.box，逐值相等）；
 *  - 无框组（hand/stroke-black/stroke-white/plain）不渲染 svg 主体；
 *  - legacy none 渲染等价 stroke-black（is-none 类保留）；
 *  - whisper 虚线类 / box 旁白深底类 / 选中态 / 四角 resize 手柄；
 *  - 字体栈进 style.fontFamily（family + fallback 链，与导出同构）；
 *  - 尾巴持久值随对白数据走（换尾巴 → path 变化 = 画布立即重画）。
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ComicBubbleBox from '../../features/comic/components/ComicBubbleBox';
import BubbleStylePicker from '../../features/comic/components/BubbleStylePicker';
import { COMIC_BUBBLE_STYLES } from '../../features/comic/bubbleShape';
import { calculateDialogueLayout, estimateMeasure } from '../../features/comic/dialogueLayout';
import type { ComicDialogue, ComicDialogueBubble, ComicDialogueTail } from '../../features/comic/types';

/** 编辑器逻辑面板（四格 1080 画布槽位 = 504px；与导出 slot 同尺度）。 */
const PANEL = { width: 504, height: 504 };

function makeDialogue(overrides: Partial<ComicDialogue> = {}): ComicDialogue {
  return {
    id: 'dlg-render',
    panelId: 'panel-0',
    speakerId: 'narrator',
    type: 'speech',
    text: '你好！',
    position: { x: 0.4, y: 0.25 },
    alignment: 'center',
    fontStyle: { size: 16, weight: 500 },
    bubbleStyle: 'rounded',
    tail: 'bottom-left',
    ...overrides,
  };
}

function renderBubble(overrides: Partial<ComicDialogue> = {}): string {
  return renderToStaticMarkup(createElement(ComicBubbleBox, {
    dialogue: makeDialogue(overrides),
    panel: PANEL,
  }));
}

/** 引擎期望布局（jsdom 无 canvas → runtimeMeasure 回落 estimateMeasure，确定性）。 */
function engineLayout(dialogue: ComicDialogue) {
  return calculateDialogueLayout(dialogue, PANEL, estimateMeasure);
}

function bodyPathOf(markup: string): string | null {
  const match = markup.match(/<path d="([^"]+)"/);
  return match ? match[1]! : null;
}

describe('§15 Picker 预览：十六类四分组一卡一形（真实迷你气泡，非文字标签）', () => {
  const picker = renderToStaticMarkup(createElement(BubbleStylePicker, { value: 'rounded', onChange: () => {} }));
  const cards = picker.split('<button').slice(1);

  it('恰好十六张卡，role=radio + 选中态在选中卡上', () => {
    expect(cards).toHaveLength(16);
    expect(picker).toContain('role="radiogroup"');
    const checked = cards.filter(card => card.includes('aria-checked="true"'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('经典对白');
  });

  it('四分组标题齐全（对白 / 情绪 / 旁白 / 无框文字，各 4 卡）', () => {
    for (const label of ['对白', '情绪', '旁白', '无框文字']) {
      expect(picker).toContain(label);
    }
    expect(cards.filter(card => card.includes('comic-bubble-picker-label'))).toHaveLength(16);
  });

  it('每张卡都有真实迷你气泡预览 + 样式名（预览与画布同源）', () => {
    for (const card of cards) {
      expect(card).toContain('comic-bubble-picker-preview');
      expect(card).toContain('comic-bubble-box');
      expect(card).toContain('comic-bubble-picker-label');
    }
    // 无框组四卡：预览只有文字（无 svg path），其余十二卡有形
    const framelessCards = cards.filter(card =>
      ['黑色手绘字', '黑字白描边', '白字黑描边', '纯净无框文字'].some(label => card.includes(label)));
    expect(framelessCards).toHaveLength(4);
    for (const card of framelessCards) {
      expect(card.includes('<path')).toBe(false);
    }
    expect(cards.filter(card => card.includes('<path')).length).toBe(12);
  });

  it('十二张有形卡预览 path 去重后 10 形（换样式 = 换形状 / 换底色，视觉可见）', () => {
    const paths = cards
      .map(card => card.match(/<path d="([^"]+)"/)?.[1])
      .filter((path): path is string => Boolean(path));
    expect(paths).toHaveLength(12);
    // 设计行为：box ≡ box-light、title-bar ≡ subtitle-bar 共享 path（fill / 摆放语义不同）
    expect(new Set(paths).size).toBe(10);
  });
});

describe('§22 ComicBubbleBox 画布渲染（V4.2.13 WYSIWYG：DOM px = 引擎输出）', () => {
  it('十二类有形气泡的 path 去重后 10 形（box≡box-light / title≡subtitle 同形异色）；type 切换立即反映在 DOM path（受控渲染）', () => {
    const styles = COMIC_BUBBLE_STYLES.filter(meta => meta.hasShape).map(meta => meta.id);
    expect(styles).toHaveLength(12);
    const paths = styles.map(style => bodyPathOf(renderBubble({ bubbleStyle: style })));
    // 设计行为：box ≡ box-light、title-bar ≡ subtitle-bar 共享 path（fill / 摆放语义不同）
    expect(new Set(paths).size).toBe(10);
  });

  it('无框组四类：无 svg 主体，is-none 类保留', () => {
    for (const style of ['hand', 'stroke-black', 'stroke-white', 'plain'] as ComicDialogueBubble[]) {
      const markup = renderBubble({ bubbleStyle: style });
      expect(markup.includes('<svg'), style).toBe(false);
      expect(markup, style).toContain('is-none');
      expect(markup, style).toContain('你好！');
    }
  });

  it('legacy none 渲染等价 stroke-black（白描边阴影预设，is-none 保留）', () => {
    const markup = renderBubble({ bubbleStyle: 'none' });
    expect(markup.includes('<svg')).toBe(false);
    expect(markup).toContain('comic-bubble-none');
    expect(markup).toContain('is-none');
    expect(markup).toContain('你好！');
  });

  it('whisper 虚线类 / box 旁白深底类', () => {
    expect(renderBubble({ bubbleStyle: 'whisper' })).toContain('is-dashed');
    expect(renderBubble({ bubbleStyle: 'box' })).toContain('is-narration');
    expect(renderBubble({ bubbleStyle: 'rounded' })).toContain('is-bubble');
  });

  it('尾巴方向持久值改变 → path 改变（尾巴重画即时可见）', () => {
    const bottom = bodyPathOf(renderBubble({ tail: 'bottom-left' as ComicDialogueTail }))!;
    const top = bodyPathOf(renderBubble({ tail: 'top-right' as ComicDialogueTail }))!;
    expect(bottom).not.toBe(top);
  });

  it('§30 字体栈进 style（family 最前 + fallback 链；与导出 dialogueFontStack 同构）', () => {
    // SSR 将单引号转义为 &#x27;
    expect(renderBubble({ fontStyle: { size: 16, weight: 500, family: 'KaiTi' } }))
      .toContain("font-family:&#x27;KaiTi&#x27;, &#x27;Microsoft YaHei&#x27;, &#x27;SimHei&#x27;, sans-serif");
    expect(renderBubble())
      .toContain("font-family:&#x27;Microsoft YaHei&#x27;, &#x27;SimHei&#x27;, sans-serif");
  });

  it('WYSIWYG 契约：float 帧内联 left/top/width/height 与引擎 layout.box 逐值相等', () => {
    const dialogue = makeDialogue({ position: { x: 0.3, y: 0.2 } });
    const layout = engineLayout(dialogue);
    const markup = renderToStaticMarkup(createElement(ComicBubbleBox, { dialogue, panel: PANEL }));
    expect(markup).toContain(`left:${layout.box.x}px`);
    expect(markup).toContain(`top:${layout.box.y}px`);
    expect(markup).toContain(`width:${layout.box.width}px`);
    expect(markup).toContain(`height:${layout.box.height}px`);
    // 字号 / 行高 / 换行也来自引擎（fontPx = size × panelW / 256，行内容 = wrap 结果）
    expect(markup).toContain(`font-size:${layout.fontPx}px`);
    expect(markup).toContain(`line-height:${layout.lineHeight}px`);
    expect(layout.lines.length).toBeGreaterThan(0);
    for (const line of layout.lines) {
      expect(markup).toContain(line);
    }
  });

  it('固定尺寸（Resize handles 语义）：width/height = size × panel，与引擎一致', () => {
    const dialogue = makeDialogue({ size: { width: 0.4, height: 0.25 } });
    const layout = engineLayout(dialogue);
    const markup = renderToStaticMarkup(createElement(ComicBubbleBox, { dialogue, panel: PANEL }));
    expect(layout.fixed).toBe(true);
    expect(markup).toContain(`width:${layout.box.width}px`);
    expect(markup).toContain(`height:${layout.box.height}px`);
    expect(layout.box.width).toBeCloseTo(0.4 * PANEL.width, 6);
    expect(layout.box.height).toBeCloseTo(0.25 * PANEL.height, 6);
  });

  it('edit 模式 + 选中：四角 resize 手柄（data-corner 全）+ is-selected', () => {
    const markup = renderToStaticMarkup(createElement(ComicBubbleBox, {
      dialogue: makeDialogue(),
      panel: PANEL,
      mode: 'edit',
      selected: true,
    }));
    expect(markup).toContain('is-selected');
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      expect(markup).toContain(`comic-bubble-handle-${corner}`);
      expect(markup).toContain(`data-corner="${corner}"`);
    }
    // 未选中 → 无手柄
    const unselected = renderToStaticMarkup(createElement(ComicBubbleBox, {
      dialogue: makeDialogue(),
      panel: PANEL,
      mode: 'edit',
      selected: false,
    }));
    expect(unselected.includes('comic-bubble-handle')).toBe(false);
  });

  it('data-dialogue-id 暴露在根节点（拖动 / resize 会话定位用）', () => {
    expect(renderBubble()).toContain('data-dialogue-id="dlg-render"');
  });
});
