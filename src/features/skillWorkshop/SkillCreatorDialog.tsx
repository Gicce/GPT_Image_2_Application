/**
 * Skill 创作器（V4.2.3 重构）：
 * - 三段式弹窗：固定头部 / 左步骤栏 + 右(固定标题 + 可滚正文 + 固定底部)；
 * - 来源事实只读分组列表（长内容展开/收起）；
 * - 检查规则三卡片（核心规则 / 阻断条件 / 质检标准，行级增删移 + 校验 + 确认）；
 * - 保存与发布：样例双入口（本地 / 图片库，共享 ImageLibraryPicker）+ 公开授权确认；
 * - 投稿错误结构化映射 + 零样例投稿恢复（绝不重复创建投稿）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { VisualProject } from '../vision/project/types';
import { api } from '../../services/api';
import { authorUserSkill, resolveSkillAuthoringModelLabel } from '../../services/skillAuthoringService';
import { useImageViewerStore } from '../../store/useImageViewerStore';
import ImageLibraryPicker from '../../components/ImageLibraryPicker';
import type { ImageRecord } from '../../types';
import {
  checkSubmissionCapability, findExistingSubmission, submitUserSkill, uploadSkillSample,
  SubmissionFailureError,
} from './submissionService';
import {
  addRuleItem, moveRuleItem, normalizeRuleList, removeRuleItem, updateRuleItem, validateAllRuleLists,
} from './skillRules';
import {
  createUserSkillFromVisualProject, resolveSkillCoverPath, sanitizeUserSkillForSubmission,
  skillCoverSamplePath, validateUserSkillDraft,
  type SkillAuthoringState, type SkillSourceFact, type UserSkillDraft,
} from './userSkill';
import {
  SKILL_EXECUTION_MODE_LABELS,
  SKILL_OPTIMIZATION_POLICY_LABELS,
  type SkillExecutionMode,
  type SkillOptimizationPolicy,
} from './skillDirectExecution';
import { skillOriginSectionLabel } from '../vision/project/skillOriginGuard';
import './SkillCreatorDialog.css';

const STEPS = ['用途与领域', '来源事实', 'AI 提炼规则', '检查规则', '保存与发布'];
const DOMAIN_LABELS: Record<UserSkillDraft['domain'], string> = {
  desk_setup: '专业桌搭', ecommerce: '电商视觉', product: '产品视觉', brand_ad: '品牌广告',
  interior: '建筑与室内', sports: '运动视觉', ui: 'UI 概念设计',
};
const AUTHORING_STATE_LABELS: Record<SkillAuthoringState, string> = {
  project_template: '尚未通用化（项目模板）',
  ai_candidate: 'AI 候选待确认',
  confirmed: '已确认（修改规则后需重新确认）',
};
const FACT_GROUP_LABELS: Record<string, string> = {
  template: '模板维度', contract: '生成合同', negative: '负面限制',
};

function fileName(path: string) { return path.split(/[\\/]/).pop() || 'sample.png'; }
function fileFormat(path: string) {
  const ext = path.split('.').pop() || '';
  return /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : '';
}
function factGroupOf(key: string): string {
  if (key.startsWith('contract:')) return 'contract';
  if (key === 'negative') return 'negative';
  return 'template';
}
function isLongFact(value: string) { return value.length > 60 || value.includes('\n'); }

interface SkillSampleSelection {
  path: string;
  fileName: string;
  source: 'local' | 'gallery';
  width?: number | null;
  height?: number | null;
  thumb?: string;
  taskId?: string;
}

/** 检查规则页的单张卡片（三组规则共用；数组操作全部走 skillRules 纯函数）。 */
function RuleCard(props: { title: string; hint: string; items: string[]; onChange: (items: string[]) => void }) {
  return (
    <section className="skill-rule-card">
      <header className="skill-rule-card-head">
        <h4>{props.title}</h4>
        <span className="skill-rule-count">{props.items.length} 条</span>
      </header>
      <p className="skill-rule-hint">{props.hint}</p>
      {props.items.length === 0
        ? <p className="skill-rule-empty">暂无内容，点击下方「新增一条」开始添加。</p>
        : <div className="skill-rule-rows">
          {props.items.map((item, index) => (
            <div className="skill-rule-row" key={index}>
              <span className="skill-rule-index">{index + 1}</span>
              <input
                value={item}
                aria-label={`${props.title} 第 ${index + 1} 条`}
                placeholder="输入一条规则"
                onChange={e => props.onChange(updateRuleItem(props.items, index, e.target.value))}
              />
              <div className="skill-rule-ops">
                <button type="button" title="上移" aria-label={`上移${props.title}第 ${index + 1} 条`} disabled={index === 0} onClick={() => props.onChange(moveRuleItem(props.items, index, -1))}>↑</button>
                <button type="button" title="下移" aria-label={`下移${props.title}第 ${index + 1} 条`} disabled={index === props.items.length - 1} onClick={() => props.onChange(moveRuleItem(props.items, index, 1))}>↓</button>
                <button type="button" className="is-remove" title="删除" aria-label={`删除${props.title}第 ${index + 1} 条`} onClick={() => props.onChange(removeRuleItem(props.items, index))}>×</button>
              </div>
            </div>
          ))}
        </div>}
      <button type="button" className="app-btn app-btn-secondary app-btn-sm skill-rule-add" onClick={() => props.onChange(addRuleItem(props.items))}>＋ 新增一条</button>
    </section>
  );
}

