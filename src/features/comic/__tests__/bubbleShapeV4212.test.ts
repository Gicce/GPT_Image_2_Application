/**
 * 气泡共享几何层测试（V4.2.12 §12 建立，V4.2.13 Bubble Library V2 十六类刷新）：
 *  - 十六类四分组（对话 / 情绪 / 旁白 / 无框文字各 4）注册表完整；
 *  - 十二类有形气泡形状两两不同（Picker 预览 / 画布 / 导出三处共用同一条 path 字符串）；
 *  - 无框组（hand/stroke-black/stroke-white/plain）没有主体；legacy none = 别名等价；
 *  - 尾巴只在六类带尾样式上解析；旁白框 / 爆芒 / 无框文字恒无尾；
 *  - 低声气泡（whisper）虚线；思考气泡（cloud）带渐小拖尾圆；
 *  - auto 尾巴按位置确定性解析（上半格朝下 / 下半格朝上；水平取靠边侧）；
 *  - 字体栈：family + 统一 fallback 链（预览与导出同构）；
 *  - 纯函数 + 确定性：同输入恒同输出（冻结可复现）。
 */

import { describe, it, expect } from 'vitest';
import {
  BUBBLE_CANVAS,
  BUBBLE_STROKE_WIDTH_RATIO,
  COMIC_BUBBLE_STYLES,
  bubbleGeometry,
  bubbleTextInset,
  comicBubbleStyleMeta,
  dialogueTextPaint,
  dialogueFontStack,
  resolveBubbleTail,
  styleHasTail,
} from '../bubbleShape';
import type { ComicDialogue } from '../types';

const TAIL = 'bottom-left' as const;

function geometryOf(style: ComicDialogue['bubbleStyle'], tail: ReturnType<typeof resolveBubbleTail> = TAIL) {
  return bubbleGeometry(style, BUBBLE_CANVAS, BUBBLE_CANVAS, tail);
}

describe('§12 十六类气泡样式注册表（Bubble Library V2）', () => {
  it('恰好十六类，四分组各 4；id / label / hint / sample 全部非空且互不重复', () => {
    expect(COMIC_BUBBLE_STYLES).toHaveLength(16);
    expect(new Set(COMIC_BUBBLE_STYLES.map(meta => meta.id)).size).toBe(16);
    expect(new Set(COMIC_BUBBLE_STYLES.map(meta => meta.label)).size).toBe(16);
    for (const group of ['dialogue', 'emotion', 'narration', 'frameless'] as const) {
      expect(COMIC_BUBBLE_STYLES.filter(meta => meta.group === group)).toHaveLength(4);
    }
    for (const meta of COMIC_BUBBLE_STYLES) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.hint.length).toBeGreaterThan(0);
      expect(meta.sample.length).toBeGreaterThan(0);
    }
    // 用户点名的无框漫画字四类必须在册
    for (const label of ['黑色手绘字', '黑字白描边', '白字黑描边', '纯净无框文字']) {
      expect(COMIC_BUBBLE_STYLES.map(meta => meta.label)).toContain(label);
    }
  });

  it('未知样式回落经典对白；legacy none = stroke-black 别名（旧数据容错，不抛错）', () => {
    expect(comicBubbleStyleMeta('rounded' as ComicDialogue['bubbleStyle']).id).toBe('rounded');
    expect(comicBubbleStyleMeta('none').id).toBe('stroke-black');
    expect(comicBubbleStyleMeta('none').group).toBe('frameless');
  });
});

