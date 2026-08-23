/**
 * VisualAnalysisProgress（V4.1）—— 视觉理解「正在分析」阶段的产品化反馈。
 *
 * 取代旧的「spinner + 正在分析参考图…」单行 Loading：
 *  - 参考图缩略图 + 轻量扫描线 / 呼吸边框（禁止霓虹 / 粒子 / 伪百分比进度）；
 *  - 创意文案轮播（getVisualAnalysisMessage，确定性顺序取模，非随机）；
 *  - prefers-reduced-motion：关闭动画与轮播，保留静态状态；
 *  - 失败态由外层 errorText 卡片呈现（本组件随 analyzing 阶段结束卸载，轮播自然停止）。
 * 阶段绑定：本组件只在真实 vision_analyzing 阶段渲染（文案轮播发生在同一真实阶段内，
 * 不虚构 upload/parse 等后端不存在的子阶段）。
 */

import { useEffect, useState } from 'react';
import { ANALYSIS_PROGRESS, getVisualAnalysisMessage } from './recreationCopy';

/** 文案轮播间隔（同一真实分析阶段内的创意文案切换）。 */
const MESSAGE_INTERVAL_MS = 3200;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

interface VisualAnalysisProgressProps {
  /** 参考图缩略图（本地读取；为空时显示占位块，不生成装饰图）。 */
  thumbUrl: string;
  /** 视觉模型展示名（如「智谱 / GLM-5V-Turbo」）。 */
  modelLabel: string;
}

export default function VisualAnalysisProgress({ thumbUrl, modelLabel }: VisualAnalysisProgressProps) {
  const [messageIndex, setMessageIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    if (reducedMotion) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [reducedMotion]);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => {
      setMessageIndex(index => index + 1);
    }, MESSAGE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reducedMotion]);

  return (
    <section className="vision-card vision-analysis-progress" role="status" aria-live="polite">
      <div className={`vision-analysis-thumb${reducedMotion ? ' reduced-motion' : ''}`}>
        {thumbUrl
          ? <img src={thumbUrl} alt="参考图" />
          : <span className="vision-analysis-thumb-placeholder" aria-hidden="true" />}
        <span className="vision-analysis-scanline" aria-hidden="true" />
      </div>
      <div className="vision-analysis-copy">
        <p className="vision-analysis-message">{getVisualAnalysisMessage(messageIndex)}</p>
        <p className="vision-analysis-subline">{ANALYSIS_PROGRESS.subtitle}</p>
        <p className="vision-analysis-model">
          {ANALYSIS_PROGRESS.modelPrefix}：{modelLabel}
        </p>
      </div>
    </section>
  );
}
