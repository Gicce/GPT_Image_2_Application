/**
 * ContextRail（§25）—— 工作台右侧「当前执行合同」栏（桌面端 sticky）。
 *
 *  - 内容全部读 EffectiveVisualPlan（buildEffectiveVisualPlan 唯一构建入口；
 *    本组件绝不自行拼装合同行）；
 *  - CTA（重新优化 / 优化复刻 Prompt / 确认生成图片）唯一渲染处：主工作区不再
 *    重复第二组生成按钮（单列布局下 Rail 随网格自然下移，仍只有一个 CTA 源）；
 *  - 「待优化」状态 = 项目修订落后于已优化修订 / recreation needsOptimization
 *    （派生比较；纯 UI 操作绝不影响这里的判定）；
 *  - §A 来源可视：value 中的 @token 渲染为可交互 chip——hover 预览缩略图、
 *    点击打开内置查看器；已替换 / 不保留行带状态徽标；
 *  - §C 规则中心：「方案规则」块列出本方案实际启用的编译规则 / 合同 / 不变量。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../../services/api';
import { useImageViewerStore } from '../../../store/useImageViewerStore';
import { copyText } from '../../../utils/clipboard';
import { toastSuccess } from '../../../components/Toast';
import { buildEffectiveVisualPlan } from './effectivePlan';
import { activeVisionPlanRules } from './ruleRegistry';
import { isCharacterAssetReusable } from './animeCharacter';
import { describeRecreationStatus } from '../recreationPlan';
import type { EffectivePlanRow, EffectivePlanSourceRef, VisualProject } from './types';

interface ContextRailProps {
  project: VisualProject | null;
  /** recreation 待优化判定（页面传入；与项目修订独立）。 */
  recreationNeedsOptimization: boolean;
  optimizerModelLabel: string | null;
  optimizerSourceSuffix: string;
  visionModelLabel: string;
  disabled?: boolean;
  showUseLastPrompt?: boolean;
  onUseLastPrompt?: () => void;
  onReoptimize?: () => void;
  onOptimize?: () => void;
  onGenerate?: () => void;
  onGenerateCharacterAsset?: (force?: boolean) => void;
  characterAssetRequesting?: boolean;
  /** 打开技能执行过程 Drawer（§23/§24）。 */
  onOpenSkillTrace?: () => void;
}

/** 锁 / 改标记适用行（§30：一眼看出本次到底什么会改、什么沿用模板）。 */
const DIMENSION_ROW_KEYS = new Set([
  'person_identity', 'pose', 'scene', 'camera', 'style', 'clothing', 'composition',
]);

/** keep = 🔒 沿用模板；modified/source = ✦ 将被修改；info 行不加标记。 */
function rowMarker(row: { key: string; kind: string }): string {
  if (!DIMENSION_ROW_KEYS.has(row.key)) return '';
  if (row.kind === 'keep') return '🔒 ';
  if (row.kind === 'modified' || row.kind === 'source') return '✦ ';
  return '';
}

/** 缩略图缓存（路径 → dataURL Promise；Rail 内 chip 共享，避免重复读盘）。 */
const thumbCache = new Map<string, Promise<string>>();

const PREVIEW_DELAY_MS = 220;
const PREVIEW_WIDTH = 200;

/** chip 兜底名（不变量 4：可预览 / 可点击的来源 label 永不为空）。 */
const CHIP_FALLBACK_LABELS: Record<EffectivePlanSourceRef['role'], string> = {
  template: '模板图',
  person: '人物参考图',
  mention: '图片引用',
};

