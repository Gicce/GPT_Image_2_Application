/**
 * 文字精修阶段（V4.2.12 建立 / V4.2.14 WYSIWYG + 对白导演）——「画布直接编辑为主，
 * Inspector 为辅」：
 *  - 左：分镜缩略图（order 序 = 排版唯一事实，comicPanelsByOrder；V4.2.14 §67
 *    移除上移/下移——分镜顺序属于 Storyboard 阶段，Text Stage 专注文字）；
 *  - 中：画布（放置模式 + Ghost 预览 + 点击放置 / 拖动 / 四角 Resize / 点选对白）；
 *    画布 aspect 与导出槽位同源（computePageLayouts，R7 修复：编辑器与成品同一
 *    裁切语义）；气泡渲染 = 共享布局引擎（docs/ai-comic/28）；
 *  - 右：对白 Inspector（文字→说话人→气泡样式（V2 十六类视觉卡）→尾巴→字体→
 *    字号→字重→对齐→精确位置（高级）→层级→删除）。
 *
 * 铁律（验收 I / §75-76）：本组件所有对白编辑只走 onDialogueChange /
 * onDialogueRemove / onDialogueMoveZ（页面层映射 upsertDialogue / removeDialogue /
 * moveDialogueZ，纯 dialogues 数组操作），结构上零图片 API 调用。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useComicPanelThumbs } from './useComicThumbs';
import {
  DIALOGUE_TAIL_LABELS,
  DIALOGUE_TYPE_LABELS,
  clampDialoguePosition,
  clampDialogueSize,
  dialogueSpeakerOptions,
  newDialogueDraft,
  pointerToNormalized,
} from '../textLayer';
import { comicPanelsByOrder } from '../domain';
import { computePageLayouts } from '../comicExport';
import { comicBubbleStyleMeta, styleHasTail } from '../bubbleShape';
import type { ComicDialogue, ComicProject } from '../types';
import ComicBubbleBox, { type BubbleResizeCorner } from './ComicBubbleBox';
import BubbleStylePicker from './BubbleStylePicker';
import FontSelect from '../../../components/FontSelect';
import { toastSuccess } from '../../../components/Toast';

export interface ComicTextStageProps {
  project: ComicProject;
  /** 对白保存（页面层唯一写入口：updateActive(draft => upsertDialogue(draft, next))）。 */
  onDialogueChange: (dialogue: ComicDialogue) => void;
  onDialogueRemove: (dialogueId: string) => void;
  /** V4.2.14 §79：同格 z 序调整（前移 / 后移）。 */
  onDialogueMoveZ: (dialogueId: string, direction: 'front' | 'back') => void;
  /** V4.2.14 §31：AI 生成对白（对白导演 Modal，页面层承载）。 */
  onOpenAiDirector: () => void;
  onExport: () => void;
  exporting: boolean;
}

type PlacementKind = 'speech' | 'caption' | 'free';

interface DragSession {
  kind: 'move' | 'resize';
  dialogueId: string;
  startClientX: number;
  startClientY: number;
  originPosition: { x: number; y: number };
  originSize?: { width: number; height: number };
  corner?: BubbleResizeCorner;
}

const PLACEMENT_LABELS: Record<PlacementKind, string> = {
  speech: '对白',
  caption: '旁白',
  free: '文字',
};

/** jsdom / 首帧回落：与四格 1:1 导出槽位（504×504）同尺寸的默认画布。 */
const DEFAULT_FIGURE_SIZE = { width: 504, height: 504 };