export default function SkillCreatorDialog(props: {
  project: VisualProject; onClose: () => void; onSaved?: (draft: UserSkillDraft) => void;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(() => createUserSkillFromVisualProject(props.project));
  const [busy, setBusy] = useState<'' | 'ai' | 'save' | 'publish'>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sample, setSample] = useState<SkillSampleSelection | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  /** V6.3 封面选择器（与样例选择器共用唯一 ImageLibraryPicker 实现，各自独立实例）。 */
  const [coverPickOpen, setCoverPickOpen] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [submissionId, setSubmissionId] = useState('');
  const [ruleErrors, setRuleErrors] = useState<string[]>([]);
  const [expandedFacts, setExpandedFacts] = useState<Set<string>>(new Set());
  /** 完整 Recipe 默认折叠（V6.1：摘要行呈现，长说明不默认铺开）。 */
  const [recipeExpanded, setRecipeExpanded] = useState(false);
  const modelLabel = resolveSkillAuthoringModelLabel();
  const risks = useMemo(() => sanitizeUserSkillForSubmission(draft).risks, [draft]);

  const galleryOpenRef = useRef(false);
  galleryOpenRef.current = galleryOpen || coverPickOpen;

  // V6.3 封面解析（§44 优先级）：自定义 ＞ 公开样例（含待投稿样例）＞ 模板图 ＞ 图标
  const coverSamplePath = skillCoverSamplePath(draft) ?? sample?.path?.trim() ?? undefined;
  const coverTemplatePath = draft.recipe?.template?.path?.trim() || undefined;
  const coverPath = useMemo(
    () => resolveSkillCoverPath(draft.cover, { samplePath: coverSamplePath, templatePath: coverTemplatePath }),
    [draft.cover, coverSamplePath, coverTemplatePath],
  );
  const [coverThumb, setCoverThumb] = useState('');
  useEffect(() => {
    let alive = true;
    if (!coverPath) { setCoverThumb(''); return; }
    api.readThumbnail(coverPath).then(data => { if (alive) setCoverThumb(data); }).catch(() => { if (alive) setCoverThumb(''); });
    return () => { alive = false; };
  }, [coverPath]);

  // 弹窗打开期间禁止背景页面滚动，关闭恢复
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  // Escape 关闭（图片库选择器打开时让选择器自己消化，不关闭整个弹窗）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !galleryOpenRef.current) props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  const factGroups = useMemo(() => {
    const groups = new Map<string, SkillSourceFact[]>();
    for (const fact of draft.sourceFacts) {
      const id = factGroupOf(fact.key);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(fact);
    }
    return [...groups.entries()].map(([id, facts]) => ({ id, label: FACT_GROUP_LABELS[id] || '其它', facts }));
  }, [draft.sourceFacts]);

  const update = (patch: Partial<UserSkillDraft>) => setDraft(value => ({ ...value, ...patch, updatedAt: new Date().toISOString() }));

  /** 规则编辑：任何改动都会让「已确认」回落为 AI 候选，必须重新确认。 */
  const updateRules = (field: 'coreRules' | 'blockers' | 'reviewRubric', items: string[]) => {
    setDraft(value => ({
      ...value,
      [field]: items,
      authoringState: value.authoringState === 'confirmed' ? 'ai_candidate' : value.authoringState,
      updatedAt: new Date().toISOString(),
    }));
    setRuleErrors([]);
  };

  const confirmRules = () => {
    const { errors } = validateAllRuleLists({
      coreRules: draft.coreRules, blockers: draft.blockers, reviewRubric: draft.reviewRubric,
    });
    if (errors.length) { setRuleErrors(errors); setError(''); return; }
    setDraft(value => ({
      ...value,
      coreRules: normalizeRuleList(value.coreRules),
      blockers: normalizeRuleList(value.blockers),
      reviewRubric: normalizeRuleList(value.reviewRubric),
      authoringState: 'confirmed',
      confirmedAt: new Date().toISOString(),
    }));
    setRuleErrors([]);
    setMessage('已确认当前规则，可前往「保存与发布」。');
  };

  const persist = async (next: UserSkillDraft) => {
    await api.saveUserSkill({
      id: next.id, name: next.name, domain: next.domain, version: next.version, status: next.status,
      sourceProjectId: next.sourceProjectId, sourceRevision: next.sourceRevision,
      authoringState: next.authoringState, dataJson: JSON.stringify(next),
    });
    props.onSaved?.(next);
  };

  const generalize = async () => {
    setBusy('ai'); setError(''); setMessage('');
    const result = await authorUserSkill(draft);
    if (!result.ok) setError(result.error);
    else {
      update({
        ...result.candidate, authoringState: 'ai_candidate',
        ai: { modelId: result.modelId, providerName: result.providerName, generalizedRevision: draft.sourceRevision, generatedAt: new Date().toISOString() },
      });
      setMessage('AI 已提炼出复用规则候选。来源事实没有被改写，请继续检查并确认。');
      setStep(3);
    }
    setBusy('');
  };

  const saveLocal = async () => {
    const normalized = {
      ...draft,
      coreRules: normalizeRuleList(draft.coreRules),
      blockers: normalizeRuleList(draft.blockers),
      reviewRubric: normalizeRuleList(draft.reviewRubric),
    };
    const errors = validateUserSkillDraft(normalized);
    if (errors.length) { setError(errors.join(' ')); return; }
    const next = { ...normalized, status: 'local' as const, updatedAt: new Date().toISOString() };
    setBusy('save'); setError('');
    try { await persist(next); setDraft(next); setMessage('已保存到技能工坊 → 我的技能。'); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(''); }
  };

  const applySample = async (input: {
    path: string; fileName: string; source: 'local' | 'gallery';
    taskId?: string; width?: number | null; height?: number | null;
  }) => {
    setSample({ ...input, width: input.width ?? null, height: input.height ?? null, thumb: undefined });
    try {
      const meta = await api.getImageMeta(input.path);
      setSample(current => current && current.path === input.path
        ? { ...current, width: meta.width, height: meta.height } : current);
    } catch { /* 尺寸获取失败不阻断选择，卡片显示「尺寸未知」 */ }
    try {
      const thumb = await api.readThumbnail(input.path);
      setSample(current => current && current.path === input.path ? { ...current, thumb } : current);
    } catch { /* 缩略图失败保留占位 */ }
  };

  const pickLocalSample = async () => {
    const path = await api.selectImageFile();
    if (!path) return;
    setAuthorized(false);
    await applySample({ path, fileName: fileName(path), source: 'local' });
  };

  const pickGallerySample = (image: ImageRecord) => {
    if (image.missing) return;
    setGalleryOpen(false);
    setAuthorized(false);
    void applySample({
      path: image.local_path, fileName: image.file_name, source: 'gallery',
      taskId: image.task_id, width: image.width, height: image.height,
    });
  };

  const viewSampleLarge = () => {
    if (!sample) return;
    useImageViewerStore.getState().openViewer(
      [{ id: sample.path, path: sample.path, title: 'Skill 公开样例', fileName: sample.fileName }], 0,
    );
  };

  /**
   * V6.3 选择封面（display-only）：只写 draft.cover 引用，随「保存 / 投稿」一起持久化；
   * 不进入投稿载荷（sanitizeUserSkillForSubmission 不含 cover），也不触碰 Recipe。
   */
  const pickCoverImage = (image: ImageRecord) => {
    if (image.missing) return;
    setCoverPickOpen(false);
    update({ cover: { source: 'library', path: image.local_path, assetId: image.id, updatedAt: new Date().toISOString() } });
  };

  const publish = async () => {
    if (!sample) { setError('请先选择一张公开样例。'); return; }
    if (!authorized) { setError('请先勾选公开展示授权确认。'); return; }
    // 投稿前置：规则必须由用户在「检查规则」页显式确认（publish 不再代为确认）
    const errors = validateUserSkillDraft({
      ...draft,
      samples: [{ id: 'pending', taskId: sample.taskId || props.project.generationIds?.[0] || '', imagePath: sample.path, selectedForSubmission: true, publicCover: true }],
    }, true);
    if (errors.length) { setError(errors.join(' ')); return; }
    setBusy('publish'); setError(''); setMessage('');
    let createdId = submissionId || draft.submissionId || '';
    try {
      const capability = await checkSubmissionCapability();
      if (!capability.ok) { setError(capability.failure?.message || '无法连接投稿服务，请稍后重试。'); return; }

      let targetId = createdId;
      if (!targetId) {
        try {
          const submission = await submitUserSkill(draft);
          targetId = submission.id;
        } catch (e: unknown) {
          if (e instanceof SubmissionFailureError && e.kind === 'duplicate') {
            // 同修订已有投稿（如上次样例上传失败残留）：找回记录继续补样例，不重复创建
            const existing = await findExistingSubmission(draft.id, draft.sourceRevision);
            if (!existing) throw e;
            targetId = existing.id;
            setMessage('检测到该修订已有投稿记录，已恢复并继续上传缺失样例。');
          } else throw e;
        }
      }
      // 投稿记录已创建即记住 ID：样例上传失败后重试直接复用，绝不二次创建
      createdId = targetId;
      setSubmissionId(targetId);

      const dataUrl = await api.readImageData(sample.path);
      await uploadSkillSample(targetId, sample.fileName, dataUrl, sample.taskId || props.project.generationIds?.[0] || '', true);

      const next: UserSkillDraft = { ...draft, status: 'submitted', submissionId: targetId, updatedAt: new Date().toISOString() };
      await persist(next);
      setDraft(next);
      setMessage('投稿已提交。后台审核通过后会进入公共技能库。');
    } catch (e: unknown) {
      const base = e instanceof SubmissionFailureError ? e.message : '投稿失败，当前本地 Skill 不受影响。';
      setError(createdId ? `${base}已保留投稿记录，可直接重试上传样例。` : base);
    } finally { setBusy(''); }
  };

  const published = draft.status === 'submitted';
  const publishDisabled = Boolean(busy) || !sample || !authorized || draft.authoringState !== 'confirmed' || published;

  return (
    <div className="skill-creator-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <section className={`skill-creator-dialog${galleryOpen ? ' is-picker-open' : ''}`} role="dialog" aria-modal="true" aria-label="保存为我的技能">
        <header className="skill-creator-header">
          <div><h2>Skill 创作器</h2><p>把一次视觉项目整理成能给不同素材重复使用的专业流程。</p></div>
          <button type="button" className="app-btn app-btn-ghost app-btn-sm" onClick={props.onClose}>关闭</button>
        </header>
        <div className="skill-creator-layout">
          <nav className="skill-creator-steps" aria-label="创作步骤">
            {STEPS.map((label, index) => <button key={label} type="button" className={index === step ? 'is-active' : index < step ? 'is-done' : ''} onClick={() => setStep(index)}><b>{index + 1}</b><span>{label}</span></button>)}
          </nav>
          <main className="skill-creator-main">
            <div className="skill-creator-title">
              {step === 0 && <><h3>用途与领域{draft.skillType === 'template_reuse' ? <span className="skill-type-badge is-template">模板复用 Skill</span> : <span className="skill-type-badge">通用流程 Skill</span>}</h3><p>名称与领域决定 Skill 在工坊中的检索入口。</p></>}
              {step === 1 && <><h3>来源事实</h3><p>由项目确定性提取；AI 只能抽象表达，不能改写，始终只读保留。</p></>}
              {step === 2 && <><h3>AI 提炼复用规则</h3><p>AI 只从只读来源事实中提炼规则与素材槽位（具体人物 → 人物槽位、具体文件 → 素材槽位）；你的项目方案仍是唯一执行来源，不会生成脱离项目的“通用 Skill”。</p></>}
              {step === 3 && <><h3>检查通用化规则</h3><p>逐行检查并确认；确认后再次编辑需要重新确认。</p>
                <div className="skill-rules-statusbar">
                  <span className={`skill-state-badge is-${draft.authoringState}`}>{AUTHORING_STATE_LABELS[draft.authoringState]}</span>
                  <span className="skill-rules-model">实际执行模型：{modelLabel || '尚未配置'}</span>
                </div>
              </>}
              {step === 4 && <><h3>保存与发布</h3><p>本地保存不上传任何图片；公开投稿仅上传净化快照与你选定的样例。</p></>}
            </div>
            <div className="skill-creator-body" key={step}>
              {step === 0 && <div className="skill-creator-form">
                {draft.skillType === 'template_reuse' && draft.recipe && (
                  <section className="skill-recipe-note" data-testid="skill-recipe-note">
                    <header>
                      <h4>模板复用方案</h4>
                      <span className="skill-recipe-badge">Recipe 已冻结</span>
                    </header>
                    <div className="skill-recipe-facts">
                      <div className="skill-recipe-fact">
                        <b>模板</b>
                        <span>@{draft.recipe.template?.displayName || fileName(draft.recipe.template?.path ?? '原图')}</span>
                      </div>
                      <div className="skill-recipe-fact">
                        <b>输入槽位</b>
                        <span>{draft.recipe.personContractTemplate ? '人物参考 · 可替换' : '无（沿用模板人物）'}</span>
                      </div>
                      <div className="skill-recipe-fact">
                        <b>冻结</b>
                        <span>
                          {`${draft.recipe.compilerSections.length} 个合同块`}
                          {draft.recipe.projectSnapshot?.renderingContract?.overallMode === 'mixed_media' ? ' · 混合媒介' : ''}
                          {draft.recipe.compilerSections.includes('anime_character') || draft.recipe.compilerSections.includes('detail_insert_sync') ? ' · 动漫角色一致性' : ''}
                          {draft.recipe.compilerSections.includes('expression_lock') ? ' · 表情锁定' : ''}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="skill-recipe-toggle"
                      aria-expanded={recipeExpanded}
                      onClick={() => setRecipeExpanded(value => !value)}
                    >{recipeExpanded ? '收起完整 Recipe' : '查看完整 Recipe'}</button>
                    {recipeExpanded && (
                      <div className="skill-recipe-detail" data-testid="skill-recipe-detail">
                        <p>
                          使用该 Skill 时会从保存时刻的完整生成方案重建项目——图片角色分工、人物替换、媒介分层、
                          动漫角色一致性、细节插图同步、表情锁定与模板保留合同全部同级保留，
                          并回到视觉工作台走同一条编译 / 校验 / 生成链路。使用时只需确认模板图（固定自带），并可换绑人物身份参考。
                        </p>
                        <ul>
                          {draft.recipe.compilerSections.map((block, index) => <li key={`${block}-${index}`}>{skillOriginSectionLabel(block)}</li>)}
                        </ul>
                        <p className="skill-recipe-privacy">完整方案快照（含模板图本地路径）只保存在本机，公开投稿仅携带净化后的文本规则。</p>
                      </div>
                    )}
                  </section>
                )}
                <label>Skill 名称<input value={draft.name} onChange={e => update({ name: e.target.value })} /></label>
                <label>专业领域<select value={draft.domain} onChange={e => update({ domain: e.target.value as UserSkillDraft['domain'] })}>{Object.entries(DOMAIN_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
                <label>适用说明<textarea rows={4} value={draft.summary} onChange={e => update({ summary: e.target.value })} /></label>
                {draft.skillType === 'template_reuse' && (
                  <>
                    <label data-testid="skill-execution-mode-field">
                      默认执行方式
                      <select
                        value={draft.executionMode}
                        onChange={e => update({ executionMode: e.target.value as SkillExecutionMode })}
                      >
                        {Object.entries(SKILL_EXECUTION_MODE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </label>
                    <label data-testid="skill-optimization-policy-field">
                      Prompt 策略
                      <select
                        value={draft.optimizationPolicy}
                        onChange={e => update({ optimizationPolicy: e.target.value as SkillOptimizationPolicy })}
                      >
                        {Object.entries(SKILL_OPTIMIZATION_POLICY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </label>
                    <p className="skill-execution-policy-hint">
                      快速生成 = 复用冻结方案直达报价确认（零 AI 优化调用）；高级调整 = 进视觉工作台查看全部合同与技能过程。
                    </p>
                  </>
                )}
              </div>}

              {step === 1 && <div className="skill-fact-section">
                {factGroups.map(group => (
                  <section className="skill-fact-group" key={group.id}>
                    <header><h4>{group.label}</h4><span className="skill-fact-count">{group.facts.length} 项</span></header>
                    <div className="skill-fact-list">
                      {group.facts.map(fact => {
                        const expandable = isLongFact(fact.value);
                        const expanded = expandedFacts.has(fact.key);
                        return (
                          <div className="skill-fact-row" key={fact.key}>
                            <div className="skill-fact-head">
                              <span className="skill-fact-label">{fact.label}</span>
                              <em className="skill-fact-readonly" title="来源事实只读，AI 通用化不会修改原值">只读</em>
                            </div>
                            <p className={`skill-fact-value${expandable && !expanded ? ' is-clamped' : ''}`}>{fact.value}</p>
                            {expandable && (
                              <button type="button" className="skill-fact-toggle" aria-expanded={expanded} onClick={() => setExpandedFacts(current => {
                                const next = new Set(current);
                                if (next.has(fact.key)) next.delete(fact.key); else next.add(fact.key);
                                return next;
                              })}>{expanded ? '收起' : '展开'}</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
                {factGroups.length === 0 && <p className="skill-rule-empty">当前项目没有可提取的来源事实。</p>}
              </div>}

              {step === 2 && <div className="skill-ai-stage">
                <div className="skill-model-note">实际执行模型：{modelLabel || '尚未配置'}</div>
                <p>AI 基于只读来源事实提炼复用规则候选：具体人物 → 人物槽位、具体文件 → 素材槽位，并分离不可破坏的核心规则与可选配置。来源事实不会被改写，提炼结果仍需你在下一步逐行确认。</p>
                <button type="button" className="app-btn app-btn-primary" disabled={busy === 'ai' || !modelLabel} onClick={() => void generalize()}>{busy === 'ai' ? '正在提炼…' : '开始 AI 提炼复用规则'}</button>
              </div>}

              {step === 3 && <div className="skill-rules-section">
                {ruleErrors.length > 0 && (
                  <div className="skill-rules-errors" role="alert">
                    {ruleErrors.map(item => <p key={item}>{item}</p>)}
                  </div>
                )}
                <RuleCard
                  title="不可破坏的核心规则" hint="无论素材如何替换都必须保持的构图 / 镜头 / 媒介关系。"
                  items={draft.coreRules} onChange={items => updateRules('coreRules', items)}
                />
                <RuleCard
                  title="生成前阻断条件" hint="触发即停止生成、要求用户先补齐条件（可为空）。"
                  items={draft.blockers} onChange={items => updateRules('blockers', items)}
                />
                <RuleCard
                  title="质检标准" hint="样例与审核共同使用的质量判定维度。"
                  items={draft.reviewRubric} onChange={items => updateRules('reviewRubric', items)}
                />
                <div className="skill-rules-actions">
                  <button
                    type="button" className="app-btn app-btn-brand-soft"
                    disabled={draft.authoringState === 'confirmed'}
                    onClick={confirmRules}
                  >{draft.authoringState === 'confirmed' ? '已确认当前规则' : '确认当前规则'}</button>
                </div>
              </div>}

              {step === 4 && <div className="skill-publish-section">
                <div className="skill-publish-summary">
                  <h4>发布模式</h4>
                  <p><b>本地使用：</b>立即进入“我的技能”，可继续编辑，不上传任何原图。</p>
                  <p><b>公开投稿：</b>仅上传净化后的不可变 Skill 快照，以及你主动选择的一张生成样例。</p>
                </div>
                {risks.length > 0 && <div className="skill-risk-note">投稿净化：{risks.join('；')}</div>}
                {!published && (submissionId || draft.submissionId) && (
                  <div className="skill-resume-note">检测到未完成的投稿记录，点击「提交公开审核」将继续上传缺失样例，不会重复创建投稿。</div>
                )}
                <section className="skill-publish-card skill-cover-card" data-testid="skill-cover-card">
                  <header>
                    <h4>Skill 封面</h4>
                    <p>只用于「我的技能」卡片展示：优先显示你选择的封面，其次是公开样例、模板图。不影响模板、生成方案与已提交的审核内容。</p>
                  </header>
                  <div className="skill-sample-card">
                    {coverThumb
                      ? <img className="skill-sample-thumb" src={coverThumb} alt="" />
                      : <span className="skill-sample-thumb is-placeholder" aria-hidden="true">◇</span>}
                    <div className="skill-sample-meta">
                      <b className="skill-sample-name">
                        {draft.cover && (draft.cover.source === 'library' || draft.cover.source === 'custom')
                          ? '自定义封面'
                          : coverPath && coverPath === coverSamplePath
                            ? '公开生成样例'
                            : coverPath
                              ? '模板图'
                              : '类型图标（无可用图片）'}
                      </b>
                      <span className="skill-sample-dim">
                        {coverPath ? fileName(coverPath) : '将显示 Skill 类型图标'}
                      </span>
                    </div>
                    <div className="skill-sample-ops">
                      <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => setCoverPickOpen(true)}>
                        {draft.cover && draft.cover.source !== 'template' ? '更换封面' : '从图片库选择封面'}
                      </button>
                      {draft.cover && draft.cover.source !== 'template' && (
                        <button
                          type="button"
                          className="app-btn app-btn-secondary app-btn-sm"
                          onClick={() => update({ cover: { source: 'template' } })}
                        >恢复默认（模板图）</button>
                      )}
                    </div>
                  </div>
                </section>
                <section className="skill-publish-card">
                  <header>
                    <h4>公开样例</h4>
                    <p>{published ? '投稿已携带以下样例，进入后台审核流程。' : '公开投稿需要选择一张你有权公开的成功生成图（本地保存不需要样例）。'}</p>
                  </header>
                  {sample ? (
                    <div className="skill-sample-card">
                      {sample.thumb
                        ? <img className="skill-sample-thumb" src={sample.thumb} alt={sample.fileName} onClick={viewSampleLarge} />
                        : <span className="skill-sample-thumb is-placeholder">…</span>}
                      <div className="skill-sample-meta">
                        <b className="skill-sample-name" title={sample.fileName}>{sample.fileName}</b>
                        <div className="skill-sample-tags">
                          <span className="skill-sample-source-badge">{sample.source === 'gallery' ? '图片库' : '本地'}</span>
                          <span className="skill-sample-dim">
                            {sample.width && sample.height ? `${sample.width}×${sample.height}` : '尺寸未知'}{fileFormat(sample.path) ? ` · ${fileFormat(sample.path)}` : ''}
                          </span>
                        </div>
                      </div>
                      <div className="skill-sample-ops">
                        <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => setGalleryOpen(true)}>更换</button>
                        <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={viewSampleLarge}>查看大图</button>
                        <button type="button" className="app-btn app-btn-danger app-btn-sm" onClick={() => { setSample(null); setAuthorized(false); }}>移除</button>
                      </div>
                    </div>
                  ) : (
                    <div className="skill-sample-empty">
                      <p>公开投稿需要选择一张你有权公开的成功生成图（本地保存不需要样例）。</p>
                      <div className="skill-sample-entry">
                        <button type="button" className="app-btn app-btn-secondary" onClick={() => void pickLocalSample()}>从本地选择</button>
                        <button type="button" className="app-btn app-btn-secondary" onClick={() => setGalleryOpen(true)}>从图片库选择</button>
                      </div>
                    </div>
                  )}
                </section>
                <label className={`skill-authorize-check${sample ? '' : ' is-disabled'}`}>
                  <input
                    type="checkbox" checked={authorized} disabled={!sample || published}
                    onChange={e => setAuthorized(e.target.checked)}
                  />
                  <span>我确认拥有该图片的公开展示权，并同意审核通过后将其作为 Skill 示例展示。</span>
                </label>
                <div className="skill-publish-status">
                  <span>当前状态：{published ? '已提交公开审核（投稿 ID 已记录），后台审核通过后进入公共技能库。' : draft.authoringState === 'confirmed' ? '规则已确认，可保存到本地或提交公开审核。' : '规则尚未确认——提交公开审核前需在「检查规则」页确认。'}</span>
                </div>
              </div>}
            </div>

            <div className="skill-creator-footer">
              {(error || message) && (
                <div className="skill-creator-status">
                  {error && <div className="skill-creator-message is-error" role="alert">{error}</div>}
                  {message && <div className="skill-creator-message is-success">{message}</div>}
                </div>
              )}
              <div className="skill-creator-footer-row">
                <button type="button" className="app-btn app-btn-secondary" disabled={step === 0 || Boolean(busy)} onClick={() => setStep(value => Math.max(0, value - 1))}>上一步</button>
                <div className="skill-creator-footer-group">
                  {step === 4 && (
                    <>
                      <button type="button" className="app-btn app-btn-secondary" disabled={Boolean(busy) || published} onClick={() => void saveLocal()}>{busy === 'save' ? '保存中…' : '仅保存到我的技能'}</button>
                      <button type="button" className="app-btn app-btn-primary" disabled={publishDisabled} title={draft.authoringState !== 'confirmed' ? '请先在「检查规则」页确认当前规则' : undefined} onClick={() => void publish()}>{busy === 'publish' ? '正在提交…' : published ? '已提交公开审核' : '提交公开审核'}</button>
                    </>
                  )}
                  {step < 4 && <button type="button" className="app-btn app-btn-primary" onClick={() => setStep(value => Math.min(4, value + 1))}>下一步</button>}
                </div>
              </div>
            </div>
          </main>
        </div>
      </section>
      <ImageLibraryPicker
        open={galleryOpen}
        title="选择 Skill 公开样例"
        onClose={() => setGalleryOpen(false)}
        onPick={pickGallerySample}
      />
      {/* V6.3 封面选择：独立实例（Escape 各自消化，不关弹窗本体） */}
      <ImageLibraryPicker
        open={coverPickOpen}
        title="选择 Skill 封面"
        onClose={() => setCoverPickOpen(false)}
        onPick={pickCoverImage}
      />
    </div>
  );
}