/** @来源 chip：hover 预览缩略图 + 完整名 / 角色说明 + 点击打开内置图片查看器。 */
function SourceChip({ sourceRef }: { sourceRef: EffectivePlanSourceRef }) {
  const [preview, setPreview] = useState<
    { url: string | null; left: number; top: number } | null
  >(null);
  const timerRef = useRef<number | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  const label = sourceRef.label?.trim() || CHIP_FALLBACK_LABELS[sourceRef.role];
  const fullLabel = sourceRef.fullLabel?.trim() || label;
  const roleNote = sourceRef.roleNote?.trim() || CHIP_FALLBACK_LABELS[sourceRef.role];
  const path = sourceRef.path?.trim();

  if (!path) {
    return <span className="vision-ref-chip is-text" title={`${fullLabel}（不可预览）`}>@{label}</span>;
  }

  const cancelHover = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPreview(null);
  };

  const scheduleHover = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void (async () => {
        let url: string | null = null;
        try {
          let load = thumbCache.get(path);
          if (!load) {
            load = api.readThumbnail(path);
            thumbCache.set(path, load);
          }
          url = await load;
        } catch {
          url = null; // 预览失败不空白：浮层显示「图片不可预览」
        }
        const rect = chipRef.current?.getBoundingClientRect();
        const left = Math.max(8, (rect ? rect.left : 0) - PREVIEW_WIDTH - 10);
        const top = Math.max(8, rect ? Math.min(rect.top, window.innerHeight - 280) : 8);
        setPreview({ url, left, top });
      })();
    }, PREVIEW_DELAY_MS);
  };

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`vision-ref-chip${sourceRef.role === 'person' ? ' is-person' : ''}`}
        title={`${fullLabel}（点击查看大图）\n${roleNote}\n${path}`}
        onMouseEnter={scheduleHover}
        onMouseLeave={cancelHover}
        onClick={() => useImageViewerStore.getState().openViewer([{
          id: path,
          path,
          title: fullLabel,
          fileName: path.split(/[\\/]/).pop(),
        }])}
      >
        @{label}
      </button>
      {preview && createPortal(
        <div className="vision-ref-preview" style={{ left: preview.left, top: preview.top }} aria-hidden="true">
          {preview.url
            ? <img src={preview.url} alt={fullLabel} draggable={false} />
            : <div className="vision-ref-preview-empty">图片不可预览</div>}
          <div className="vision-ref-preview-meta">
            <span className="vision-ref-preview-name" title={fullLabel}>{fullLabel}</span>
            <span className="vision-ref-preview-note">{roleNote}</span>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** 行值切分：按 refs 的 `@label` 字面量匹配（label 含中文标点 / 空白也不丢 chip）。 */
export function splitValueByRefs(
  value: string,
  refs: ReadonlyArray<EffectivePlanSourceRef>,
): Array<{ text: string } | { ref: EffectivePlanSourceRef }> {
  let segments: Array<{ text: string } | { ref: EffectivePlanSourceRef }> = [{ text: value }];
  for (const ref of [...refs].sort((a, b) => b.label.length - a.label.length)) {
    const token = `@${ref.label}`;
    const next: typeof segments = [];
    for (const segment of segments) {
      if ('ref' in segment) {
        next.push(segment);
        continue;
      }
      const parts = segment.text.split(token);
      parts.forEach((part, index) => {
        if (index > 0) next.push({ ref });
        if (part) next.push({ text: part });
      });
    }
    segments = next;
  }
  return segments;
}

/** 行值渲染：@来源 → 交互 chip（按 ref label 字面量匹配；未匹配保持纯文本）。 */
function RowValue({ row }: { row: EffectivePlanRow }) {
  const segments = splitValueByRefs(row.value, row.refs ?? []);
  return (
    <>
      {segments.map((segment, index) =>
        'ref' in segment
          ? <SourceChip key={`${row.key}-ref-${index}`} sourceRef={segment.ref} />
          : segment.text)}
    </>
  );
}

export default function ContextRail({
  project,
  recreationNeedsOptimization,
  optimizerModelLabel,
  optimizerSourceSuffix,
  visionModelLabel,
  disabled,
  showUseLastPrompt,
  onUseLastPrompt,
  onReoptimize,
  onOptimize,
  onGenerate,
  onGenerateCharacterAsset,
  characterAssetRequesting,
  onOpenSkillTrace,
}: ContextRailProps) {
  const plan = useMemo(() => (project ? buildEffectiveVisualPlan(project) : null), [project]);
  const rules = useMemo(() => activeVisionPlanRules(project), [project]);
  const status = describeRecreationStatus(null);
  const appliedSkills = useMemo(
    () => (project?.skillExecution?.skills ?? []).filter(record => record.status === 'applied'),
    [project?.skillExecution],
  );
  // 规则清单折叠 = 纯视图状态（组件局部；绝不触发语义修订）
  const [rulesExpanded, setRulesExpanded] = useState(false);

  if (!project || !plan) {
    return (
      <aside className="vision-rail" data-testid="vision-context-rail" aria-label="当前方案">
        <div className="vision-rail-card">
          <span className="vision-rail-title">当前方案</span>
          <p className="vision-hint">{status.note}</p>
        </div>
      </aside>
    );
  }

  const pending = recreationNeedsOptimization;
  const strictAnime = project.animeConsistency?.mode === 'strict_visual_reference';
  const characterAssetReady = strictAnime && isCharacterAssetReusable(project);

  return (
    <aside className="vision-rail" data-testid="vision-context-rail" aria-label="当前方案">
      <div className="vision-rail-card">
        <div className="vision-rail-head">
          <span className="vision-rail-title">当前方案</span>
          {pending && (
            <em
              className="vision-rail-pending"
              title="合同已变更，最终 Prompt 尚未重建；此前优化结果已保留，改回原条件（例如仅取消「提高复刻度」）会自动恢复"
            >
              待优化
            </em>
          )}
        </div>

        {plan.template && (
          <div className="vision-rail-block">
            <span className="vision-rail-label">模板</span>
            <span className="vision-rail-value">
              <SourceChip sourceRef={{
                key: 'tpl-head',
                label: plan.template.label,
                fullLabel: plan.template.fullLabel ?? plan.template.label,
                roleNote: plan.template.roleNote ?? CHIP_FALLBACK_LABELS.template,
                path: plan.template.path,
                role: 'template',
              }} />
            </span>
          </div>
        )}
        {plan.rows.map(row => {
          const marker = rowMarker(row);
          return (
            <div key={row.key} className={`vision-rail-row kind-${row.kind}`}>
              <span className="vision-rail-label">{row.label}</span>
              <span className="vision-rail-value" title={row.value}>
                {marker}
                <RowValue row={row} />
                {row.badge && (
                  <span className={`vision-rail-badge is-${row.badge.tone}`} title={row.value}>{row.badge.text}</span>
                )}
              </span>
            </div>
          );
        })}

        <div className="vision-rail-divider" />

        <div className="vision-rail-block">
          <span className="vision-rail-label">Prompt 优化</span>
          <span className="vision-rail-value">
            {optimizerModelLabel ? `${optimizerModelLabel}${optimizerSourceSuffix || ' · 系统默认'}` : '未配置'}
          </span>
        </div>
        <div className="vision-rail-block">
          <span className="vision-rail-label">视觉分析</span>
          <span className="vision-rail-value">{visionModelLabel || '—'}</span>
        </div>
        <div className="vision-rail-block">
          <span className="vision-rail-label">图片生成</span>
          <span className="vision-rail-value">gpt-image-2</span>
        </div>

        {/* §C 规则中心：默认只显示摘要，展开看完整清单；支持复制规则摘要 */}
        <div className="vision-rail-rules" data-testid="vision-rail-rules">
          <div className="vision-rail-rules-head">
            <button
              type="button"
              className="vision-rail-rules-toggle"
              aria-expanded={rulesExpanded}
              onClick={() => setRulesExpanded(value => !value)}
            >
              <span className="vision-rail-label">方案规则（{rules.length} 项生效）</span>
              <span className="vision-rail-rules-caret">{rulesExpanded ? '收起 ▴' : '展开 ▾'}</span>
            </button>
            <button
              type="button"
              className="vision-rail-copy-btn"
              title="复制规则摘要（规则名 + 一句话说明）"
              onClick={() => {
                const summary = rules.map(rule => `- ${rule.name}：${rule.description}`).join('\n');
                void copyText(summary, '复制失败，请重试').then(ok => {
                  if (ok) toastSuccess('已复制规则摘要');
                });
              }}
            >复制规则摘要</button>
          </div>
          {rulesExpanded && (
            <ul className="vision-rail-rule-list">
              {rules.map(rule => (
                <li key={rule.id} title={rule.description}>· {rule.name}</li>
              ))}
            </ul>
          )}
        </div>

        {/* §23 Runtime Skill Trace：checklist 形态；点击技能行打开执行过程抽屉 */}
        {onOpenSkillTrace && (
          <div className="vision-rail-skills" data-testid="vision-rail-skills">
            <span className="vision-rail-label">
              {appliedSkills.length > 0 ? `本次使用 ${appliedSkills.length} 个技能` : '技能执行'}
            </span>
            {appliedSkills.length > 0 ? (
              <ul className="vision-rail-skill-list">
                {appliedSkills.map(record => (
                  <li key={record.skillId}>
                    <button
                      type="button"
                      className="vision-rail-skill-item"
                      title={`${record.skillName} v${record.skillVersion}——点击查看五阶段执行过程`}
                      onClick={onOpenSkillTrace}
                    >✓ {record.skillName}</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="vision-hint">优化完成后展示技能清单</p>
            )}
            <button type="button" className="vision-btn vision-btn-sm" onClick={onOpenSkillTrace}>
              查看技能执行过程
            </button>
          </div>
        )}
      </div>

      {strictAnime && onGenerateCharacterAsset && (
        <div className="vision-rail-card" data-testid="anime-character-reference-card">
          <span className="vision-rail-title">动漫角色参考</span>
          <p className="vision-hint">
            {characterAssetReady
              ? '已就绪，最终生成会自动复用，不重复计费。'
              : '强一致性需要先创建角色参考图，创建前会显示服务端报价。'}
          </p>
          <button
            type="button"
            className="vision-btn vision-btn-sm"
            disabled={disabled || characterAssetRequesting}
            onClick={() => onGenerateCharacterAsset(characterAssetReady)}
          >
            {characterAssetRequesting ? '正在提交…' : characterAssetReady ? '重新生成角色参考图' : '生成角色参考图'}
          </button>
        </div>
      )}

      {plan.blockingErrors.length > 0 && (
        <div className="vision-rail-card is-error" role="alert">
          <span className="vision-rail-title">生成前需处理</span>
          <ul>
            {plan.blockingErrors.map(error => <li key={error}>{error}</li>)}
          </ul>
        </div>
      )}

      <div className="vision-rail-card vision-rail-cta">
        {showUseLastPrompt && onUseLastPrompt && (
          <button type="button" className="vision-btn vision-btn-sm" disabled={disabled} onClick={onUseLastPrompt}>
            使用上一次 Prompt
          </button>
        )}
        <button type="button" className="vision-btn vision-btn-sm" disabled={disabled} onClick={onReoptimize} title="基于当前图片与修改意图强制再优化一次">
          重新优化
        </button>
        <button
          type="button"
          className="vision-btn vision-btn-caution"
          disabled={disabled}
          onClick={onOptimize}
        >{pending ? '优化复刻 Prompt' : '优化复刻 Prompt'}</button>
        <button
          type="button"
          className="vision-btn vision-btn-primary"
          disabled={disabled || plan.blockingErrors.length > 0}
          onClick={onGenerate}
        >确认生成图片</button>
      </div>
    </aside>
  );
}
