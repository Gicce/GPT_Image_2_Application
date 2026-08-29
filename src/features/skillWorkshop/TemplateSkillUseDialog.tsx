/**
 * 模板复用 Skill 使用弹窗（V6.3 Direct Skill UX Closure）：
 * - 双执行方式：「快速生成」（headless 直接生成，零 AI 优化调用，直达图片工作室
 *   报价确认——QuoteConfirmDialog 单一计费授权入口）与「高级调整」（重建项目
 *   写入 store → 进入视觉工作台，行为与 V6 完全一致）；
 * - Slot Contract V2：输入槽位由 Recipe 修改合同派生——「人物 + 服装来自人物
 *   参考」合并为一个 combined slot（一张图同时提供身份与服装）；自定义服装
 *   出现文本槽（预填保存描述）；保留模板服装不出现服装输入；
 * - Preflight Status Card：ready / repairable / needs_input / blocked 四态高可见，
 *   可修复阻断直接给「立即识别局部插图」，绝不默认建议「重新优化 Prompt」；
 * - 换素材 = 重绑定 + 确定性重编译（重建时丢弃旧实例优化增量），零 AI 调用；
 * - ephemeral 会话：快速生成不创建持久项目；「保存为视觉项目」在图片工作室
 *   banner 提供（skillSession.project 随 carry 带入）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import ImageLibraryPicker from '../../components/ImageLibraryPicker';
import type { ImageRecord } from '../../types';
import { api } from '../../services/api';
import { useImageViewerStore } from '../../store/useImageViewerStore';
import { useVisualProjectStore } from '../../store/useVisualProjectStore';
import { useDraftStore } from '../../store/useDraftStore';
import { useRuntimeSkillStore } from '../../store/useRuntimeSkillStore';
import { resolveByokVisionConfig } from '../aiProviders/store';
import { runtimeSkillById } from '../vision/skills/registry';
import { skillOriginSectionLabel } from '../vision/project/skillOriginGuard';
import type { VisualProject } from '../vision/project/types';
import {
  detailRepairElapsedSeconds,
  detailRepairStageLabel,
  runDetailInsertRepair,
  type DetailRepairProgress,
} from '../vision/project/detailInsertRepairRunner';
import {
  applyDetailInsertRepairToEphemeral,
  buildEphemeralSkillProject,
  classifySkillDirectPreflight,
  executeTemplateSkillDirect,
  preflightSkillDirectExecution,
  SKILL_OPTIMIZATION_POLICY_LABELS,
  type SkillDirectBlocker,
  type SkillDirectPreflightStatus,
} from './skillDirectExecution';
import {
  buildProjectFromSkillRecipe,
  deriveSkillInputSlots,
  skillPersonSlotRequired,
  type SkillPersonBinding,
} from './skillRecipe';
import type { UserSkillDraft } from './userSkill';
import './TemplateSkillUseDialog.css';

interface PersonSelection {
  path: string;
  label: string;
  assetId?: string;
  source: 'gallery' | 'local';
  thumb?: string;
}

function fileName(path: string) { return path.split(/[\\/]/).pop() || path; }

const REPAIR_STAGES: DetailRepairProgress['stage'][] = ['preparing', 'recognizing', 'merging', 'validating'];

export default function TemplateSkillUseDialog(props: {
  draft: UserSkillDraft;
  onClose: () => void;
}) {
  const recipe = props.draft.recipe && props.draft.recipe.skillType === 'template_reuse'
    ? props.draft.recipe
    : null;
  // Slot Contract V2：输入槽位由修改合同派生（combined / 独立 / 文本 / 无）
  const slots = useMemo(() => (recipe ? deriveSkillInputSlots(recipe) : []), [recipe]);
  const personSlot = slots.find(slot => slot.id === 'person') ?? null;
  const clothingTextSlot = slots.find(slot => slot.id === 'clothing_text') ?? null;
  const [person, setPerson] = useState<PersonSelection | null>(null);
  const [clothingText, setClothingText] = useState(() => clothingTextSlot?.defaultText ?? '');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [templateThumb, setTemplateThumb] = useState('');
  const [templateCheck, setTemplateCheck] = useState<'checking' | 'ok' | 'missing'>('checking');
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // V6.2 Direct Execution：ephemeral 项目（不写 store）+ preflight + 内嵌 Repair
  const [ephemeralProject, setEphemeralProject] = useState<VisualProject | null>(null);
  const [repairProgress, setRepairProgress] = useState<DetailRepairProgress | null>(null);
  const [repairNow, setRepairNow] = useState(() => Date.now());
  const repairCancelRef = useRef(false);

  const galleryOpenRef = useRef(false);
  galleryOpenRef.current = galleryOpen;

  const repairRunning = repairProgress?.status === 'running';

  // 弹窗打开期间锁定背景滚动；Escape 关闭（图库选择器 / Repair 在途时让位）
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !galleryOpenRef.current && !repairRunning) props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose, repairRunning]);

  // 模板资产就绪校验 + 缩略图（缺失即阻断执行——绝不带着坏模板直接生成）
  useEffect(() => {
    let cancelled = false;
    if (!recipe?.template) { setTemplateCheck('missing'); return; }
    const path = recipe.template.path;
    void api.getImageMeta(path)
      .then(() => { if (!cancelled) setTemplateCheck('ok'); })
      .catch(() => { if (!cancelled) setTemplateCheck('missing'); });
    void api.readThumbnail(path)
      .then(thumb => { if (!cancelled && thumb) setTemplateThumb(thumb); })
      .catch(() => { /* 缩略图失败不阻断（占位显示） */ });
    return () => { cancelled = true; };
  }, [recipe?.template]);

  // ephemeral 项目：Recipe + 槽位绑定 → 内存项目（快速生成 / Preflight / 内嵌 Repair 共用）。
  // 换素材只重绑定 + 确定性重编译（重建时已丢弃旧实例优化增量），绝不触发重新优化。
  useEffect(() => {
    if (!recipe) { setEphemeralProject(null); return; }
    const personBinding: SkillPersonBinding | undefined = person
      ? {
        path: person.path,
        label: person.label,
        source: person.source,
        ...(person.assetId ? { assetId: person.assetId } : {}),
      }
      : undefined;
    const built = buildEphemeralSkillProject({
      draft: props.draft,
      person: personBinding,
      ...(clothingTextSlot ? { customClothing: clothingText } : {}),
    });
    setEphemeralProject(built.ok ? built.project : null);
    setRepairProgress(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, person?.path, person?.assetId, clothingTextSlot ? clothingText : null]);

  // 内嵌 Repair 已用时：运行中每秒重算（runner 内不持有定时器）
  useEffect(() => {
    if (!repairRunning) return;
    const timer = window.setInterval(() => setRepairNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [repairRunning]);

  const preflight = useMemo(
    () => (ephemeralProject
      ? preflightSkillDirectExecution({
        project: ephemeralProject,
        personRequired: recipe ? skillPersonSlotRequired(recipe) : false,
      })
      : null),
    [ephemeralProject, recipe],
  );
  const repairableBlocker: SkillDirectBlocker | null =
    preflight?.blockers.find(blocker => blocker.repairable === 'detail_insert') ?? null;
  const preflightStatus: SkillDirectPreflightStatus | null = preflight
    ? (templateCheck === 'missing' ? 'blocked' : classifySkillDirectPreflight(preflight))
    : null;
  const directReady = templateCheck === 'ok' && !!ephemeralProject && !!preflight?.ok;
  const optimizationPolicy = props.draft.optimizationPolicy ?? 'reuse_recipe';

  if (!recipe) return null;

  const bindPerson = async (input: Omit<PersonSelection, 'thumb'>) => {
    if (repairRunning) return;
    setPerson({ ...input, thumb: undefined });
    try {
      const thumb = await api.readThumbnail(input.path);
      setPerson(current => current && current.path === input.path ? { ...current, thumb } : current);
    } catch { /* 缩略图失败保留占位 */ }
  };

  const pickLocalPerson = async () => {
    const path = await api.selectImageFile();
    if (!path) return;
    await bindPerson({ path, label: fileName(path), source: 'local' });
  };

  const pickGalleryPerson = async (image: ImageRecord) => {
    setGalleryOpen(false);
    await bindPerson({ path: image.local_path, label: image.file_name, assetId: image.id, source: 'gallery' });
  };

  const viewImage = (path: string, label: string) => {
    useImageViewerStore.getState().openViewer(
      [{ id: path, path, title: label, fileName: fileName(path) }], 0,
    );
  };

  const skillNames = recipe.runtimeSkillIds
    .map(id => runtimeSkillById(id)?.name)
    .filter((name): name is string => Boolean(name));

  /** 快速生成：headless 直接管线（同步、零 AI 调用）→ carry + 图片工作室报价确认。 */
  const runDirectGenerate = () => {
    if (busy || repairRunning || !directReady) return;
    setBusy(true); setError('');
    try {
      const result = executeTemplateSkillDirect({
        draft: props.draft,
        ...(person
          ? {
            person: {
              path: person.path,
              label: person.label,
              source: person.source,
              ...(person.assetId ? { assetId: person.assetId } : {}),
            },
          }
          : {}),
        optimizationPolicy,
        regionContractDisabled: useRuntimeSkillStore.getState().isSkillDisabled('region_replacement'),
        ...(ephemeralProject ? { project: ephemeralProject } : {}),
        ...(clothingTextSlot ? { customClothing: clothingText } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      useDraftStore.getState().setVisionCarry(result.carry);
      props.onClose();
      window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'imagestudio' } }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '快速生成失败。');
    } finally {
      setBusy(false);
    }
  };

  /** 高级调整：V6 原路径——重建项目写入 store → 视觉工作台（字面同源）。 */
  const openReuseProject = async () => {
    if (templateCheck !== 'ok') {
      setError('模板图不可读：请确认模板文件仍在原路径，或回到来源项目重新保存 Skill。');
      return;
    }
    setBusy(true); setError('');
    try {
      const personBinding: SkillPersonBinding | undefined = person
        ? { path: person.path, label: person.label, source: person.source, ...(person.assetId ? { assetId: person.assetId } : {}) }
        : undefined;
      const project = buildProjectFromSkillRecipe(recipe, {
        skill: {
          id: props.draft.id,
          name: props.draft.name,
          sourceProjectId: props.draft.sourceProjectId,
          sourceRevision: props.draft.sourceRevision,
        },
        person: personBinding,
        ...(clothingTextSlot ? { customClothing: clothingText } : {}),
      });
      if (!project) {
        setError('Skill 方案快照不完整，无法创建复用项目。请回到来源项目重新保存 Skill。');
        return;
      }
      const store = useVisualProjectStore.getState();
      await store.flushPersist();
      await store.adoptProject(project);
      // 挂载恢复关键：先把工作区 hydrate 成新项目（页面挂载不再自动 hydrate）
      store.hydrateWorkspaceFromActive();
      window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'vision' } }));
      props.onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '创建复用项目失败。');
    } finally {
      setBusy(false);
    }
  };

  /** 弹窗内嵌 Repair：同一 Runner，合并到 ephemeral 项目文档（不进项目 store）。 */
  const runEmbeddedRepair = async () => {
    const project = ephemeralProject;
    if (!project || repairRunning) return;
    repairCancelRef.current = false;
    setRepairProgress(null);
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => {
        const resolved = resolveByokVisionConfig({
          profileId: project.workspace.profileId || undefined,
          modelId: project.workspace.modelId || undefined,
        });
        return resolved.ok
          ? { ok: true as const, config: { baseUrl: resolved.baseUrl, token: resolved.token, model: resolved.model } }
          : { ok: false as const, error: resolved.error };
      },
      onProgress: setRepairProgress,
      isCancelled: () => repairCancelRef.current,
      applyResults: results => {
        const applied = applyDetailInsertRepairToEphemeral(project, results);
        if (!applied.applied) return { applied: false, error: applied.error };
        setEphemeralProject(applied.project);
        return { applied: true, summary: applied.summary };
      },
    });
    if (final.status === 'error') setError(final.error ?? '局部插图识别失败。');
  };

  const repairStageIndex = repairProgress ? REPAIR_STAGES.indexOf(repairProgress.stage) : -1;

  return (
    <div
      className="skill-use-overlay" role="presentation"
      onMouseDown={e => { if (e.target === e.currentTarget && !repairRunning) props.onClose(); }}
    >
      <section className="skill-use-dialog" role="dialog" aria-modal="true" aria-label={`使用模板复用 Skill ${props.draft.name}`}>
        <header className="skill-use-header">
          <div>
            <h2>使用模板复用 Skill</h2>
            <p>「{props.draft.name}」——绑定素材后按保存时的完整生成方案（合同 / 媒介 / 角色一致性 / 表情锁定）出图：快速生成直达报价确认，高级调整进视觉工作台。</p>
          </div>
          <button type="button" className="app-btn app-btn-ghost app-btn-sm" onClick={props.onClose} disabled={repairRunning}>关闭</button>
        </header>

        <div className="skill-use-body">
          {/* ===== 槽位 1：固定模板图 ===== */}
          <section className="skill-use-slot">
            <header>
              <h4>画面模板图 <span className="skill-use-badge is-fixed">固定自带</span></h4>
              <span className={`skill-use-badge is-${templateCheck}`}>
                {templateCheck === 'checking' ? '校验中…' : templateCheck === 'ok' ? '可用' : '文件不可读'}
              </span>
            </header>
            <div className="skill-use-asset">
              {templateThumb
                ? <img className="skill-use-thumb" src={templateThumb} alt={fileName(recipe.template?.path ?? '')} onClick={() => recipe.template && viewImage(recipe.template.path, '画面模板图')} />
                : <span className="skill-use-thumb is-placeholder">{templateCheck === 'ok' ? '…' : '⚠'}</span>}
              <div className="skill-use-asset-meta">
                <b title={recipe.template?.path}>{fileName(recipe.template?.path ?? '')}</b>
                <p>{recipe.projectSnapshot?.renderingContract?.overallMode === 'mixed_media'
                  ? '混合媒介模板：各媒介层（真人 / 动漫 / 插图 / 平面装饰）将按保存结构保持。'
                  : '模板九维度基线（构图 / 镜头 / 背景 / 光线 / 风格 / 姿态）将按保存快照锁定。'}</p>
              </div>
            </div>
            {templateCheck === 'missing' && (
              <p className="skill-use-warn" role="alert">模板文件已移动或删除。复用必须携带模板图——请恢复文件路径，或回到来源项目重新保存 Skill。</p>
            )}
          </section>

          {/* ===== 槽位 2：人物参考（Slot Contract V2 派生：身份 / 身份+服装） ===== */}
          {personSlot && (
            <section className="skill-use-slot" data-testid="skill-use-person-slot">
              <header>
                <h4>
                  {personSlot.label}
                  {personSlot.usage === 'identity_clothing' && (
                    <>
                      <span className="skill-use-badge is-usage">人物身份</span>
                      <span className="skill-use-badge is-usage">服装来源</span>
                    </>
                  )}
                  <span className={`skill-use-badge ${personSlot.required ? 'is-required' : ''}`}>
                    {personSlot.required ? '必选' : '可选'}
                  </span>
                </h4>
                {recipe.personContractTemplate && (
                  <span className="skill-use-hint">
                    换人复用（强度：{recipe.personContractTemplate.strength === 'strict' ? '严格' : recipe.personContractTemplate.strength === 'balanced' ? '均衡' : '自然'}）
                  </span>
                )}
              </header>
              {person ? (
                <div className="skill-use-asset">
                  {person.thumb
                    ? <img className="skill-use-thumb" src={person.thumb} alt={person.label} onClick={() => viewImage(person.path, personSlot.label)} />
                    : <span className="skill-use-thumb is-placeholder">…</span>}
                  <div className="skill-use-asset-meta">
                    <b title={person.path}>{person.label}</b>
                    <p>{personSlot.description}</p>
                  </div>
                  <div className="skill-use-asset-ops">
                    <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={repairRunning} onClick={() => setGalleryOpen(true)}>更换</button>
                    <button type="button" className="app-btn app-btn-danger app-btn-sm" disabled={repairRunning} onClick={() => setPerson(null)}>移除</button>
                  </div>
                </div>
              ) : (
                <div className="skill-use-asset is-empty">
                  <p>{personSlot.required
                    ? '本 Skill 的人物替换与服装都来自这张参考图，绑定后才能快速生成。'
                    : '不绑定则沿用模板原人物。绑定后可换任何人物——生成会走同一条人物替换合同链（快速生成只重编译绑定，不重新优化 Prompt）。'}</p>
                  <div className="skill-use-asset-ops">
                    <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={repairRunning} onClick={() => setGalleryOpen(true)}>从图片库选择</button>
                    <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={repairRunning} onClick={() => void pickLocalPerson()}>从本地选择</button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ===== 槽位 3：服装要求（clothingPolicy = custom 时的文本槽） ===== */}
          {clothingTextSlot && (
            <section className="skill-use-slot" data-testid="skill-use-clothing-text-slot">
              <header>
                <h4>服装要求 <span className="skill-use-badge is-required">必填</span></h4>
                <span className="skill-use-hint">{clothingTextSlot.description}</span>
              </header>
              <textarea
                className="skill-use-clothing-text"
                rows={3}
                disabled={repairRunning}
                value={clothingText}
                placeholder="描述本次生成的服装 / 造型（留空将无法快速生成）"
                onChange={e => setClothingText(e.target.value)}
              />
            </section>
          )}

          {/* ===== Preflight Status Card（状态高可见：Ready / 差一步 / 需输入 / 阻断） ===== */}
          {preflight && preflightStatus && (
            <section
              className={`skill-use-status is-${preflightStatus}`}
              role={preflightStatus === 'ready' ? 'status' : 'alert'}
              data-testid={`skill-use-status-${preflightStatus}`}
            >
              {preflightStatus === 'ready' && (
                <>
                  <header><h4>✓ 可以快速生成</h4><span className="skill-use-status-note">复用保存方案 · 零 AI 优化调用</span></header>
                  <ul className="skill-use-status-checklist">
                    <li className={templateCheck === 'ok' ? 'is-ok' : ''}>模板：可用</li>
                    {personSlot && (
                      <li className={person ? 'is-ok' : ''}>
                        人物：{person ? `已绑定${personSlot.usage === 'identity_clothing' ? '（身份 + 服装）' : ''}` : '沿用模板原人物'}
                      </li>
                    )}
                    {clothingTextSlot && (
                      <li className={clothingText.trim() ? 'is-ok' : ''}>服装：自定义要求已填写</li>
                    )}
                    {!personSlot && !clothingTextSlot && <li className="is-ok">服装：沿用模板</li>}
                    <li className="is-ok">合同：完整（编译 / 校验 / 报价前确认）</li>
                  </ul>
                </>
              )}
              {preflightStatus === 'repairable' && (
                <>
                  <header><h4>快速生成还差 1 步</h4><span className="skill-use-status-note">处理完自动回到可生成状态</span></header>
                  <ul>
                    {preflight.blockers.map((blocker, index) => (
                      <li key={`${blocker.code}-${index}`}><b>局部插图</b><span>{blocker.message}</span></li>
                    ))}
                  </ul>
                  {repairableBlocker && !repairRunning && (
                    <div className="skill-use-status-actions">
                      <button type="button" className="app-btn app-btn-brand-soft app-btn-sm" onClick={() => void runEmbeddedRepair()}>
                        立即识别局部插图
                      </button>
                    </div>
                  )}
                </>
              )}
              {preflightStatus === 'needs_input' && (
                <>
                  <header><h4>快速生成前需要你选择</h4><span className="skill-use-status-note">这是业务输入，不是错误</span></header>
                  <ul>
                    {preflight.blockers.map((blocker, index) => (
                      <li key={`${blocker.code}-${index}`}><b>{blocker.code === 'clothing' ? '服装要求' : '人物参考'}</b><span>{blocker.message}</span></li>
                    ))}
                  </ul>
                  <div className="skill-use-status-actions">
                    {preflight.blockers.some(blocker => blocker.code === 'needs_input') && (
                      <button type="button" className="app-btn app-btn-brand-soft app-btn-sm" disabled={repairRunning} onClick={() => setGalleryOpen(true)}>
                        选择人物参考
                      </button>
                    )}
                  </div>
                </>
              )}
              {preflightStatus === 'blocked' && (
                <>
                  <header><h4>快速生成暂不可用</h4><span className="skill-use-status-note">方案级问题需在视觉工作台处理</span></header>
                  <ul>
                    {preflight.blockers.map((blocker, index) => (
                      <li key={`${blocker.code}-${index}`}>
                        <b>{blocker.code === 'detail_insert_incomplete' ? '局部插图' : blocker.code === 'anime_character_required' ? '动漫一致性' : '方案校验'}</b>
                        <span>{blocker.message}</span>
                      </li>
                    ))}
                  </ul>
                  {preflight.blockers.some(blocker => blocker.code === 'anime_character_required') && (
                    <p className="skill-use-status-hint">动漫角色参考图只能在工作台生成（直接生成绝不后台调模型）。</p>
                  )}
                  <div className="skill-use-status-actions">
                    <button
                      type="button"
                      className="app-btn app-btn-secondary app-btn-sm"
                      disabled={busy || repairRunning || templateCheck !== 'ok'}
                      onClick={() => void openReuseProject()}
                    >
                      进入工作台处理
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {/* ===== 内嵌 Repair：与视觉工作台 Rail 同一执行体（零平行系统） ===== */}
          {repairProgress && (
            <section className="skill-use-repair" aria-live="polite">
              <header>
                <h4>补充识别局部插图</h4>
                <span className={`skill-use-badge is-repair-${repairProgress.status}`}>
                  {repairProgress.status === 'running' ? '识别中' : repairProgress.status === 'success' ? '已完成' : repairProgress.status === 'cancelled' ? '已停止' : '失败'}
                </span>
              </header>
              {repairProgress.status === 'running' ? (
                <>
                  <p>
                    阶段 {Math.max(1, repairStageIndex + 1)}/4：{detailRepairStageLabel(repairProgress.stage)}
                    {repairProgress.stage === 'recognizing' && repairProgress.totalRegions > 0
                      ? `（第 ${Math.min(repairProgress.completedRegions + 1, repairProgress.totalRegions)}/${repairProgress.totalRegions} 层）` : ''}
                    ，已用时 {detailRepairElapsedSeconds(repairProgress, repairNow)} 秒。
                  </p>
                  <p className="skill-use-repair-note">识别只补全局部插图实例，不会改变你当前的人物、服装、动作与方案。</p>
                  <div className="skill-use-repair-bar" aria-hidden="true" />
                  <div className="skill-use-asset-ops">
                    <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => { repairCancelRef.current = true; }}>
                      停止识别
                    </button>
                  </div>
                </>
              ) : (
                <p className={repairProgress.status === 'error' ? 'skill-use-repair-failed' : 'skill-use-repair-done'}>
                  {repairProgress.status === 'error'
                    ? repairProgress.error ?? '局部插图识别失败，旧分析已保留。'
                    : repairProgress.summary ?? '识别结束。'}
                </p>
              )}
            </section>
          )}

          {/* ===== 方案概要：继承技能 + 合同块 + 执行策略 ===== */}
          <section className="skill-use-summary">
            <header><h4>复用方案概要</h4></header>
            <dl>
              <div><dt>继承技能</dt><dd>{skillNames.length > 0 ? skillNames.join('、') : '核心技能恒执行（人物替换 / 媒介保持 / 编译 / 校验等）'}</dd></div>
              <div><dt>合同块</dt><dd>{recipe.compilerSections.map(skillOriginSectionLabel).join(' → ') || '—'}</dd></div>
              <div><dt>Prompt 策略</dt><dd>{SKILL_OPTIMIZATION_POLICY_LABELS[optimizationPolicy]}</dd></div>
              {recipe.projectSnapshot?.templateSnapshot?.subjectPoses?.length ? (
                <div><dt>主体姿态基线</dt><dd>{recipe.projectSnapshot.templateSnapshot.subjectPoses.length} 个主体（分主体锁定）</dd></div>
              ) : null}
              {recipe.savedAt && <div><dt>保存时间</dt><dd>{recipe.savedAt.slice(0, 19).replace('T', ' ')}</dd></div>}
            </dl>
          </section>

          {/* ===== 保存基线 Prompt（对比 / 审阅） ===== */}
          {recipe.baselineFinalPrompt.trim() && (
            <section className="skill-use-baseline">
              <button type="button" className="skill-use-baseline-toggle" aria-expanded={baselineOpen} onClick={() => setBaselineOpen(v => !v)}>
                {baselineOpen ? '收起保存时基线 Prompt' : `查看保存时基线 Prompt（${recipe.baselineFinalPrompt.length} 字）`}
              </button>
              {baselineOpen && (
                <textarea className="skill-use-baseline-text" readOnly rows={12} value={recipe.baselineFinalPrompt} />
              )}
            </section>
          )}
        </div>

        <footer className="skill-use-footer">
          {error && <div className="skill-use-error" role="alert">{error}</div>}
          <div className="skill-use-footer-row">
            <span className="skill-use-note">
              {directReady
                ? '快速生成：复用保存方案与合同，零 AI 优化，进入图片工作室后自动发起（先确认报价）。'
                : preflightStatus === 'repairable'
                  ? '快速生成还差 1 步——在上方状态卡处理后即可直接生成，无需进入高级调整。'
                  : preflightStatus === 'needs_input'
                    ? '快速生成只差一个输入——在上方状态卡完成选择即可直接生成。'
                    : '快速生成暂不可用（见上方状态卡）——高级调整将进入视觉工作台，方案、技能执行过程与 Prompt 来源全程可查。'}
            </span>
            <div className="skill-use-footer-group">
              <button type="button" className="app-btn app-btn-secondary" disabled={busy || repairRunning} onClick={props.onClose}>取消</button>
              <button type="button" className="app-btn app-btn-secondary" disabled={busy || repairRunning || templateCheck !== 'ok'} onClick={() => void openReuseProject()}>
                {busy ? '处理中…' : '高级调整'}
              </button>
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={busy || repairRunning || templateCheck !== 'ok' || !directReady}
                title={directReady ? '复用保存方案直接生成（不重新优化）' : '请先处理上方校验提示'}
                onClick={runDirectGenerate}
              >
                快速生成
              </button>
            </div>
          </div>
        </footer>
      </section>
      <ImageLibraryPicker
        open={galleryOpen}
        title="选择人物身份参考图"
        onClose={() => setGalleryOpen(false)}
        onPick={image => void pickGalleryPerson(image)}
      />
    </div>
  );
}
