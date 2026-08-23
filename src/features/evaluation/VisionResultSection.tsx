/**
 * 视觉理解页「生成结果」区（V4.1 UX 收口）：
 *  - 通过 source_task_id 关联本视觉任务的最新生成任务；
 *  - ResultGallery：原图（Before）+ 生成图缩略图（选中描边 / 评分徽章 / 收藏 Heart /
 *    hover 快捷操作：查看 + 收藏）；页面内不放重复大图，查看大图统一进全局 ImageViewer；
 *  - AI 评价面板跟随当前选中缩略图（点击缩略图即选中并进入查看器）；
 *  - 「继续调整」把上一轮评价 + 用户反馈组装进修改意图（反馈闭环唯一入口），
 *    只填充不自动触发优化（用户确认后手动执行）。
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastInfo, toastSuccess } from '../../components/Toast';
import { useTaskStore } from '../../store/useTaskStore';
import { useEvaluationStore } from '../../store/useEvaluationStore';
import { useImageViewerStore, type ImageViewerItem } from '../../store/useImageViewerStore';
import { composeFeedbackInstruction } from './evaluationModel';
import EvaluationBadge from './EvaluationBadge';
import EvaluationPanel from './EvaluationPanel';
import type { ImageEvaluation } from './types';
import type { Task } from '../../types';
import './VisionResultSection.css';

interface VisionResultSectionProps {
  /** 本工作区视觉理解任务 id（生成任务 source_task_id 指向它）。 */
  visionTaskId: string;
  /** 参考原图路径（Before 展示 + 继续调整时兜底）。 */
  sourcePath: string;
  /** 继续调整：把组装好的指令写回修改意图输入框。 */
  onContinueAdjust: (instruction: string) => void;
}

interface GeneratedItem {
  assetId: string;
  path: string;
}

const FAVORITE_TOAST = {
  added: '已收藏该图片',
  removed: '已取消收藏',
  failed: '收藏操作失败，请重试',
} as const;