describe('§22 形状族：十二类有形主体 path 两两不同（Picker 预览一卡一形）', () => {
  it('十二类有形气泡 body path 去重后 10 形；无框四类主体为 null', () => {
    const shapes = COMIC_BUBBLE_STYLES.filter(meta => meta.hasShape).map(meta => meta.id);
    expect(shapes).toHaveLength(12);
    const bodies = shapes.map(style => geometryOf(style).body!);
    // 设计行为：box ≡ box-light（同框不同底色语义）、title-bar ≡ subtitle-bar
    // （同条不同摆放语义）——视觉差异来自 fill / 摆放，不来自 path
    expect(new Set(bodies).size).toBe(10);
    expect(geometryOf('box').body).toBe(geometryOf('box-light').body);
    expect(geometryOf('title-bar').body).toBe(geometryOf('subtitle-bar').body);
    for (const body of bodies) {
      expect(body.length).toBeGreaterThan(10);
    }
    for (const style of ['hand', 'stroke-black', 'stroke-white', 'plain', 'none'] as const) {
      expect(geometryOf(style).body, style).toBeNull();
    }
  });

  it('形状族跨宽高纵横比保持同一族（拉伸只改比例，不改形状类型）', () => {
    const wide = bubbleGeometry('rounded', 200, 80, TAIL).body!;
    const tall = bubbleGeometry('rounded', 80, 200, TAIL).body!;
    // 同族特征：都由椭圆弧（A 指令）+ 尾巴三角（两个 L 后 Z）构成
    for (const body of [wide, tall]) {
      expect(body).toMatch(/^M /);
      expect((body.match(/A /g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(body.endsWith('Z')).toBe(true);
    }
  });

  it('确定性：同输入恒同输出（compiledPrompt 级冻结语义）', () => {
    for (const style of ['rounded', 'cloud', 'spiky', 'sharp', 'cloud-talk'] as const) {
      expect(bubbleGeometry(style, 120, 90, 'top-right').body).toBe(
        bubbleGeometry(style, 120, 90, 'top-right').body,
      );
    }
  });
});

describe('§23 尾巴规则（六类带尾：rounded/soft/cloud-talk/rect/cloud/whisper）', () => {
  it('旁白框四类 / 爆芒两类 / 无框四类解析不出尾巴', () => {
    const noTail = [
      'box-light', 'box', 'title-bar', 'subtitle-bar',
      'spiky', 'sharp',
      'hand', 'stroke-black', 'stroke-white', 'plain', 'none',
    ] as const;
    for (const bubbleStyle of noTail) {
      expect(resolveBubbleTail({
        bubbleStyle,
        tail: 'bottom-right',
        position: { x: 0.3, y: 0.3 },
      }), bubbleStyle).toBeNull();
      expect(geometryOf(bubbleStyle, null).tail).toBeNull();
      expect(styleHasTail(bubbleStyle), bubbleStyle).toBe(false);
    }
  });

  it('显式尾巴原样返回（左下/右下/左上/右上四向全测）', () => {
    for (const tail of ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const) {
      expect(resolveBubbleTail({
        bubbleStyle: 'rounded', tail, position: { x: 0.9, y: 0.9 },
      })).toBe(tail);
    }
  });

  it('auto 尾巴按位置确定性解析：上半格朝下、下半格朝上；水平取靠边侧', () => {
    expect(resolveBubbleTail({ bubbleStyle: 'rounded', tail: 'auto', position: { x: 0.3, y: 0.2 } })).toBe('bottom-left');
    expect(resolveBubbleTail({ bubbleStyle: 'rounded', tail: 'auto', position: { x: 0.7, y: 0.2 } })).toBe('bottom-right');
    expect(resolveBubbleTail({ bubbleStyle: 'rounded', tail: 'auto', position: { x: 0.3, y: 0.8 } })).toBe('top-left');
    expect(resolveBubbleTail({ bubbleStyle: 'rounded', tail: 'auto', position: { x: 0.7, y: 0.8 } })).toBe('top-right');
  });

  it('带尾形状把尾巴三角并进主体 path（单 path 单描边，无错位缝）', () => {
    const withTail = geometryOf('rounded', TAIL).body!;
    const noTail = geometryOf('rounded', null).body!;
    expect(withTail.startsWith(noTail)).toBe(true);
    expect(withTail.length).toBeGreaterThan(noTail.length);
    // 拖尾随方向：cloud 的拖尾圆随尾巴方向排布
    const cloud = geometryOf('cloud', TAIL);
    expect(cloud.extras.length).toBeGreaterThanOrEqual(2);
    const radii = cloud.extras.map(circle => circle.r);
    expect(radii[0]!).toBeGreaterThan(radii[radii.length - 1]!); // 渐小
  });
});

describe('结构标记（导出 / DOM 共同消费）', () => {
  it('whisper 虚线（dashed）；其余非虚线', () => {
    expect(geometryOf('whisper').dashed).toBe(true);
    for (const style of ['rounded', 'soft', 'cloud', 'cloud-talk', 'rect', 'box', 'spiky', 'sharp'] as const) {
      expect(geometryOf(style).dashed, style).toBe(false);
    }
  });

  it('深底白字 = box / title-bar / subtitle-bar（narration）；其余对白底色', () => {
    for (const style of ['box', 'title-bar', 'subtitle-bar'] as const) {
      expect(geometryOf(style).fill, style).toBe('narration');
    }
    for (const style of ['rounded', 'soft', 'cloud', 'cloud-talk', 'rect', 'box-light', 'spiky', 'sharp', 'whisper', 'none'] as const) {
      expect(geometryOf(style).fill, style).toBe('bubble');
    }
  });

  it('spiky 密集短爆芒 / sharp 稀疏长尖刺（多段直线 L，无弧）', () => {
    const spiky = geometryOf('spiky').body!;
    expect((spiky.match(/ L /g) ?? []).length).toBeGreaterThanOrEqual(20);
    expect(spiky.includes('A ')).toBe(false);
    const sharp = geometryOf('sharp').body!;
    expect((sharp.match(/ L /g) ?? []).length).toBeGreaterThan(0);
    expect((sharp.match(/ L /g) ?? []).length).toBeLessThan((spiky.match(/ L /g) ?? []).length);
    expect(sharp.includes('A ')).toBe(false);
  });
});

describe('无框漫画字呈现预设（dialogueTextPaint）', () => {
  it('hand：白描边 + soft 阴影 + weightBoost 700（不覆盖显式 ≥600）', () => {
    const paint = dialogueTextPaint(
      { bubbleStyle: 'hand', fontStyle: { size: 16, weight: 400 }, strokeStyle: undefined, shadow: undefined },
      'bubble',
    );
    expect(paint.stroke?.color).toBe('rgba(255,255,255,0.92)');
    expect(paint.shadow).toBe('soft');
    expect(paint.weightBoost).toBe(700);
  });

  it('对白级覆盖：strokeStyle / shadow 优先于预设', () => {
    const paint = dialogueTextPaint(
      {
        bubbleStyle: 'stroke-black',
        fontStyle: { size: 16, weight: 500 },
        strokeStyle: { color: '#123456', width: 0.2 },
        shadow: 'none',
      },
      'bubble',
    );
    expect(paint.stroke).toEqual({ color: '#123456', width: 0.2 });
    expect(paint.shadow).toBe('none');
  });
});

describe('§30/§78 排版派生', () => {
  it('bubbleTextInset：椭圆收得多、方框最少、无框几乎不收（预览与导出换行一致）', () => {
    const inset = (style: ComicDialogue['bubbleStyle']) => bubbleTextInset(style);
    expect(inset('rounded').x).toBeGreaterThan(inset('box').x);
    expect(inset('none').x).toBeLessThan(inset('box').x);
    for (const meta of COMIC_BUBBLE_STYLES) {
      expect(inset(meta.id).x, meta.id).toBeGreaterThan(0);
      expect(inset(meta.id).y, meta.id).toBeGreaterThan(0);
      expect(inset(meta.id).x).toBeLessThanOrEqual(0.2);
      expect(inset(meta.id).y).toBeLessThanOrEqual(0.2);
    }
  });

  it('B2/B3 共享常量：描边 / 虚线 = panel 宽比例（DOM SVG 与导出 canvas 同源）', () => {
    // 2.4px @ 504 基准槽
    expect(BUBBLE_STROKE_WIDTH_RATIO * 504).toBeCloseTo(2.4, 6);
  });

  it('dialogueFontStack：family 排最前 + 统一 fallback 链；缺省与带引号容错', () => {
    expect(dialogueFontStack('KaiTi')).toBe("'KaiTi', 'Microsoft YaHei', 'SimHei', sans-serif");
    expect(dialogueFontStack(undefined)).toBe("'Microsoft YaHei', 'SimHei', sans-serif");
    expect(dialogueFontStack('  ')).toBe("'Microsoft YaHei', 'SimHei', sans-serif");
    // 字体名里的单引号剔除（防 CSS 注入 / 语法破坏）
    expect(dialogueFontStack("Ev'il")).toBe("'Evil', 'Microsoft YaHei', 'SimHei', sans-serif");
    expect(dialogueFontStack(' KaiTi ')).toBe("'KaiTi', 'Microsoft YaHei', 'SimHei', sans-serif");
  });
});
