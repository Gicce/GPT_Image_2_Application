/**
 * Skill Trace Drawer（V4.2 §24/§25）—— 技能执行过程右抽屉 + Prompt 来源反查。
 *
 * 五阶段（本轮最高产品要求）：每个技能展示
 *   ① 发现了什么 ② 建议什么 ③ 用户采用了什么 ④ 系统强制了什么 ⑤ 写进 Prompt 什么
 * 视觉区分（§26）：建议=info 蓝 / 已采用=success 绿 / 拒绝=muted 灰 /
 * 系统强制=warn 琥珀 / 失败=danger 红 —— 全部走 badge 语义 Token。
 *
 * 数据铁律：只读传入快照（项目当前态 = project.skillExecution；
 * History = provenance.skillExecutionSnapshot 冻结态）。无快照 = 如实提示
 * 「该项目创建于技能追踪功能之前」，绝不伪造记录（§44）。
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type {
  SkillCompiledSection,
  SkillExecutionRecord,
  SkillExecutionSnapshot,
} from '../../../types';
import { runtimeSkillById } from './registry';
import { buildSkillTraceMarkdown } from './exportTrace';
import { copyText } from '../../../utils/clipboard';
import { toastSuccess } from '../../../components/Toast';
import { computePromptDiff } from '../promptDiff';
import { skillOriginSectionLabel } from '../project/skillOriginGuard';
import type { VisualProjectOriginSkill } from '../project/types';
import './skills.css';

const STATUS_LABELS: Record<SkillExecutionRecord['status'], string> = {
  applied: '已执行',
  skipped: '未启用',
  overridden: '已覆写',
  failed: '失败',
};

const BLOCK_LABELS: Record<SkillCompiledSection['block'], string> = {
  image_roles: '图片角色',
  person_contract: '人物替换合同',
  clothing_contract: '服装合同',
  locked_template: '模板保留（锁定基线）',
  expression_contract: '表情锁定合同',
  media_contract: '媒介结构合同',
  anime_character_contract: '动漫角色一致性合同',
  detail_insert_contract: '细节插图同步合同',
  region_contract: '区域编辑合同',
  dimension_contract: '修改动作合同',
  negative_constraints: '负面约束',
  final_description: '最终画面描述',
};

/** 五阶段单技能渲染（Drawer 与 History 详情共用；只读 record）。 */
export function SkillTraceRecordView({ record }: { record: SkillExecutionRecord }) {
  const hasPrompt = record.promptContributions.length > 0;
  return (
    <div className="vision-skill-record" data-testid={`vision-skill-${record.skillId}`}>
      <div className="vision-skill-record-head">
        <span className="vision-skill-record-name">{record.skillName}</span>
        <span className={`vision-skill-status is-${record.status}`}>
          {STATUS_LABELS[record.status]}
        </span>
        <span className="vision-skill-version">v{record.skillVersion}</span>
      </div>
      {record.skippedReason && <p className="vision-skill-skip-reason">{record.skippedReason}</p>}

      {record.findings.length > 0 && (
        <div className="vision-skill-phase">
          <span className="vision-skill-phase-label">发现</span>
          <ul className="vision-skill-phase-items">
            {record.findings.map(finding => (
              <li key={finding.id} className={`is-${finding.severity ?? 'info'}`}>
                <span className="vision-skill-phase-title">{finding.title}</span>
                {finding.description && <span className="vision-skill-phase-desc">{finding.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {record.suggestions.length > 0 && (
        <div className="vision-skill-phase">
          <span className="vision-skill-phase-label">建议</span>
          <ul className="vision-skill-phase-items">
            {record.suggestions.map(suggestion => (
              <li key={suggestion.id} className="is-suggestion">
                <span className="vision-skill-phase-title">
                  {suggestion.type === 'required' ? '（必须）' : ''}{suggestion.title}
                </span>
                {suggestion.description && <span className="vision-skill-phase-desc">{suggestion.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {record.userDecisions.length > 0 && (
        <div className="vision-skill-phase">
          <span className="vision-skill-phase-label">用户选择</span>
          <ul className="vision-skill-phase-items">
            {record.userDecisions.map((decision, index) => (
              <li key={`${decision.suggestionId}-${index}`} className={decision.decision === 'rejected' ? 'is-rejected' : 'is-accepted'}>
                <span className="vision-skill-phase-title">
                  {decision.decision === 'accepted' ? '已采用' : decision.decision === 'modified' ? '已调整' : '已拒绝'}
                </span>
                {decision.modifiedValue !== undefined && (
                  <span className="vision-skill-phase-desc">{JSON.stringify(decision.modifiedValue)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {record.hardConstraints.length > 0 && (
        <div className="vision-skill-phase">
          <span className="vision-skill-phase-label">系统强制</span>
          <ul className="vision-skill-phase-items">
            {record.hardConstraints.map((constraint, index) => (
              <li key={`${constraint.dimension}-${index}`} className="is-forced">
                <span className="vision-skill-phase-title">
                  🔒 {constraint.dimension}
                  {constraint.value ? ` = ${constraint.value}` : ''}
                  {constraint.source ? `（来源 ${constraint.source}）` : ''}
                </span>
                <span className="vision-skill-phase-desc">{constraint.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasPrompt && (
        <div className="vision-skill-phase">
          <span className="vision-skill-phase-label">Prompt 写入</span>
          <ul className="vision-skill-phase-items">
            {record.promptContributions.map((contribution, index) => (
              <li key={`${contribution.block}-${index}`} className="is-prompt">
                <span className="vision-skill-phase-title">
                  已写入「{BLOCK_LABELS[contribution.block]}」
                </span>
                <span className="vision-skill-phase-desc">{contribution.summary}</span>
                {contribution.finalText && (
                  <details className="vision-skill-prompt-text">
                    <summary>查看写入文本</summary>
                    <pre>{contribution.finalText}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 技能清单（Drawer 主体；History 详情也复用）。 */
export function SkillTraceContent({ snapshot }: { snapshot: SkillExecutionSnapshot }) {
  const applied = snapshot.skills.filter(record => record.status === 'applied');
  return (
    <div className="vision-skill-trace" data-testid="vision-skill-trace">
      <p className="vision-skill-trace-summary">
        共 {snapshot.skills.length} 个技能，{applied.length} 个已执行 · Revision {snapshot.projectRevision}
        {snapshot.optimizationRevision !== undefined ? ` · 优化对齐 R${snapshot.optimizationRevision}` : ''}
        {' · '}{new Date(snapshot.createdAt).toLocaleString('zh-CN')}
      </p>
      {snapshot.skills.map(record => <SkillTraceRecordView key={record.skillId} record={record} />)}
    </div>
  );
}

/** Prompt 来源反查（§39/§40：默认纯文本 Prompt，来源在侧栏按段标识）。 */
export function SkillPromptSourceContent({ sections }: { sections: ReadonlyArray<SkillCompiledSection> }) {
  if (sections.length === 0) {
    return <p className="vision-hint">本次 Prompt 没有冻结分段信息（旧任务或未经过编译链路）。</p>;
  }
  return (
    <div className="vision-skill-prompt-source" data-testid="vision-skill-prompt-source">
      {sections.map((section, index) => (
        <div key={`${section.block}-${index}`} className="vision-skill-source-block">
          <div className="vision-skill-source-head">
            <span className="vision-skill-source-name">{BLOCK_LABELS[section.block]}</span>
            <span className="vision-skill-source-attribution">
              ← {section.skillIds.map(id => runtimeSkillById(id)?.name ?? id).join(' + ')}
            </span>
          </div>
          <pre className="vision-skill-source-text">{section.text}</pre>
        </div>
      ))}
    </div>
  );
}

export interface SkillTraceDrawerProps {
  open: boolean;
  mode: 'skills' | 'prompt';
  /** 项目当前态快照（无 = 旧项目 / 未优化过，如实提示）。 */
  snapshot: SkillExecutionSnapshot | null;
  /** 工作台实况编译分段（mode=prompt 且无冻结分段时的「将写入」预览）。 */
  liveSections?: ReadonlyArray<SkillCompiledSection> | null;
  /** 实况编译的最终 Prompt 全文（模板复用 Skill 与保存基线的逐字对比用）。 */
  livePromptText?: string;
  /** 实况编译的合同层名（Compiler sections 口径；与保存基线做结构级对比）。 */
  liveCompilerSections?: string[];
  /** 项目名（复制导出头部元信息用；快照只存 projectId）。 */
  projectName?: string;
  /** 模板复用 Skill 来源标记（V6：Prompt 对比视图 = 保存基线 vs 当前实况）。 */
  originSkill?: VisualProjectOriginSkill | null;
  /** Skill Origin Guard 当前要求的合同块名（originSkill 存在时随项目态计算）。 */
  originRequiredBlocks?: string[];
  onClose: () => void;
}

/**
 * Skill Origin 对比卡（V6 Goal D）—— 模板复用 Skill 派生项目专用：
 *  - 结构级对比：保存基线合同块 vs 当前实况合同块（缺块 = 降级信号，红色标出）；
 *  - 全文 Diff：保存基线 Prompt → 当前实况 Prompt（复用 computePromptDiff 唯一实现）。
 * 数据铁律：originSkill / 实况文本全部由调用方传入（确定性编译产物），本组件零推断。
 */
export function SkillOriginCompareCard({ originSkill, livePromptText, liveCompilerSections, requiredBlocks }: {
  originSkill: VisualProjectOriginSkill;
  livePromptText?: string;
  liveCompilerSections?: string[];
  /** 当前项目状态下 Skill Origin Guard 实际要求的合同块（区分「降级缺失」与「按需未编译」）。 */
  requiredBlocks?: string[];
}) {
  const hasLive = livePromptText !== undefined && liveCompilerSections !== undefined;
  const baselineSet = new Set(originSkill.baselineSections);
  const liveSet = new Set(liveCompilerSections ?? []);
  const requiredSet = new Set(requiredBlocks ?? []);
  const missingBlocks = originSkill.baselineSections.filter(block => !liveSet.has(block));
  const blockingBlocks = missingBlocks.filter(block => requiredSet.has(block));
  const optionalMissingBlocks = missingBlocks.filter(block => !requiredSet.has(block));
  const addedBlocks = (liveCompilerSections ?? []).filter(block => !baselineSet.has(block));
  const diff = hasLive
    ? computePromptDiff(originSkill.baselineFinalPrompt, livePromptText ?? '')
    : null;
  const structureChanged = missingBlocks.length > 0 || addedBlocks.length > 0;

  return (
    <section className="skill-origin-card" data-testid="skill-origin-compare">
      <header className="skill-origin-head">
        <h4>来源 Skill 基线对比</h4>
        <span className="skill-origin-meta">
          {originSkill.skillName} · 源修订 R{originSkill.sourceRevision} · 保存于 {originSkill.savedAt.slice(0, 19).replace('T', ' ')}
        </span>
      </header>
      <p className="skill-origin-desc">
        本项目由模板复用 Skill「{originSkill.skillName}」重建。下方对比保存 Skill 时刻的
        编译基线与当前实况编译——合同结构应保持同级，缺块即代表降级。
      </p>

      {hasLive ? (
        <>
          <div className="skill-origin-structure">
            <h5>结构级对比（保存基线 {originSkill.baselineSections.length} 块 → 当前 {liveCompilerSections!.length} 块）</h5>
            <ul>
              {originSkill.baselineSections.map(block => (
                <li key={block} className={liveSet.has(block) ? 'is-kept' : requiredSet.has(block) ? 'is-missing' : 'is-optional'}>
                  {liveSet.has(block) ? '✓' : requiredSet.has(block) ? '✗' : '○'} {skillOriginSectionLabel(block)}
                </li>
              ))}
              {addedBlocks.map(block => (
                <li key={`added-${block}`} className="is-added">＋ {skillOriginSectionLabel(block)}（新增）</li>
              ))}
            </ul>
            {!structureChanged && <p className="skill-origin-ok">合同结构与保存基线完全一致——Skill 执行未降级。</p>}
            {optionalMissingBlocks.length > 0 && (
              <p className="skill-origin-note">
                按需未编译（当前项目状态不要求）：{optionalMissingBlocks.map(skillOriginSectionLabel).join('、')}——如需启用请绑定对应参考。
              </p>
            )}
            {blockingBlocks.length > 0 && (
              <p className="skill-origin-warn">
                缺少 {blockingBlocks.length} 个必需合同块：{blockingBlocks.map(skillOriginSectionLabel).join('、')}。
                生成前会被 Skill Origin Guard 阻断。
              </p>
            )}
          </div>

          {diff && (
            <div className="skill-origin-diff">
              <h5>
                全文 Diff（基线 → 当前实况）
                {diff.addedCount > 0 && <span className="is-added">+{diff.addedCount}</span>}
                {diff.removedCount > 0 && <span className="is-removed">-{diff.removedCount}</span>}
                {diff.addedCount === 0 && diff.removedCount === 0 && <span className="is-same">（逐字一致）</span>}
              </h5>
              <pre className="skill-origin-diff-text">
                {diff.segments.map((seg, i) => seg.type === 'equal'
                  ? <span key={i}>{seg.text}</span>
                  : <span key={i} className={`diff-seg ${seg.type === 'added' ? 'diff-added' : 'diff-removed'}`}>
                      {seg.type === 'added' ? '+' : '-'}{seg.text}
                    </span>)}
              </pre>
            </div>
          )}
        </>
      ) : (
        <p className="vision-hint">尚未取得当前实况编译——点击「Prompt 来源」刷新后将显示对比。</p>
      )}
    </section>
  );
}

export default function SkillTraceDrawer({
  open, mode, snapshot, liveSections, livePromptText, liveCompilerSections, projectName, originSkill, originRequiredBlocks, onClose,
}: SkillTraceDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sections = snapshot?.compiledSections ?? liveSections ?? [];

  const copyTraceAsMarkdown = async () => {
    if (!snapshot) return;
    const markdown = buildSkillTraceMarkdown(snapshot, { projectName });
    const ok = await copyText(markdown, '复制失败，请重试');
    if (ok) toastSuccess('已复制技能执行过程（Markdown）');
  };

  return createPortal(
    <div className="vision-skill-drawer-overlay" onClick={onClose} data-testid="vision-skill-drawer">
      <aside
        className="vision-skill-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'skills' ? '技能执行过程' : 'Prompt 来源'}
        onClick={e => e.stopPropagation()}
      >
        <div className="vision-skill-drawer-header">
          <h3>{mode === 'skills' ? '技能执行过程' : 'Prompt 来源'}</h3>
          <div className="vision-skill-drawer-actions">
            {mode === 'skills' && snapshot && (
              <button
                type="button"
                className="vision-btn vision-btn-sm"
                title="把全部技能的五阶段执行过程复制为 Markdown，可直接粘贴给外部复核"
                onClick={() => { void copyTraceAsMarkdown(); }}
              >复制全部执行过程</button>
            )}
            <button type="button" className="vision-btn vision-btn-sm" onClick={onClose}>关闭</button>
          </div>
        </div>
        <div className="vision-skill-drawer-body">
          {mode === 'skills' ? (
            snapshot ? <SkillTraceContent snapshot={snapshot} />
              : (
                <div className="vision-skill-empty">
                  <p className="vision-hint">
                    暂无技能执行记录（项目创建于技能追踪功能之前，或尚未执行优化）。
                  </p>
                  <p className="vision-hint">下一次「优化复刻 Prompt」完成后，将生成从发现到 Prompt 写入的完整执行记录。</p>
                </div>
              )
          ) : (
            <>
              {originSkill && (
                <SkillOriginCompareCard
                  originSkill={originSkill}
                  livePromptText={livePromptText}
                  liveCompilerSections={liveCompilerSections}
                  requiredBlocks={originRequiredBlocks}
                />
              )}
              {snapshot?.compiledSections
                ? <SkillPromptSourceContent sections={snapshot.compiledSections} />
                : (
                  <>
                    {liveSections && liveSections.length > 0 && (
                      <p className="vision-hint">按当前方案，生成时将写入以下 Prompt 块：</p>
                    )}
                    <SkillPromptSourceContent sections={liveSections ?? []} />
                  </>
                )}
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