export default function VisionResultSection({
  visionTaskId,
  sourcePath,
  onContinueAdjust,
}: VisionResultSectionProps) {
  const tasks = useTaskStore(s => s.tasks);
  const refreshTask = useTaskStore(s => s.refreshTask);
  const evaluations = useEvaluationStore(s => s.evaluations);
  const setFavorite = useEvaluationStore(s => s.setFavorite);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [sourceThumb, setSourceThumb] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');

  const resultTask = useMemo<Task | null>(() => {
    const candidates = tasks
      .filter(t => t.source_task_id === visionTaskId && (t.task_type === 'generate' || t.task_type === 'edit'))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return candidates[0] ?? null;
  }, [tasks, visionTaskId]);

  const generated = useMemo<GeneratedItem[]>(() => {
    if (!resultTask) return [];
    // sub_tasks.image_id → 图片路径：从任务 output_dir 无从反查文件名，直接用图库索引
    return resultTask.sub_tasks
      .filter(sub => sub.status === 'completed' && sub.image_id)
      .map(sub => ({ assetId: sub.image_id!, path: '' }));
  }, [resultTask]);

  // 补齐图片路径（图库索引一次拉取；评价 store 已在 App 级加载）
  useEffect(() => {
    let cancelled = false;
    if (generated.length === 0) return;
    void (async () => {
      try {
        const images = await api.getImages();
        if (cancelled) return;
        const byId = new Map(images.map(img => [img.id, img]));
        const nextThumbs: Record<string, string> = {};
        for (const item of generated) {
          const record = byId.get(item.assetId);
          if (record?.local_path) {
            item.path = record.local_path;
            try {
              nextThumbs[item.assetId] = await api.readThumbnail(record.local_path);
            } catch { /* 单图失败跳过 */ }
          }
        }
        setThumbs(nextThumbs);
      } catch { /* 图库不可用不阻塞结果区 */ }
    })();
    return () => { cancelled = true; };
  }, [generated]);

  useEffect(() => {
    let cancelled = false;
    if (!sourcePath) {
      setSourceThumb('');
      return;
    }
    void api.readThumbnail(sourcePath)
      .then(url => { if (!cancelled) setSourceThumb(url); })
      .catch(() => { if (!cancelled) setSourceThumb(''); });
    return () => { cancelled = true; };
  }, [sourcePath]);

  // 任务进行中：轮询刷新（与任务事件桥互补，保证回到本页也能推进终态）
  useEffect(() => {
    if (!resultTask) return;
    if (resultTask.status !== 'pending' && resultTask.status !== 'running') return;
    const timer = setInterval(() => { void refreshTask(resultTask.id); }, 2500);
    return () => clearInterval(timer);
  }, [resultTask, refreshTask]);

  // 默认选中第一张（或保持当前选择）
  useEffect(() => {
    if (generated.length === 0) {
      setSelectedAssetId('');
      return;
    }
    if (!generated.some(item => item.assetId === selectedAssetId)) {
      setSelectedAssetId(generated[0].assetId);
    }
  }, [generated, selectedAssetId]);

  if (!resultTask) return null;

  const isRunning = resultTask.status === 'pending' || resultTask.status === 'running';
  const bestEval = generated
    .map(item => evaluations[item.assetId])
    .filter(Boolean)
    .sort((a, b) => (b!.overall_score ?? -1) - (a!.overall_score ?? -1))[0];

  /** 本张图片实际使用的 Prompt（任务提交快照；批量方案取该槽位 override）。 */
  const submittedPromptOf = (assetId: string): string => {
    const subIndex = resultTask.sub_tasks.findIndex(sub => sub.image_id === assetId);
    const batchItem = subIndex >= 0 ? resultTask.batch_items?.[subIndex] : undefined;
    return batchItem?.prompt_override?.trim() || resultTask.final_prompt || resultTask.prompt || '';
  };

  /** 全部图片的查看器条目（多图切换；原图在首位）。 */
  const viewerItems = (): ImageViewerItem[] => {
    const items: ImageViewerItem[] = [];
    if (sourcePath) {
      items.push({
        id: `source-${sourcePath}`,
        path: sourcePath,
        title: '参考原图',
        fileName: sourcePath.split(/[\\/]/).pop(),
        metadata: [{ label: '用途', value: '视觉理解参考图' }],
      });
    }
    for (const item of generated) {
      if (!item.path) continue;
      const evaluation = evaluations[item.assetId];
      items.push({
        id: item.assetId,
        path: item.path,
        title: `生成结果 ${items.length}`,
        fileName: item.path.split(/[\\/]/).pop(),
        prompt: submittedPromptOf(item.assetId) || undefined,
        metadata: [
          ...(evaluation?.overall_score != null
            ? [{ label: '复刻完成度', value: String(evaluation.overall_score) }]
            : []),
          ...(evaluation?.user_rating === 'liked' ? [{ label: '用户反馈', value: '满意' }] : []),
          ...(evaluation?.user_rating === 'disliked' ? [{ label: '用户反馈', value: '需要调整' }] : []),
        ],
      });
    }
    return items;
  };

  const openViewerAt = (assetId: string) => {
    const items = viewerItems();
    const index = Math.max(0, items.findIndex(entry => entry.id === assetId));
    useImageViewerStore.getState().openViewer(items, index);
  };

  const toggleFavorite = async (item: GeneratedItem, evaluation: ImageEvaluation | undefined) => {
    if (!item.path) return;
    try {
      await setFavorite(item.assetId, item.path, !evaluation?.favorite);
      toastSuccess(!evaluation?.favorite ? FAVORITE_TOAST.added : FAVORITE_TOAST.removed);
    } catch {
      toastError(FAVORITE_TOAST.failed);
    }
  };

  const handleContinue = (evaluation: ImageEvaluation) => {
    const instruction = composeFeedbackInstruction(evaluation);
    if (instruction) {
      onContinueAdjust(instruction);
      toastInfo('已填入修改意图，可再补充后点击「优化复刻 Prompt」。', '继续调整');
    } else {
      onContinueAdjust('基于上一轮结果继续调整：');
      toastInfo('已填入修改意图，可再补充后点击「优化复刻 Prompt」。', '继续调整');
    }
  };

  const selectedItem = generated.find(item => item.assetId === selectedAssetId) ?? null;

  return (
    <section className="vision-card vision-result">
      <div className="vision-result-head">
        <h3>生成结果</h3>
        <span className="vision-result-task">#{resultTask.id.slice(0, 8)}</span>
        {isRunning && <span className="vision-result-running">生成中…</span>}
        {!isRunning && resultTask.status === 'failed' && (
          <span className="vision-result-failed">任务失败（可在任务队列重试）</span>
        )}
        {!isRunning && bestEval?.overall_score != null && (
          <span className="vision-result-best">最高 {bestEval.overall_score}</span>
        )}
      </div>

      {/* ResultGallery：原图 + 生成图缩略图（选中描边 / 评分徽章 / 收藏 / hover 快捷操作） */}
      <div className="vision-result-compare">
        {sourceThumb && (
          <div className="vision-result-before" title="点击在内置图片查看器中查看原图">
            <img
              src={sourceThumb}
              alt="参考原图"
              onClick={() => {
                const items = viewerItems();
                useImageViewerStore.getState().openViewer(items, 0);
              }}
            />
            <span className="vision-result-tag">原图</span>
          </div>
        )}
        <div className="vision-result-grid">
          {generated.map(item => {
            const evaluation = evaluations[item.assetId];
            return (
              <div
                key={item.assetId}
                role="button"
                tabIndex={0}
                className={`vision-result-item ${selectedAssetId === item.assetId ? 'is-selected' : ''}`}
                onClick={() => { setSelectedAssetId(item.assetId); openViewerAt(item.assetId); }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedAssetId(item.assetId);
                    openViewerAt(item.assetId);
                  }
                }}
                title="选中并在内置图片查看器中查看大图"
              >
                {thumbs[item.assetId]
                  ? <img src={thumbs[item.assetId]} alt="生成结果" />
                  : <span className="vision-result-loading">加载中</span>}
                <EvaluationBadge evaluation={evaluation} />
                {evaluation?.favorite && <span className="vision-result-favorite" aria-label="已收藏">♥</span>}
                <div className="vision-result-quick">
                  <button
                    type="button"
                    title="在内置图片查看器中查看"
                    disabled={!item.path}
                    onClick={e => { e.stopPropagation(); openViewerAt(item.assetId); }}
                  >
                    查看
                  </button>
                  <button
                    type="button"
                    className={`${evaluation?.favorite ? 'is-favorited' : ''}`}
                    title={evaluation?.favorite ? '取消收藏' : '收藏'}
                    disabled={!item.path}
                    onClick={e => { e.stopPropagation(); void toggleFavorite(item, evaluation); }}
                  >
                    {evaluation?.favorite ? '♥ 已收藏' : '♡ 收藏'}
                  </button>
                </div>
              </div>
            );
          })}
          {generated.length === 0 && !isRunning && (
            <p className="vision-result-empty">本轮没有成功的生成图片</p>
          )}
          {generated.length === 0 && isRunning && (
            <p className="vision-result-empty">正在生成，完成后自动评价</p>
          )}
        </div>
      </div>

      {/* AI 评价：跟随当前选中缩略图（页面内无重复大图，查看大图进全局 ImageViewer） */}
      {selectedItem && (
        <div className="vision-result-eval">
          <EvaluationPanel
            assetId={selectedItem.assetId}
            task={resultTask}
            overallLabel="复刻完成度"
            onContinueAdjust={handleContinue}
          />
        </div>
      )}
    </section>
  );
}
