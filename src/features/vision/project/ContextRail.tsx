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
import {
  bindDetailInsertsToCharacter, detailInsertCropLabel, detailInsertIncompleteErrors, isCharacterAssetReusable,
} from './animeCharacter';
import { describeRecreationStatus } from '../recreationPlan';
import { SAVE_AS_SKILL_ACTION } from '../recreationCopy';
import OptimizeProgressCard from '../OptimizeProgressCard';
import { isOptimizationRunning, type PromptOptimizationStatus } from '../optimizeProgress';
import {
  detailRepairElapsedSeconds,
  detailRepairStageLabel,
  type DetailRepairProgress,
  type DetailRepairStage,
} from './detailInsertRepairRunner';
import type { EffectivePlanRow, EffectivePlanSourceRef, VisualProject } from './types';

interface ContextRailProps {
  project: VisualProject | null;
  /** V6.7 四步向导：项目整体进度 checklist（页面派生，Rail 纯展示）。 */
  wizardProgress?: Array<{ id: number; label: string; done: boolean; active: boolean; status?: 'pending' | 'current' | 'completed' }>;
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
  /**
   * 「复刻成我的技能」（V6.8.1 恢复）：Secondary Action，放在最终操作区
   * （「优化复刻 Prompt」之后、「确认生成图片」之前，主强调仍归生成 CTA）。
   * 复用技能创建原链路；canSaveAsSkill=false 时禁用并说明原因（不静默隐藏）。
   */
  onSaveAsSkill?: () => void;
  canSaveAsSkill?: boolean;
  /** V6.8 优化运行期真实进度（idle = 不显示进度卡；只有阶段/开始时间/错误事实）。 */
  optimizeProgress?: { status: PromptOptimizationStatus; startedAt: number; errorText?: string } | null;
  /** V6.8 失败进度卡的「重新优化」入口。 */
  onRetryOptimize?: () => void;
  /** V6.8 §六：当前方案行点击定位（如区域替换行 → 素材替换步骤的区域面板）。 */
  onLocateRow?: (rowKey: string) => void;
  onGenerate?: () => void;
  onGenerateCharacterAsset?: (force?: boolean) => void;
  characterAssetRequesting?: boolean;
  /** 打开技能执行过程 Drawer（§23/§24）。 */
  onOpenSkillTrace?: () => void;
  /** V6.1 Recoverable Blocker：局部插图补充识别（只补实例，不重写模板分析）。 */
  onRepairDetailInserts?: () => void;
  detailInsertRepairing?: boolean;
  /** 最近一次补充识别的失败原因（技术详情默认折叠，保留旧分析）。 */
  detailInsertRepairError?: string;
  /** 最近一次补充识别的成功摘要（blocker 消失后显示绿色状态）。 */
  detailInsertRepairSummary?: string;
  /** V6.2 识别进度（projectId 隔离；只有真实阶段/层数/计时，无假百分比）。 */
  detailRepairProgress?: DetailRepairProgress | null;
  /** V6.2 层间诚实取消（已完成层照常合并）。 */
  onCancelDetailRepair?: () => void;
}

