/**
 * RegionCanvasEditor（§9 / §28）—— 内嵌区域编辑画布（全宽工作模式，非 Modal）。
 *
 *  - 工具：框选（矩形拖拽）/ 画笔（涂抹）/ 橡皮（擦除当前草稿笔触）/ 清除 / 缩放（适应窗口 · 100%）；
 *  - 所有坐标立即归一化（0..1）落 RegionShape；绝不存 CSS pixel；
 *  - 草稿（进行中的框选 / 笔触）是组件局部视图状态；「保存区域」才经 onCommit
 *    语义上抛（页面 → 项目 store，revision +1）；
 *  - 保存时同步栅格化该区域自己的 mask PNG（onPersistMask 回调）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../services/api';
import { paintRegionOverlay } from './regionMask';
import { normalizeShape } from '../project/region';
import type { BrushStroke, RegionShape } from '../project/types';

type Tool = 'rect' | 'brush' | 'eraser';

interface RegionCanvasEditorProps {
  imagePath: string;
  disabled?: boolean;
  onCommit: (shape: RegionShape) => void;
  onBack: () => void;
}

const DEFAULT_BRUSH_RADIUS = 0.04;

export default function RegionCanvasEditor({ imagePath, disabled, onCommit, onBack }: RegionCanvasEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [fit, setFit] = useState(true);
  const [imageUrl, setImageUrl] = useState('');
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [rectDraft, setRectDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [strokes, setStrokes] = useState<BrushStroke[]>([]);
  const [brushRadius, setBrushRadius] = useState(DEFAULT_BRUSH_RADIUS);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const url = await api.readImageData(imagePath);
        if (!cancelled) setImageUrl(url);
      } catch { /* 读图失败由空画布兜底 */ }
    })();
    return () => { cancelled = true; };
  }, [imagePath]);

  const toNormalized = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }, []);

  // 画布重绘：底图 + 草稿 overlay（紫色半透明）
  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = imgRef.current;
    if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const draftShape = draftToShape();
    if (draftShape) {
      paintRegionOverlay(ctx, { id: 'draft', name: '草稿', shape: draftShape, replaceType: 'custom', constraintStrength: 'balanced', enabled: true, createdAt: '' }, canvas.width, canvas.height);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rectDraft, strokes]);

  function draftToShape(): RegionShape | null {
    if (rectDraft) {
      const x = Math.min(rectDraft.x0, rectDraft.x1);
      const y = Math.min(rectDraft.y0, rectDraft.y1);
      const w = Math.abs(rectDraft.x1 - rectDraft.x0);
      const h = Math.abs(rectDraft.y1 - rectDraft.y0);
      if (w <= 0.001 || h <= 0.001) return null;
      return normalizeShape({ kind: 'rect', x, y, w, h });
    }
    if (strokes.length > 0) {
      return normalizeShape({
        kind: 'brush',
        strokes,
        naturalWidth: naturalSize?.w ?? 1024,
        naturalHeight: naturalSize?.h ?? 1024,
      });
    }
    return null;
  }

  useEffect(() => {
    repaint();
  }, [repaint, fit, imageUrl]);

  // 画布像素尺寸 = 底图 natural 尺寸（显示尺寸由 CSS 控制；坐标已按显示矩形归一化）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !naturalSize) return;
    canvas.width = naturalSize.w;
    canvas.height = naturalSize.h;
    repaint();
  }, [naturalSize, repaint]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toNormalized(event);
    if (tool === 'rect') {
      setRectDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
    } else {
      setStrokes(prev => [...prev, { points: [point], radius: brushRadius }]);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const pressing = event.buttons === 1;
    if (!pressing) return;
    const point = toNormalized(event);
    if (tool === 'rect' && rectDraft) {
      setRectDraft({ ...rectDraft, x1: point.x, y1: point.y });
    } else if (tool === 'brush') {
      setStrokes(prev => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        return [...prev.slice(0, -1), { ...last, points: [...last.points, point] }];
      });
    } else if (tool === 'eraser') {
      setStrokes(prev => prev.filter(stroke => !stroke.points.some(p => Math.hypot(p.x - point.x, p.y - point.y) < brushRadius)));
    }
  };

  const clearDraft = () => {
    setRectDraft(null);
    setStrokes([]);
  };

  const commitDraft = () => {
    const shape = draftToShape();
    if (!shape) return;
    onCommit(shape);
    clearDraft();
  };

  const hasDraft = !!draftToShape();

  return (
    <div className="vision-region-editor" data-testid="region-canvas-editor">
      <div className="vision-region-toolbar">
        <button type="button" className="vision-btn vision-btn-sm" onClick={onBack}>← 返回</button>
        <span className="vision-region-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          className={`vision-btn vision-btn-sm ${tool === 'rect' ? 'is-active' : ''}`}
          aria-pressed={tool === 'rect'}
          disabled={disabled}
          onClick={() => { setTool('rect'); clearDraft(); }}
        >框选</button>
        <button
          type="button"
          className={`vision-btn vision-btn-sm ${tool === 'brush' ? 'is-active' : ''}`}
          aria-pressed={tool === 'brush'}
          disabled={disabled}
          onClick={() => { setTool('brush'); setRectDraft(null); }}
        >画笔</button>
        <button
          type="button"
          className={`vision-btn vision-btn-sm ${tool === 'eraser' ? 'is-active' : ''}`}
          aria-pressed={tool === 'eraser'}
          disabled={disabled}
          onClick={() => { setTool('eraser'); setRectDraft(null); }}
        >橡皮</button>
        <button type="button" className="vision-btn vision-btn-sm" disabled={disabled} onClick={clearDraft}>清除</button>
        {tool !== 'rect' && (
          <label className="vision-region-brush-size">
            笔刷
            <input
              type="range"
              min={0.01}
              max={0.15}
              step={0.005}
              value={brushRadius}
              disabled={disabled}
              onChange={e => setBrushRadius(Number(e.target.value))}
            />
          </label>
        )}
        <span className="vision-region-toolbar-spacer" />
        <button
          type="button"
          className={`vision-btn vision-btn-sm ${fit ? 'is-active' : ''}`}
          onClick={() => setFit(value => !value)}
        >{fit ? '适应窗口' : '缩放 100%'}</button>
        <button
          type="button"
          className="vision-btn vision-btn-sm vision-btn-primary"
          disabled={disabled || !hasDraft}
          onClick={commitDraft}
        >保存区域</button>
      </div>
      <div className={`vision-region-canvas-wrap ${fit ? 'is-fit' : 'is-full'}`}>
        <canvas
          ref={canvasRef}
          className="vision-region-canvas"
          data-testid="region-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
        />
        {/* 底图加载：canvas 绘制源（natural 尺寸决定画布像素） */}
        {imageUrl && (
          <img
            src={imageUrl}
            alt=""
            className="vision-region-source-img"
            ref={node => {
              imgRef.current = node;
              if (node && !naturalSize) {
                const record = () => setNaturalSize({ w: node.naturalWidth, h: node.naturalHeight });
                if (node.complete) record();
                else node.onload = record;
              }
            }}
            onLoad={() => {
              const node = imgRef.current;
              if (node) setNaturalSize({ w: node.naturalWidth, h: node.naturalHeight });
            }}
          />
        )}
      </div>
      <p className="vision-hint">
        框选 / 画笔创建的区域会在生成时同时输出为空间指令与 API mask（透明 = 允许编辑的区域）；
        所有坐标按 0..1 归一化保存，换分辨率不失效。
      </p>
    </div>
  );
}