export default function ComicTextStage(props: ComicTextStageProps) {
  const { project } = props;
  const panels = useMemo(() => comicPanelsByOrder(project), [project]);
  const thumbs = useComicPanelThumbs(panels);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(panels[0]?.id ?? null);
  const [selectedDialogueId, setSelectedDialogueId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<PlacementKind | null>(null);
  const [dragSession, setDragSession] = useState<DragSession | null>(null);
  const [ghostPoint, setGhostPoint] = useState<{ x: number; y: number } | null>(null);
  const [figureSize, setFigureSize] = useState(DEFAULT_FIGURE_SIZE);
  const figureRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedPanelId && panels.length > 0) setSelectedPanelId(panels[0]!.id);
  }, [panels, selectedPanelId]);

  const selectedPanel = panels.find(panel => panel.id === selectedPanelId) ?? null;
  const speakerOptions = selectedPanel ? dialogueSpeakerOptions(project, selectedPanel) : [];
  const panelDialogues = useMemo(
    () => (selectedPanel ? project.dialogues.filter(dialogue => dialogue.panelId === selectedPanel.id) : []),
    [project.dialogues, selectedPanel],
  );
  const selectedDialogue = panelDialogues.find(dialogue => dialogue.id === selectedDialogueId)
    ?? panelDialogues[0]
    ?? null;

  // 切格后清掉跨格的选中对白（选中态是视图状态，不落库）
  useEffect(() => {
    if (selectedDialogue && selectedPanel && selectedDialogue.panelId !== selectedPanel.id) {
      setSelectedDialogueId(null);
    }
  }, [selectedDialogue, selectedPanel]);

  // 画布逻辑尺寸（Panel Content Rect；引擎换算 + Ghost 定位共用；ResizeObserver 跟踪）
  useEffect(() => {
    const element = figureRef.current;
    if (!element) return undefined;
    const update = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width > 0 && height > 0) setFigureSize({ width, height });
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selectedPanelId]);

  // 画布 aspect 与导出槽位同源（V4.2.13 双问题修复：fit-safe 入槽几何——资产与
  // 槽位比例错配时底图完整保留、槽内留白 = 页背景；编辑器与成品同一语义）
  const figureAspect = useMemo(() => {
    for (const layout of computePageLayouts(project)) {
      const slot = layout.slots.find(item => item.panelId === selectedPanelId);
      if (slot) return slot.width / slot.height;
    }
    return 1;
  }, [project, selectedPanelId]);
  // contain 留白带与导出页背景同色（导出侧 = drawSheet 的 layout.background）
  const figureBackground = project.skillSnapshot.exportDefaults.background || '#ffffff';

  const toNormalized = useCallback(
    (clientX: number, clientY: number) => {
      const rect = figureRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0.5, y: 0.5 };
      return pointerToNormalized(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        clientX,
        clientY,
      );
    },
    [],
  );

  // —— 画布放置（§15~§20：点工具栏 → Ghost 跟随 → 点画布落位；Esc 取消）——
  const placeDialogue = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectedPanel || !placement) return;
    const point = clampDialoguePosition(toNormalized(event.clientX, event.clientY));
    const draft = newDialogueDraft(project, selectedPanel.id, panelDialogues.length);
    const next: ComicDialogue =
      placement === 'caption'
        ? { ...draft, type: 'caption', bubbleStyle: 'box-light', speakerId: 'narrator', position: point }
        : placement === 'free'
          ? { ...draft, type: 'subtitle', bubbleStyle: 'plain', position: point }
          : { ...draft, position: point };
    props.onDialogueChange(next);
    setSelectedDialogueId(next.id);
    setPlacement(null);
    setGhostPoint(null);
    // P0-2：落位即聚焦检查器文字输入框（放置 → 自动选中 → 直接可打字）
    window.setTimeout(() => document.getElementById(`dlg-text-${next.id}`)?.focus(), 0);
  };

  // —— 拖动 / 缩放（Pointer Events；状态只存归一化值）——
  const beginMove = (dialogue: ComicDialogue, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setSelectedDialogueId(dialogue.id);
    setDragSession({
      kind: 'move',
      dialogueId: dialogue.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originPosition: dialogue.position,
    });
  };

  const beginResize = (dialogue: ComicDialogue, corner: BubbleResizeCorner, event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    const element = figureRef.current?.querySelector<HTMLDivElement>(`[data-dialogue-id="${dialogue.id}"]`);
    const figureRect = figureRef.current?.getBoundingClientRect();
    let originSize = dialogue.size;
    if (!originSize && element && figureRect && figureRect.width > 0 && figureRect.height > 0) {
      // 首次 Resize：把当前自适应渲染尺寸固化为归一化 size，再在其上调整
      originSize = clampDialogueSize({
        width: element.offsetWidth / figureRect.width,
        height: element.offsetHeight / figureRect.height,
      });
    }
    originSize = originSize ?? { width: 0.5, height: 0.2 };
    setSelectedDialogueId(dialogue.id);
    setDragSession({
      kind: 'resize',
      dialogueId: dialogue.id,
      corner,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originPosition: dialogue.position,
      originSize,
    });
  };

  useEffect(() => {
    if (!dragSession) return;
    const handleMove = (event: PointerEvent) => {
      const dialogue = project.dialogues.find(item => item.id === dragSession.dialogueId);
      if (!dialogue) return;
      const rect = figureRef.current?.getBoundingClientRect();
      const width = rect && rect.width > 0 ? rect.width : 1;
      const height = rect && rect.height > 0 ? rect.height : 1;
      if (dragSession.kind === 'move') {
        const next = clampDialoguePosition({
          x: dragSession.originPosition.x + (event.clientX - dragSession.startClientX) / width,
          y: dragSession.originPosition.y + (event.clientY - dragSession.startClientY) / height,
        });
        if (next.x !== dialogue.position.x || next.y !== dialogue.position.y) {
          props.onDialogueChange({ ...dialogue, position: next });
        }
      } else if (dragSession.kind === 'resize' && dragSession.originSize && dragSession.corner) {
        const deltaX = (event.clientX - dragSession.startClientX) / width;
        const deltaY = (event.clientY - dragSession.startClientY) / height;
        const signX = dragSession.corner === 'ne' || dragSession.corner === 'se' ? 1 : -1;
        const signY = dragSession.corner === 'sw' || dragSession.corner === 'se' ? 1 : -1;
        const next = clampDialogueSize({
          width: dragSession.originSize.width + deltaX * signX,
          height: dragSession.originSize.height + deltaY * signY,
        });
        props.onDialogueChange({ ...dialogue, size: next });
      }
    };
    const finish = () => setDragSession(null);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [dragSession, project.dialogues, props]);

  // Esc 取消放置模式
  useEffect(() => {
    if (!placement) return undefined;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPlacement(null);
        setGhostPoint(null);
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [placement]);

  // —— Inspector 编辑 handlers（只碰 dialogues 数组；验收 I：零生图）——
  const handleDialogueField = (dialogue: ComicDialogue, patch: Partial<ComicDialogue>) => {
    props.onDialogueChange({ ...dialogue, ...patch });
  };

  const handleRemove = (dialogue: ComicDialogue) => {
    props.onDialogueRemove(dialogue.id);
    if (selectedDialogueId === dialogue.id) setSelectedDialogueId(null);
    // §10：删除可撤销（600ms 防抖持久化之前都能一键恢复，不做大而全 undo 栈）
    toastSuccess('已删除对白（只改文字层，不会重新生成图片）', '文字层', {
      label: '撤销删除',
      onClick: () => props.onDialogueChange(dialogue),
    });
  };

  // 说话人回退（§36）：speakerId 不在本格候选里时补一项，Select 永不空白
  const speakerChoices = useMemo(() => {
    if (!selectedDialogue) return speakerOptions;
    if (selectedDialogue.speakerId === 'narrator') return speakerOptions;
    if (speakerOptions.some(option => option.id === selectedDialogue.speakerId)) return speakerOptions;
    const name = project.characterSnapshots.find(c => c.id === selectedDialogue.speakerId)?.name;
    return [...speakerOptions, { id: selectedDialogue.speakerId, label: `${name || '未知角色'}（不在本格）` }];
  }, [project.characterSnapshots, selectedDialogue, speakerOptions]);

  const styleHasTailNow = selectedDialogue ? styleHasTail(selectedDialogue.bubbleStyle) : false;

  // Ghost 预览（放置模式跟随鼠标的半透明真实气泡；与落位后的渲染同一引擎）
  const ghostDialogue = useMemo<ComicDialogue | null>(() => {
    if (!placement || !selectedPanel || !ghostPoint) return null;
    const draft = newDialogueDraft(project, selectedPanel.id, panelDialogues.length);
    if (placement === 'caption') return { ...draft, type: 'caption', bubbleStyle: 'box-light', speakerId: 'narrator', position: ghostPoint, text: PLACEMENT_LABELS[placement] };
    if (placement === 'free') return { ...draft, type: 'subtitle', bubbleStyle: 'plain', position: ghostPoint, text: PLACEMENT_LABELS[placement] };
    return { ...draft, position: ghostPoint, text: PLACEMENT_LABELS[placement] };
  }, [ghostPoint, panelDialogues.length, placement, project, selectedPanel]);

  return (
    <div className="comic-stage comic-text-stage">
      <div className="comic-text-panels">
        {panels.map(panel => (
          <div key={panel.id} className={`comic-text-thumb-wrap${panel.id === selectedPanelId ? ' is-selected' : ''}`}>
            <button
              type="button"
              className={`comic-text-thumb${panel.id === selectedPanelId ? ' is-selected' : ''}`}
              onClick={() => setSelectedPanelId(panel.id)}
            >
              {thumbs[panel.id]
                ? <img src={thumbs[panel.id]} alt={`第 ${panel.order + 1} 格`} />
                : <span className="comic-ref-placeholder">{panel.generationStatus === 'completed' ? '无图' : '未生成'}</span>}
              <span>第 {panel.order + 1} 格</span>
            </button>
          </div>
        ))}
        <p className="comic-text-thumb-note">分镜顺序在「分镜」阶段调整；本阶段只编辑文字</p>
      </div>

      {selectedPanel && (
        <>
          <div className="comic-editor-canvas">
            <div className="comic-text-toolbar">
              <button
                type="button"
                className={`app-btn app-btn-secondary app-btn-sm ${placement === 'speech' ? 'comic-placement-active' : ''}`.trim()}
                aria-pressed={placement === 'speech'}
                onClick={() => setPlacement(placement === 'speech' ? null : 'speech')}
              >
                添加对白
              </button>
              <button
                type="button"
                className={`app-btn app-btn-secondary app-btn-sm ${placement === 'caption' ? 'comic-placement-active' : ''}`.trim()}
                aria-pressed={placement === 'caption'}
                onClick={() => setPlacement(placement === 'caption' ? null : 'caption')}
              >
                添加旁白
              </button>
              <button
                type="button"
                className={`app-btn app-btn-secondary app-btn-sm ${placement === 'free' ? 'comic-placement-active' : ''}`.trim()}
                aria-pressed={placement === 'free'}
                onClick={() => setPlacement(placement === 'free' ? null : 'free')}
              >
                添加文字
              </button>
              <button
                type="button"
                className="app-btn app-btn-secondary app-btn-sm"
                onClick={() => props.onOpenAiDirector()}
              >
                AI 生成对白
              </button>
              <span className={`comic-placement-hint${placement ? ' is-active' : ''}`} data-testid="comic-placement-hint">
                {placement ? `正在放置${PLACEMENT_LABELS[placement]} · 点击漫画画面放置 · Esc 取消` : '点击气泡选中，拖动移动，四角调整大小'}
              </span>
              <button
                type="button"
                className="app-btn app-btn-primary app-btn-sm comic-text-export"
                disabled={props.exporting}
                onClick={() => void props.onExport()}
              >
                {props.exporting ? '导出中…' : '导出整页 PNG'}
              </button>
            </div>
            <div
              className={`comic-editor-figure${placement ? ' is-placing' : ''}${dragSession ? ' is-dragging' : ''}`}
              ref={figureRef}
              style={{ aspectRatio: `${figureAspect}`, background: figureBackground }}
              onPointerDown={event => {
                // V4.2.14 R4 修复：figure 内任意非气泡元素（图 / 占位框 / 画布本身）
                // 都可落位——不再要求 target === currentTarget（img 铺满画布时旧判定
                // 永不命中，「添加对白没反应」P0）。气泡自身的 pointerdown 已由
                // ComicBubbleBox 处理（选中 / 拖动），这里跳过。
                const target = event.target as HTMLElement;
                if (target.closest('.comic-bubble-box')) return;
                if (placement) {
                  placeDialogue(event);
                } else {
                  setSelectedDialogueId(null);
                }
              }}
              onPointerMove={event => {
                if (!placement) return;
                setGhostPoint(toNormalized(event.clientX, event.clientY));
              }}
              onPointerLeave={() => setGhostPoint(null)}
            >
              {thumbs[selectedPanel.id] ? (
                <img src={thumbs[selectedPanel.id]} alt={selectedPanel.scene} draggable={false} />
              ) : (
                <span className="comic-ref-placeholder">本格尚未生成图片</span>
              )}
              {panelDialogues.map(dialogue => (
                <ComicBubbleBox
                  key={dialogue.id}
                  dialogue={dialogue}
                  panel={figureSize}
                  mode="edit"
                  selected={selectedDialogue?.id === dialogue.id}
                  onBubblePointerDown={event => beginMove(dialogue, event)}
                  onResizePointerDown={(corner, event) => beginResize(dialogue, corner, event)}
                  onDoubleClick={() => {
                    setSelectedDialogueId(dialogue.id);
                    window.setTimeout(() => document.getElementById(`dlg-text-${dialogue.id}`)?.focus(), 0);
                  }}
                />
              ))}
              {ghostDialogue && (
                <ComicBubbleBox
                  dialogue={ghostDialogue}
                  panel={figureSize}
                  mode="static"
                  className="comic-bubble-ghost"
                />
              )}
            </div>
            <p className="comic-text-footnote">所有文字编辑只改文字层，不会重新生成图片</p>
          </div>

          <div className="comic-dialogue-editor">
            <header className="comic-dialogue-editor-head">
              <h4>第 {selectedPanel.order + 1} 格 · 文字层</h4>
            </header>

            {panelDialogues.length > 0 && (
              <div className="comic-dialogue-chips" role="tablist" aria-label="本格对白列表">
                {panelDialogues.map(dialogue => {
                  const sequence = panelDialogues.filter(item => item.type === dialogue.type).indexOf(dialogue) + 1;
                  return (
                    <button
                      key={dialogue.id}
                      type="button"
                      role="tab"
                      aria-selected={selectedDialogue?.id === dialogue.id}
                      className={`comic-dialogue-chip${selectedDialogue?.id === dialogue.id ? ' is-selected' : ''}`}
                      onClick={() => setSelectedDialogueId(dialogue.id)}
                    >
                      {DIALOGUE_TYPE_LABELS[dialogue.type]} {sequence}
                    </button>
                  );
                })}
              </div>
            )}

            {!selectedDialogue && (
              <p className="comic-empty-hint">
                本格还没有文字，点上方「添加对白 / 添加旁白 / 添加文字」后在画面上点击放置
              </p>
            )}

            {selectedDialogue && (
              <div className="comic-dialogue-item">
                <div className="form-group">
                  <label htmlFor={`dlg-text-${selectedDialogue.id}`}>文字</label>
                  <textarea
                    id={`dlg-text-${selectedDialogue.id}`}
                    rows={2}
                    value={selectedDialogue.text}
                    placeholder="对白内容（只改字，不会重新生成图片）"
                    onChange={e => handleDialogueField(selectedDialogue, { text: e.target.value })}
                  />
                </div>
                <div className="comic-dialogue-controls">
                  <div className="form-group">
                    <label htmlFor={`dlg-speaker-${selectedDialogue.id}`}>说话人</label>
                    <select
                      id={`dlg-speaker-${selectedDialogue.id}`}
                      value={selectedDialogue.speakerId}
                      onChange={e => handleDialogueField(selectedDialogue, { speakerId: e.target.value })}
                    >
                      {speakerChoices.map(option => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor={`dlg-type-${selectedDialogue.id}`}>类型</label>
                    <select
                      id={`dlg-type-${selectedDialogue.id}`}
                      value={selectedDialogue.type}
                      onChange={e => handleDialogueField(selectedDialogue, { type: e.target.value as ComicDialogue['type'] })}
                    >
                      {Object.entries(DIALOGUE_TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label id={`dlg-bubble-label-${selectedDialogue.id}`}>气泡样式</label>
                  <BubbleStylePicker
                    id={`dlg-bubble-${selectedDialogue.id}`}
                    value={selectedDialogue.bubbleStyle}
                    onChange={bubbleStyle => handleDialogueField(selectedDialogue, { bubbleStyle })}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor={`dlg-tail-${selectedDialogue.id}`}>尾巴方向</label>
                  <select
                    id={`dlg-tail-${selectedDialogue.id}`}
                    value={selectedDialogue.tail ?? 'auto'}
                    disabled={!styleHasTailNow}
                    onChange={e => handleDialogueField(selectedDialogue, {
                      tail: e.target.value as ComicDialogue['tail'],
                    })}
                  >
                    {Object.entries(DIALOGUE_TAIL_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  {!styleHasTailNow && <p className="comic-field-hint">旁白框 / 爆芒 / 无框文字没有尾巴</p>}
                </div>

                <div className="comic-dialogue-controls">
                  <div className="form-group">
                    <label htmlFor={`dlg-font-${selectedDialogue.id}`}>字体</label>
                    <FontSelect
                      id={`dlg-font-${selectedDialogue.id}`}
                      value={selectedDialogue.fontStyle.family}
                      onChange={family => handleDialogueField(selectedDialogue, {
                        fontStyle: { ...selectedDialogue.fontStyle, family },
                      })}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`dlg-size-${selectedDialogue.id}`}>字号 {selectedDialogue.fontStyle.size}</label>
                    <input
                      id={`dlg-size-${selectedDialogue.id}`}
                      type="range"
                      min={10}
                      max={40}
                      value={selectedDialogue.fontStyle.size}
                      onChange={e => handleDialogueField(selectedDialogue, { fontStyle: { ...selectedDialogue.fontStyle, size: Number(e.target.value) } })}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`dlg-weight-${selectedDialogue.id}`}>字重</label>
                    <select
                      id={`dlg-weight-${selectedDialogue.id}`}
                      value={selectedDialogue.fontStyle.weight}
                      onChange={e => handleDialogueField(selectedDialogue, { fontStyle: { ...selectedDialogue.fontStyle, weight: Number(e.target.value) as ComicDialogue['fontStyle']['weight'] } })}
                    >
                      {[400, 500, 600, 700].map(weight => <option key={weight} value={weight}>{weight}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor={`dlg-align-${selectedDialogue.id}`}>对齐</label>
                    <select
                      id={`dlg-align-${selectedDialogue.id}`}
                      value={selectedDialogue.alignment}
                      onChange={e => handleDialogueField(selectedDialogue, { alignment: e.target.value as ComicDialogue['alignment'] })}
                    >
                      <option value="left">左对齐</option>
                      <option value="center">居中</option>
                      <option value="right">右对齐</option>
                    </select>
                  </div>
                </div>

                <details className="comic-advanced-group">
                  <summary>精确位置与层级（高级）</summary>
                  <div className="form-group comic-slider-group">
                    <label htmlFor={`dlg-x-${selectedDialogue.id}`}>水平位置 {Math.round(selectedDialogue.position.x * 100)}%</label>
                    <input
                      id={`dlg-x-${selectedDialogue.id}`}
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(selectedDialogue.position.x * 100)}
                      onChange={e => handleDialogueField(selectedDialogue, { position: { ...selectedDialogue.position, x: Number(e.target.value) / 100 } })}
                    />
                  </div>
                  <div className="form-group comic-slider-group">
                    <label htmlFor={`dlg-y-${selectedDialogue.id}`}>垂直位置 {Math.round(selectedDialogue.position.y * 100)}%</label>
                    <input
                      id={`dlg-y-${selectedDialogue.id}`}
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(selectedDialogue.position.y * 100)}
                      onChange={e => handleDialogueField(selectedDialogue, { position: { ...selectedDialogue.position, y: Number(e.target.value) / 100 } })}
                    />
                  </div>
                  {selectedDialogue.size && (
                    <>
                      <div className="form-group comic-slider-group">
                        <label htmlFor={`dlg-w-${selectedDialogue.id}`}>宽度 {Math.round(selectedDialogue.size.width * 100)}%</label>
                        <input
                          id={`dlg-w-${selectedDialogue.id}`}
                          type="range"
                          min={14}
                          max={92}
                          value={Math.round(selectedDialogue.size.width * 100)}
                          onChange={e => handleDialogueField(selectedDialogue, { size: { ...selectedDialogue.size!, width: Number(e.target.value) / 100 } })}
                        />
                      </div>
                      <div className="form-group comic-slider-group">
                        <label htmlFor={`dlg-h-${selectedDialogue.id}`}>高度 {Math.round(selectedDialogue.size.height * 100)}%</label>
                        <input
                          id={`dlg-h-${selectedDialogue.id}`}
                          type="range"
                          min={14}
                          max={92}
                          value={Math.round(selectedDialogue.size.height * 100)}
                          onChange={e => handleDialogueField(selectedDialogue, { size: { ...selectedDialogue.size!, height: Number(e.target.value) / 100 } })}
                        />
                      </div>
                    </>
                  )}
                  <button
                    type="button"
                    className="app-btn app-btn-secondary app-btn-sm"
                    onClick={() => handleDialogueField(selectedDialogue, { size: undefined })}
                  >
                    {selectedDialogue.size ? '恢复内容自适应尺寸' : '当前为内容自适应尺寸'}
                  </button>
                  <div className="comic-actions-row">
                    <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => props.onDialogueMoveZ(selectedDialogue.id, 'front')}>
                      文字前移（置顶）
                    </button>
                    <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => props.onDialogueMoveZ(selectedDialogue.id, 'back')}>
                      文字后移（置底）
                    </button>
                  </div>
                </details>

                <div className="comic-actions-row">
                  <button type="button" className="app-btn app-btn-danger app-btn-sm" onClick={() => handleRemove(selectedDialogue)}>
                    删除对白
                  </button>
                  <span className="comic-field-hint">
                    {comicBubbleStyleMeta(selectedDialogue.bubbleStyle).label}
                    {selectedDialogue.placementSource === 'planner' ? ' · AI 规划' : ''}
                    {selectedDialogue.placementSource === 'vision' ? ' · 视觉排版' : ''}
                  </span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