/** 阶段序号（真实阶段数 4；「N/4」是阶段计数，不是模型进度百分比）。 */
const DETAIL_REPAIR_STAGES: readonly DetailRepairStage[] = ['preparing', 'recognizing', 'merging', 'validating'];

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
  wizardProgress,
  recreationNeedsOptimization,
  optimizerModelLabel,
  optimizerSourceSuffix,
  visionModelLabel,
  disabled,
  showUseLastPrompt,
  onUseLastPrompt,
  onReoptimize,
  onOptimize,
  onSaveAsSkill,
  canSaveAsSkill,
  optimizeProgress,
  onRetryOptimize,
  onLocateRow,
  onGenerate,
  onGenerateCharacterAsset,
  characterAssetRequesting,
  onOpenSkillTrace,
  onRepairDetailInserts,
  detailInsertRepairing,
  detailInsertRepairError,
  detailInsertRepairSummary,
  detailRepairProgress,
  onCancelDetailRepair,
}: ContextRailProps) {
  const plan = useMemo(() => (project ? buildEffectiveVisualPlan(project) : null), [project]);
  // V6.2 识别中每秒重算已用时：模型调用没有 token 级进度，UI 只报真实计时，
  // 禁止伪造百分比（Progress Honesty）。
  const [repairNow, setRepairNow] = useState(() => Date.now());
  const repairRunning = detailRepairProgress?.status === 'running';
  useEffect(() => {
    if (!repairRunning) return;
    setRepairNow(Date.now());
    const timer = window.setInterval(() => setRepairNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [repairRunning]);
  const rules = useMemo(() => activeVisionPlanRules(project), [project]);
  const status = describeRecreationStatus(null);
  const appliedSkills = useMemo(
    () => (project?.skillExecution?.skills ?? []).filter(record => record.status === 'applied'),
    [project?.skillExecution],
  );
  // V6.1：可修复阻断（局部插图未逐个识别）与普通阻断拆分——前者挂 Repair CTA
  const repairableErrors = useMemo(() => (project ? detailInsertIncompleteErrors(project) : []), [project]);
  const otherBlockingErrors = useMemo(
    () => (plan ? plan.blockingErrors.filter(error => !repairableErrors.includes(error)) : []),
    [plan, repairableErrors],
  );
  const insertBindings = useMemo(
    () => (project ? bindDetailInsertsToCharacter(project)?.bindings ?? [] : []),
    [project],
  );
  // 规则清单 / 局部插图清单折叠 = 纯视图状态（组件局部；绝不触发语义修订）
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const [insertsOpen, setInsertsOpen] = useState(false);

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
      {/* V6.7 项目整体进度：四步向导 checklist（替换情况 / 技能执行在下方既有区块） */}
      {wizardProgress && wizardProgress.length > 0 && (
        <div className="vision-rail-card vision-rail-progress" data-testid="vision-rail-progress">
          <span className="vision-rail-title">项目进度</span>
          <ul className="vision-rail-progress-list">
            {wizardProgress.map(item => (
              <li
                key={item.id}
                className={item.active ? 'is-active' : item.done ? 'is-done' : ''}
                aria-current={item.active ? 'step' : undefined}
              >
                <span className="vision-rail-progress-index" aria-hidden="true">{item.done && !item.active ? '✓' : item.id}</span>
                <span className="vision-rail-progress-label">{item.label}</span>
                {/* V6.8：状态文案来自统一 selector 的 status（缺省回落 done/active 旧口径） */}
                <span className="vision-rail-progress-state">
                  {item.status
                    ? item.status === 'completed' ? '已完成' : item.status === 'current' ? '进行中' : '待开始'
                    : item.active ? '进行中' : item.done ? '已完成' : '待开始'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
          // V6.8 §六：区域替换行可点击定位（有区域时）→ 素材替换步骤的区域面板
          const locatable = row.key === 'regions' && row.kind !== 'keep' && Boolean(onLocateRow);
          return (
            <div key={row.key} className={`vision-rail-row kind-${row.kind}${locatable ? ' is-locatable' : ''}`}>
              <span className="vision-rail-label">{row.label}</span>
              <span className="vision-rail-value" title={row.value}>
                {marker}
                {locatable ? (
                  <button
                    type="button"
                    className="vision-rail-locate"
                    data-testid="vision-rail-locate-regions"
                    title="点击定位到素材替换的区域面板"
                    onClick={() => onLocateRow?.(row.key)}
                  >
                    <RowValue row={row} />
                  </button>
                ) : (
                  <RowValue row={row} />
                )}
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

      {/* V6.1 Recoverable Blocker：局部插图未识别完整 ⇒ 直接给「识别局部插图」
          Repair 入口（复用 V5 受限补充识别），绝不出现「请去某处处理」死路。 */}
      {plan.blockingErrors.length > 0 && (
        <div className="vision-rail-card is-error" role="alert" data-testid="vision-blocking-card">
          <span className="vision-rail-title">生成前需处理</span>
          {repairableErrors.length > 0 && onRepairDetailInserts && (
            <div className="vision-rail-repair" data-testid="detail-insert-repair">
              <b className="vision-rail-repair-title">局部插图尚未识别完整</b>
              {detailInsertRepairing ? (
                detailRepairProgress ? (
                  <div className="vision-rail-repair-progress" data-testid="detail-insert-repair-progress">
                    {/* indeterminate 动画：无百分比——模型调用只有真实阶段与层数 */}
                    <span className="vision-rail-repair-bar" aria-hidden="true" />
                    <p className="vision-rail-repair-stage">
                      阶段 {DETAIL_REPAIR_STAGES.indexOf(detailRepairProgress.stage) + 1}/{DETAIL_REPAIR_STAGES.length}
                      ：{detailRepairStageLabel(detailRepairProgress.stage)}
                      {detailRepairProgress.stage === 'recognizing' && detailRepairProgress.totalRegions > 0
                        ? `（第 ${Math.min(detailRepairProgress.completedRegions + 1, detailRepairProgress.totalRegions)}/${detailRepairProgress.totalRegions} 层）`
                        : ''}
                    </p>
                    <p className="vision-rail-repair-meta">
                      已用时 {detailRepairElapsedSeconds(detailRepairProgress, repairNow)} 秒，不会改变你当前的人物、服装、动作与方案。
                    </p>
                    {onCancelDetailRepair && (
                      <button type="button" className="vision-btn vision-btn-sm" onClick={onCancelDetailRepair}>
                        停止识别
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="vision-rail-repair-progress" data-testid="detail-insert-repair-progress">
                    正在识别模板中的局部画框，不会改变你当前的人物、服装、动作与方案。
                  </p>
                )
              ) : detailInsertRepairError ? (
                <div className="vision-rail-repair-failed">
                  <p>局部插图识别失败</p>
                  <details className="vision-rail-repair-tech">
                    <summary>查看错误详情</summary>
                    <p>{detailInsertRepairError}</p>
                  </details>
                  <div className="vision-rail-repair-actions">
                    <button type="button" className="vision-btn vision-btn-primary vision-btn-sm" onClick={onRepairDetailInserts}>重试</button>
                    <button type="button" className="vision-btn vision-btn-sm" onClick={() => setInsertsOpen(true)}>查看详情</button>
                  </div>
                </div>
              ) : (
                <>
                  <p>检测到模板包含多个局部画框，但目前只有分组信息，尚未建立每个画框的独立识别结果。生成前需要补充识别。</p>
                  <div className="vision-rail-repair-actions">
                    <button type="button" className="vision-btn vision-btn-primary vision-btn-sm" onClick={onRepairDetailInserts}>识别局部插图</button>
                    <button type="button" className="vision-btn vision-btn-sm" onClick={() => setInsertsOpen(value => !value)}>查看详情</button>
                  </div>
                </>
              )}
            </div>
          )}
          {otherBlockingErrors.length > 0 && (
            <ul>
              {otherBlockingErrors.map(error => <li key={error}>{error}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* 局部插图实例清单（§9：识别结果轻量展示；展开 = 纯视图状态） */}
      {insertBindings.length > 0 && (
        <div className="vision-rail-card vision-rail-inserts" data-testid="vision-rail-inserts">
          <button
            type="button"
            className="vision-rail-rules-toggle"
            aria-expanded={insertsOpen}
            onClick={() => setInsertsOpen(value => !value)}
          >
            <span className="vision-rail-label">局部插图 · {insertBindings.length} 个</span>
            <span className="vision-rail-rules-caret">{insertsOpen ? '收起 ▴' : '展开 ▾'}</span>
          </button>
          {insertsOpen && (
            <ul className="vision-rail-insert-list">
              {insertBindings.map((binding, index) => (
                <li key={binding.instanceId}>
                  <b>#{index + 1} {binding.insertLabel}</b>
                  <span>{binding.positionLabel ?? '位置未标注'} · {detailInsertCropLabel(binding.cropType)}</span>
                  <em>{binding.characterRef ? '→ 同步动漫主角色' : binding.mirrorTargetRole === 'primary_subject' ? '→ 真人主体' : '→ 次要主体'}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 补充识别成功状态（blocker 已消失；绿色确认 + 查看识别结果） */}
      {detailInsertRepairSummary && repairableErrors.length === 0 && (
        <div className="vision-rail-card is-success" data-testid="detail-insert-repair-success">
          <p>{detailInsertRepairSummary}</p>
          <button type="button" className="vision-btn vision-btn-sm" onClick={() => setInsertsOpen(value => !value)}>查看识别结果</button>
        </div>
      )}

      <div className="vision-rail-card vision-rail-cta">
        {/* V6.8 §五：优化运行期用真实进度卡替换按钮区（按钮不可重复点击；失败显示真实错误 + 重新优化） */}
        {optimizeProgress && isOptimizationRunning(optimizeProgress.status) ? (
          <OptimizeProgressCard
            status={optimizeProgress.status}
            startedAt={optimizeProgress.startedAt}
            modelLabel={optimizerModelLabel}
          />
        ) : (
          <>
            {optimizeProgress && optimizeProgress.status === 'failed' && (
              <OptimizeProgressCard
                status={optimizeProgress.status}
                startedAt={optimizeProgress.startedAt}
                modelLabel={optimizerModelLabel}
                errorText={optimizeProgress.errorText}
                onRetry={onRetryOptimize}
              />
            )}
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
            >优化复刻 Prompt</button>
            {onSaveAsSkill && project && (
              <button
                type="button"
                className="vision-btn"
                disabled={disabled || !canSaveAsSkill}
                title={canSaveAsSkill
                  ? SAVE_AS_SKILL_ACTION.hint
                  : recreationNeedsOptimization
                    ? SAVE_AS_SKILL_ACTION.staleHint
                    : SAVE_AS_SKILL_ACTION.optimizingHint}
                onClick={onSaveAsSkill}
              >{SAVE_AS_SKILL_ACTION.label}</button>
            )}
            <button
              type="button"
              className="vision-btn vision-btn-primary"
              disabled={disabled || plan.blockingErrors.length > 0}
              onClick={onGenerate}
            >确认生成图片</button>
          </>
        )}
      </div>
    </aside>
  );
}
