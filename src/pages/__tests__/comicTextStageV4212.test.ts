/**
 * 文字精修阶段接线源守卫（V4.2.12 §3~§10 建立，V4.2.13 引擎化 + 对白导演刷新）
 * ——「画布直接编辑为主」：
 *  - 画布工具栏：添加对白 / 添加旁白 / 添加文字 三放置键（aria-pressed 切换型）+
 *    AI 生成对白（onOpenAiDirector）+ 导出；放置模式 = Ghost 预览 + 点击落位 + Esc 取消；
 *  - 拖动 / 四角缩放走 Pointer Events（window pointermove/up/cancel；触达不滚页）；
 *  - Inspector 顺序：文字→说话人→类型→气泡样式（V2 十六类视觉卡）→尾巴→字体→
 *    字号→字重→对齐→精确位置与层级（高级：滑杆 + 恢复自适应 + 文字前移/后移）→删除；
 *  - 删除可撤销（toast undo，不做大而全 undo 栈）；
 *  - 分镜顺序归 Storyboard 阶段；Text Stage 只做同格文字 z 序（前移/后移）；
 *  - 零图片 API：结构上不存在任何生图入口（§75/§76 硬约束）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const stage = readFileSync(
  resolve(__dirname, '../../features/comic/components/ComicTextStage.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const picker = readFileSync(
  resolve(__dirname, '../../features/comic/components/BubbleStylePicker.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const bubbleBox = readFileSync(
  resolve(__dirname, '../../features/comic/components/ComicBubbleBox.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const studioCss = readFileSync(resolve(__dirname, '../ComicStudio.css'), 'utf-8').replace(/\r\n/g, '\n');
const directorDialog = readFileSync(
  resolve(__dirname, '../../features/comic/components/AIDialogueDirectorDialog.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('§3/§97 画布直接编辑（工具栏 + 放置模式）', () => {
  test('画布工具栏：三个放置键（aria-pressed 切换型）+ AI 生成对白入口', () => {
    expect(stage).toContain('添加对白');
    expect(stage).toContain('添加旁白');
    expect(stage).toContain('添加文字');
    expect(stage.match(/aria-pressed/g)?.length).toBeGreaterThanOrEqual(3);
    expect(stage).toContain('comic-placement-hint');
    expect(stage).toContain('点击漫画画面放置');
    expect(stage).toContain('Esc 取消');
    expect(stage).toContain('AI 生成对白');
    expect(stage).toContain('props.onOpenAiDirector()');
  });

  test('点画布放置：落点经 clampDialoguePosition + pointerToNormalized，对白带本格 panelId', () => {
    expect(stage).toContain('const point = clampDialoguePosition(toNormalized(event.clientX, event.clientY));');
    expect(stage).toContain('newDialogueDraft(project, selectedPanel.id, panelDialogues.length)');
    // 旁白 → 白底旁白框 + narrator；自由文字 → 无框纯文字
    expect(stage).toContain("placement === 'caption'");
    expect(stage).toContain("bubbleStyle: 'box-light', speakerId: 'narrator'");
    expect(stage).toContain("bubbleStyle: 'plain'");
    // R4 修复：figure 内任意非气泡元素都可落位（不再要求 target === currentTarget）
    expect(stage).toContain("target.closest('.comic-bubble-box')");
  });

  test('放置后自动选中 + 聚焦文字输入框 + Ghost 预览跟随（半透明真实气泡，与落位渲染同一引擎）', () => {
    expect(stage).toContain('setSelectedDialogueId(next.id)');
    // P0-2：落位即聚焦（放置 → 选中 → 直接可打字）
    expect(stage).toContain('document.getElementById(`dlg-text-${next.id}`)?.focus()');
    expect(stage).toContain('ghostDialogue');
    expect(stage).toContain('comic-bubble-ghost');
    expect(stage).toContain('onPointerLeave={() => setGhostPoint(null)}');
    expect(studioCss).toMatch(/\.comic-editor-figure\.is-placing\s*\{[^}]*cursor: crosshair/s);
    expect(studioCss).toMatch(/\.comic-bubble-ghost\s*\{[^}]*pointer-events: none/s);
  });

  test('Esc 取消放置（keydown 监听）', () => {
    expect(stage).toContain("if (event.key === 'Escape')");
    expect(stage).toContain('setPlacement(null)');
  });

  test('画布主区排序入口 = comicPanelsByOrder（order 唯一事实）', () => {
    expect(stage).toContain('comicPanelsByOrder(project)');
  });

  test('画布 aspect 与导出槽位同源（R7：编辑器与成品同一 cover 裁切语义）', () => {
    expect(stage).toContain('computePageLayouts(project)');
    expect(stage).toContain('slot.width / slot.height');
  });

  test('气泡渲染接线共享引擎：panel = figure 内容盒（ResizeObserver 跟踪）', () => {
    expect(stage).toContain('panel={figureSize}');
    expect(stage).toContain('ResizeObserver');
  });
});

describe('§4/§5/§98 拖动与缩放（Pointer Events）', () => {
  test('拖动 / 缩放会话走 window pointermove / pointerup / pointercancel', () => {
    expect(stage).toContain("window.addEventListener('pointermove', handleMove)");
    expect(stage).toContain("window.addEventListener('pointerup', finish)");
    expect(stage).toContain("window.addEventListener('pointercancel', finish)");
  });

  test('拖动 / 缩放落点统一钳制（move → clampDialoguePosition；resize → clampDialogueSize）', () => {
    expect(stage).toContain('clampDialoguePosition({');
    expect(stage).toContain('clampDialogueSize({');
  });

  test('CSS：气泡可拖（cursor grab）且拖动不滚页（touch-action none）', () => {
    expect(studioCss).toMatch(/\.comic-bubble-box\s*\{[^}]*touch-action: none/s);
    expect(studioCss).toMatch(/\.comic-bubble-box\s*\{[^}]*cursor: grab/s);
    expect(studioCss).toMatch(/\.comic-bubble-box\.is-selected\s*\{/);
    // 四角手柄 + 各自方向的 resize cursor
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      expect(studioCss).toContain(`.comic-bubble-handle-${corner}`);
    }
  });

  test('双击气泡 → 聚焦文字输入（画布→Inspector 联动）', () => {
    expect(stage).toContain('onDoubleClick');
    expect(stage).toContain('dlg-text-');
  });
});

describe('§15/§16/§99 气泡视觉选择器（Bubble Library V2 十六类四分组）', () => {
  test('Picker = 十六类真实迷你预览卡，四分组分区渲染（ComicBubbleBox inline 复用共享引擎）', () => {
    expect(picker).toContain('comicBubbleStylesByGroup(group)');
    expect(picker).toContain('role="radiogroup"');
    expect(picker).toContain('frame="inline"');
    expect(picker.match(/role="radio"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(picker).toContain("GROUP_ORDER: ComicBubbleStyleGroup[] = ['dialogue', 'emotion', 'narration', 'frameless']");
    expect(picker).toContain('panel={PREVIEW_PANEL}');
  });

  test('选卡切换 → onChange 直达 upsert（受控 value，画布立即重画，无本地缓存）', () => {
    expect(picker).toContain('const selected = selectedId === meta.id;');
    expect(picker).toContain('onClick={() => props.onChange(meta.id)}');
    expect(stage).toContain('<BubbleStylePicker');
    expect(stage).toContain('bubbleStyle => handleDialogueField(selectedDialogue, { bubbleStyle })');
  });

  test('尾巴方向 select：无尾样式禁用 + 一句能力说明', () => {
    expect(stage).toContain('尾巴方向');
    expect(stage).toContain('disabled={!styleHasTailNow}');
    expect(stage).toContain('旁白框 / 爆芒 / 无框文字没有尾巴');
    expect(stage).toContain('styleHasTailNow');
  });
});

describe('§100 Inspector 字段与顺序', () => {
  test('字段顺序：文字 → 说话人 → 类型 → 气泡样式 → 尾巴 → 字体 → 字号 → 字重 → 对齐 → 精确位置与层级（高级）→ 删除', () => {
    const labels = ['>文字</label>', '>说话人</label>', '>类型</label>', '气泡样式', '尾巴方向', '>字体</label>', '>字号 ', '>字重</label>', '>对齐</label>', '精确位置与层级（高级）', '删除对白'];
    let cursor = 0;
    for (const label of labels) {
      const index = stage.indexOf(label, cursor);
      expect(index, `「${label}」应按序出现在 ${cursor} 之后`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  test('水平 / 垂直位置滑杆降级进「精确位置与层级（高级）」折叠组（不再是主面板）', () => {
    expect(stage).toContain('<details className="comic-advanced-group">');
    expect(stage).toContain('水平位置');
    expect(stage).toContain('垂直位置');
    // 折叠组内还有恢复内容自适应（清掉手动尺寸）
    expect(stage).toContain('恢复内容自适应尺寸');
  });

  test('说话人未知值回退：补一项「（不在本格）」，Select 永不空白', () => {
    expect(stage).toContain('（不在本格）');
    expect(stage).toContain("name || '未知角色'");
  });

  test('字体 = 共享 FontSelect（选中值直通 fontStyle.family）', () => {
    expect(stage).toContain("import FontSelect from '../../../components/FontSelect'");
    expect(stage).toContain('value={selectedDialogue.fontStyle.family}');
  });

  test('对白 chips：本格列表（类型 + 序号），tablist 语义', () => {
    expect(stage).toContain('comic-dialogue-chips');
    expect(stage).toContain('DIALOGUE_TYPE_LABELS[dialogue.type]');
    expect(stage).toContain('role="tablist"');
  });

  test('对白来源徽标：AI 规划 / 视觉排版（placementSource 可见性）', () => {
    expect(stage).toContain("selectedDialogue.placementSource === 'planner'");
    expect(stage).toContain("selectedDialogue.placementSource === 'vision'");
  });
});

describe('§10/§101 删除可撤销（toast undo）', () => {
  test('删除走 onDialogueRemove + toast 带「撤销删除」动作（不做大而全 undo 栈）', () => {
    expect(stage).toContain('props.onDialogueRemove(dialogue.id)');
    expect(stage).toContain("label: '撤销删除'");
    expect(stage).toContain('onClick: () => props.onDialogueChange(dialogue)');
    expect(stage).toContain('已删除对白（只改文字层，不会重新生成图片）');
  });
});

describe('§67/§79 层级与分镜顺序边界（Text Stage 专注文字）', () => {
  test('分镜上移/下移已移除：Text Stage 不再触碰分镜顺序（归 Storyboard 阶段）', () => {
    expect(stage.includes('onPanelMove')).toBe(false);
    expect(stage).toContain('分镜顺序在「分镜」阶段调整；本阶段只编辑文字');
  });

  test('同格文字 z 序：前移（置顶）/ 后移（置底）走 onDialogueMoveZ', () => {
    expect(stage).toContain("props.onDialogueMoveZ(selectedDialogue.id, 'front')");
    expect(stage).toContain("props.onDialogueMoveZ(selectedDialogue.id, 'back')");
    expect(stage).toContain('文字前移（置顶）');
    expect(stage).toContain('文字后移（置底）');
  });
});

describe('§75/§76 零图片 API（硬约束）', () => {
  test('文字层组件不存在任何生图入口 / 图片 API 直呼', () => {
    for (const forbidden of [
      'comicTask', 'buildAnchorTask', 'buildPanelSeriesTask', 'buildPanelRegenTask',
      'createSeriesTask', 'authorizeImage2', 'requestQuote', 'api.',
    ]) {
      expect(stage.includes(forbidden), `ComicTextStage 不得出现 ${forbidden}`).toBe(false);
    }
    expect(stage).toContain('零图片 API 调用');
    expect(stage).toContain('所有文字编辑只改文字层，不会重新生成图片');
  });

  test('气泡共享渲染组件零副作用（纯几何消费，无 API / 无状态）', () => {
    for (const forbidden of ['api.', 'fetch(', 'createSeriesTask', 'useState']) {
      expect(bubbleBox.includes(forbidden), `ComicBubbleBox 不得出现 ${forbidden}`).toBe(false);
    }
    expect(bubbleBox).toContain('bubbleGeometry(dialogue.bubbleStyle, BUBBLE_CANVAS, BUBBLE_CANVAS, layout.tail)');
    // WYSIWYG 契约：DOM 只做绘制 backend，布局 = 共享引擎
    expect(bubbleBox).toContain('calculateDialogueLayout(dialogue, panel, measure)');
  });
});

describe('AI 生成对白弹窗链路（V4.2.13 残留修复）', () => {
  test('runPlanner / runVision 全链 try/catch：意外异常落 failed 态，绝不卡死 resolving', () => {
    // 此前调用方以 void runPlanner(...) 触发，链路异常会让状态停在 resolving 且
    // busy 阻止关闭弹窗——真实 GUI 表现即「点击 AI 生成对白后不可用」。
    expect(directorDialog).toContain('} catch (error) {');
    expect(directorDialog).toContain('对白规划运行异常，请重试。');
    expect(directorDialog).toContain('视觉排版运行异常，请重试。');
  });

  test('fill 模式目标可见性提示：0 格待补时明示换模式（与前置守卫同语义）', () => {
    expect(directorDialog).toContain('blankPanelCount === 0');
    expect(directorDialog).toContain('所有格都已有对白——请换「重新生成本格」或「重新生成整页」');
    expect(directorDialog).toContain('只给还没有文字的格写对白（还有 {blankPanelCount} 格）');
  });
});
