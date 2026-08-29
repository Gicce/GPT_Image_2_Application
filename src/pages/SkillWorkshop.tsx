import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTaskStore } from '../store/useTaskStore';
import { useAuthStore } from '../store/useAuthStore';
import { resolveModelForRole } from '../features/aiRouting/resolveModelForRole';
import { evaluateTaskImages } from '../features/evaluation/evaluationService';
import { useEvaluationStore } from '../store/useEvaluationStore';
import { authorizeImageTask, createRequestId, isQuoteCancelled, registerTaskAuthorization, settleImageTask } from '../services/billingService';
import { loadSkillCatalog, loadSkillPackage } from '../features/skillWorkshop/catalogService';
import { compileSkillPrompt } from '../features/skillWorkshop/compiler';
import type { AssetRole, BrandCard, SkillAsset, SkillCatalogItem, SkillPackage, SkillProject } from '../features/skillWorkshop/types';
import { normalizeUserSkillDraft, resolveSkillCoverPath, skillCoverSamplePath, userSkillToPackage, type UserSkillDraft } from '../features/skillWorkshop/userSkill';
import TemplateSkillUseDialog from '../features/skillWorkshop/TemplateSkillUseDialog';
import SkillDeleteDialog, { type SkillDeleteTarget } from '../features/skillWorkshop/SkillDeleteDialog';
import ImageLibraryPicker from '../components/ImageLibraryPicker';
import OutputPathPicker from '../components/OutputPathPicker';
import type { ImageRecord } from '../types';
import { toastError, toastSuccess } from '../components/Toast';
import { listMySkillSubmissions, type SkillSubmissionSummary } from '../features/skillWorkshop/submissionService';
import './SkillWorkshop.css';

const STEP_LABELS = ['选择模板', '填写用途', '上传素材', '视觉分析', '确认素材卡', '风格与配置', '摘要与报价', '确认生成'];
const ROLE_LABELS: Record<AssetRole, string> = { brand_logo: '品牌 Logo', product: '产品', person: '人物', space: '空间', device: '设备', background_reference: '背景参考', style_reference: '风格参考' };
/** 无包加载时的桌搭负面词基线（与 BUILTIN_DESK_PACKAGE 时代行为一致）。 */
const DESK_DEFAULT_NEGATIVE_PROMPT = '廉价塑料感，彩虹RGB，超广角畸变，不真实产品比例，杂乱电线，摆件侵占操作区，两套独立显示器支架';

function createProject(settings: ReturnType<typeof useSettingsStore.getState>['settings'], pkg: SkillPackage | null): SkillProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, id: crypto.randomUUID(), name: pkg ? `我的${pkg.name}` : '我的专业桌搭',
    skillId: pkg?.skill_id ?? 'professional_desk_setup', skillVersion: pkg?.version ?? '1.0.0',
    revision: 0, status: 'draft', mode: 'guided', purpose: '', audience: '',
    styleId: pkg?.defaults.style ?? 'business', themeId: pkg?.defaults.theme ?? 'none', platformId: pkg?.defaults.platform ?? 'general',
    userOverrides: '', negativePrompt: pkg?.negative_prompt ?? DESK_DEFAULT_NEGATIVE_PROMPT, assets: [],
    output: { size: settings.default_size || '1536x1024', quality: settings.default_quality || 'auto', format: settings.default_format || 'png', count: 1, directory: settings.default_output_dir || '' },
    compiledPrompt: '', createdAt: now, updatedAt: now, sync: {},
  };
}

function fileName(path: string) { return path.split(/[\\/]/).pop() || path; }
function textArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }

export default function SkillWorkshop() {
  const settings = useSettingsStore(s => s.settings);
  const [catalog, setCatalog] = useState<SkillCatalogItem[]>([]);
  const [catalogSource, setCatalogSource] = useState('');
  const [pkg, setPkg] = useState<SkillPackage | null>(null);
  const [project, setProject] = useState<SkillProject>(() => createProject(settings, null));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [savedProjects, setSavedProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [qa, setQa] = useState<{ status: 'passed' | 'warning' | 'failed'; score: number | null; evidence: string; suggestion: string } | null>(null);
  const [libraryTab, setLibraryTab] = useState<'library' | 'mine'>('library');
  const [mySkills, setMySkills] = useState<Array<{ id: string; name: string; domain: string; status: string; authoringState: string; updatedAt: string }>>([]);
  /** V6：本地 Skill 类型（Rust 列表无 skillType 列——载入草稿后客户端判定）。 */
  const [skillTypes, setSkillTypes] = useState<Record<string, 'generic' | 'template_reuse'>>({});
  /** V6.3 封面：每个 Skill 解析后的封面路径（null = 回落类型 glyph 图标）。 */
  const [skillCovers, setSkillCovers] = useState<Record<string, string | null>>({});
  /** V6.3 封面选择：正在换封面的 Skill id（null = 关闭选择器）。 */
  const [coverPickId, setCoverPickId] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<SkillSubmissionSummary[]>([]);
  /** V6 模板复用 Skill：待绑定槽位的完整草稿（弹窗打开条件）。 */
  const [useDialogDraft, setUseDialogDraft] = useState<UserSkillDraft | null>(null);
  /** V6.1 我的技能删除：更多菜单 + 二次确认目标（null = 无删除流程）。 */
  const [skillMenuId, setSkillMenuId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SkillDeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void loadSkillCatalog().then(result => { setCatalog(result.items); setCatalogSource(result.source); });
    void loadSkillPackage('professional_desk_setup', '1.0.0').then(setPkg);
    void api.listSkillProjects().then(rows => setSavedProjects(rows.map(r => ({ id: r.id, name: r.name })))).catch(() => {});
    void api.listUserSkills().then(async rows => {
      setMySkills(rows);
      // V6 类型标注 + V6.3 封面路径：逐个载入草稿判定（旧 schema → generic，行为不变）
      const types = await Promise.all(rows.map(async row => {
        try {
          const raw = await api.loadUserSkill(row.id);
          const draft = raw ? normalizeUserSkillDraft(JSON.parse(raw)) : null;
          // 封面优先级（§44）：用户自定义 ＞ 公开样例 ＞ 模板图 ＞ glyph
          const coverPath = draft
            ? resolveSkillCoverPath(draft.cover, {
              samplePath: skillCoverSamplePath(draft),
              templatePath: draft.recipe?.template?.path ?? undefined,
            })
            : null;
          setSkillCovers(prev => ({ ...prev, [row.id]: coverPath }));
          return [row.id, draft?.skillType ?? 'generic'] as const;
        } catch { return [row.id, 'generic'] as const; }
      }));
      setSkillTypes(Object.fromEntries(types));
    }).catch(() => {});
    if (useAuthStore.getState().isLoggedIn) void listMySkillSubmissions().then(setSubmissions).catch(() => {});
  }, []);

  const useMySkill = async (id: string) => {
    const raw = await api.loadUserSkill(id);
    if (!raw) return;
    try {
      const draft = normalizeUserSkillDraft(JSON.parse(raw));
      if (!draft) throw new Error('bad draft');
      // V6 模板复用 Skill：不走通用编译器（摘要 Prompt 必然降级），
      // 改为槽位绑定 → Recipe 重建 VisualProject → 视觉工作台同源链路
      if (draft.skillType === 'template_reuse' && draft.recipe) {
        setUseDialogDraft(draft);
        return;
      }
      const nextPackage = userSkillToPackage(draft);
      setPkg(nextPackage);
      const next = createProject(settings, nextPackage);
      next.name = draft.name;
      next.styleId = nextPackage.defaults.style || nextPackage.profiles.find(item => item.kind === 'style')?.id || '';
      next.themeId = nextPackage.defaults.theme || nextPackage.profiles.find(item => item.kind === 'theme')?.id || '';
      setProject(next); setStep(1); setLibraryTab('library'); setMessage(`已基于「${draft.name}」创建新的生成项目。`);
    } catch { setError('这个本地 Skill 无法读取。'); }
  };

  /**
   * 目录多方向点选（ADR-028）：ready 条目点击即加载对应技能包并重置项目，
   * 非条目返回的包与点击目标不符（离线回退到桌搭）时不切换，明确报错。
   */
  const selectCatalogSkill = async (item: SkillCatalogItem) => {
    if (item.readiness !== 'ready') return;
    setError(''); setMessage('');
    const nextPackage = await loadSkillPackage(item.skill_id, item.version);
    if (nextPackage.skill_id !== item.skill_id) { setError(`「${item.name}」技能包暂不可用，请检查网络后重试。`); return; }
    setPkg(nextPackage);
    setProject(createProject(settings, nextPackage));
    setStep(1);
    setMessage(`已切换到「${nextPackage.name}」方向，从填写用途开始。`);
  };

  const compiled = useMemo(() => pkg ? compileSkillPrompt(pkg, project) : { prompt: '', blockers: ['技能包尚未就绪'], sections: [] }, [pkg, project]);

  /**
   * V6.1 删除我的技能（destructive，二次确认后执行）：
   * - 只删本地 user_skills 行（Rust delete_user_skill），不触碰服务器投稿记录；
   * - 正在打开的模板复用弹窗若指向被删 Skill，安全关闭回到列表；
   * - 失败保留卡片并提示（绝不做 UI 假删除）。
   */
  const confirmDeleteSkill = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.deleteUserSkill(deleteTarget.id);
      setMySkills(prev => prev.filter(skill => skill.id !== deleteTarget.id));
      setSkillTypes(prev => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      if (useDialogDraft?.id === deleteTarget.id) setUseDialogDraft(null);
      setSkillMenuId('');
      setDeleteTarget(null);
      toastSuccess(`已删除「${deleteTarget.name}」`);
    } catch (e: any) {
      toastError(e?.message || '删除失败，请重试。');
    } finally {
      setDeleting(false);
    }
  };
  /**
   * V6.3 更换封面（§37-§48）：封面 = 本机 display 元数据，只存图库引用。
   *  - 重新载入草稿后写 cover 字段并整包保存（Rust data_json 透传，无结构迁移）；
   *  - 绝不触碰 Recipe / 模板资产 / 生成参数，不复制或删除任何图库文件；
   *  - 已提交的服务器投稿不受影响——不存在也不假装存在「投稿封面同步」。
   */
  const applySkillCover = async (skillId: string, image: ImageRecord) => {
    setCoverPickId(null);
    try {
      const raw = await api.loadUserSkill(skillId);
      const draft = raw ? normalizeUserSkillDraft(JSON.parse(raw)) : null;
      if (!draft) throw new Error('本地 Skill 数据无法读取，请重试。');
      const next: UserSkillDraft = {
        ...draft,
        cover: { source: 'library', path: image.local_path, assetId: image.id, updatedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      };
      await api.saveUserSkill({
        id: next.id, name: next.name, domain: next.domain, version: next.version, status: next.status,
        sourceProjectId: next.sourceProjectId, sourceRevision: next.sourceRevision,
        authoringState: next.authoringState, dataJson: JSON.stringify(next),
      });
      setSkillCovers(prev => ({ ...prev, [skillId]: image.local_path }));
      toastSuccess('封面已更新（仅本机展示，不影响模板、生成方案与已提交的审核记录）。');
    } catch (e: any) {
      toastError(e?.message || '封面更新失败，请重试。');
    }
  };

  const update = (patch: Partial<SkillProject>) => setProject(prev => ({ ...prev, ...patch, updatedAt: new Date().toISOString() }));
  const updateOutput = (patch: Partial<SkillProject['output']>) => update({ output: { ...project.output, ...patch } });
  const styles = pkg?.profiles.filter(p => p.kind === 'style') ?? [];
  const themes = pkg?.profiles.filter(p => p.kind === 'theme') ?? [];

  const addAsset = async (role: AssetRole) => {
    const path = await api.selectImageFile();
    if (!path) return;
    let fingerprint = `${path}:${Date.now()}`;
    try { fingerprint = await api.fingerprintSkillAsset(path); } catch { /* 分析时仍会绑定当前选择 */ }
    const asset: SkillAsset = { id: crypto.randomUUID(), role, path, name: fileName(path), fingerprint };
    update({ assets: [...project.assets, asset] });
  };

  const analyzeLogo = async (asset: SkillAsset) => {
    setError(''); setMessage('');
    const resolution = resolveModelForRole('vision_analysis');
    if (!resolution.ok || !resolution.connection) { setError(resolution.ok ? '请先配置可用的视觉理解模型。' : resolution.error); return; }
    setBusy(asset.id);
    try {
      const result = await api.analyzeBrandLogo({ imagePath: asset.path, baseUrl: resolution.connection.baseUrl, token: resolution.connection.token, model: resolution.connection.model });
      const a = result.analysis;
      const card: BrandCard = {
        assetId: asset.id, fingerprint: asset.fingerprint, sourcePath: asset.path, analyzedAt: new Date().toISOString(), model: result.model,
        structure: String(a.structure ?? 'unknown'), visibleText: String(a.visible_text ?? ''), aspectRatio: String(a.aspect_ratio ?? 'unknown'),
        colors: textArray(a.colors), backgroundCompatibility: textArray(a.background_compatibility), safeArea: String(a.safe_area ?? 'unknown'),
        prohibitedTransformations: textArray(a.prohibited_transformations), confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)),
        uncertainties: textArray(a.uncertainties), confirmed: false, userNotes: '',
      };
      update({ assets: project.assets.map(item => item.id === asset.id ? { ...item, brandCard: card } : item) });
      setMessage('Logo 素材卡已生成。AI 推断不会自动成为品牌规则，请检查后确认。');
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(''); }
  };

  const confirmBrand = (asset: SkillAsset) => {
    if (!asset.brandCard) return;
    update({ assets: project.assets.map(item => item.id === asset.id ? { ...item, brandCard: { ...asset.brandCard!, confirmed: true } } : item) });
    setMessage('品牌卡已由你确认并锁定到当前素材指纹。');
  };

  const saveProject = async () => {
    const next = { ...project, compiledPrompt: compiled.prompt, revision: project.revision + 1, updatedAt: new Date().toISOString() };
    setBusy('save'); setError('');
    try {
      await api.saveSkillProject({ id: next.id, name: next.name, skillId: next.skillId, skillVersion: next.skillVersion, status: next.status, revision: next.revision, dataJson: JSON.stringify(next), lastOpenedAt: next.updatedAt });
      setProject(next); setSavedProjects(prev => [{ id: next.id, name: next.name }, ...prev.filter(p => p.id !== next.id)]); setMessage('项目已保存在本机。');
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(''); }
  };

  const openProject = async (id: string) => {
    const raw = await api.loadSkillProject(id);
    if (!raw) return;
    try {
      const restored = JSON.parse(raw) as SkillProject;
      const checkedAssets = await Promise.all(restored.assets.map(async asset => {
        try {
          const currentFingerprint = await api.fingerprintSkillAsset(asset.path);
          return currentFingerprint === asset.fingerprint ? asset : { ...asset, fingerprint: currentFingerprint, brandCard: undefined };
        } catch { return { ...asset, brandCard: undefined }; }
      }));
      const invalidated = checkedAssets.some((asset, index) => Boolean(restored.assets[index].brandCard && !asset.brandCard));
      setProject({ ...restored, assets: checkedAssets }); setStep(1);
      setMessage(invalidated ? '素材文件已变化，旧分析已自动失效，请重新分析并确认。' : '已恢复本地项目。');
    } catch { setError('项目文件无法读取。'); }
  };

  const generate = async () => {
    setError(''); setMessage('');
    if (compiled.blockers.length) { setError(compiled.blockers.join(' ')); return; }
    if (!project.purpose.trim()) { setError('请先填写本次图片用途或期望效果。'); setStep(1); return; }
    if (!project.output.directory.trim()) { setError('请先选择输出目录。'); setStep(5); return; }
    let billingRequestId: string | undefined;
    if (useAuthStore.getState().isLoggedIn) {
      try { billingRequestId = createRequestId('skill'); await authorizeImageTask(billingRequestId, project.output.count); }
      catch (e: any) { if (!isQuoteCancelled(e)) setError(e?.message || '报价确认失败。'); return; }
    }
    setBusy('generate');
    try {
      const task = await api.createTask({
        prompt: compiled.prompt, negative_prompt: project.negativePrompt, user_prompt_raw: project.purpose,
        final_prompt: compiled.prompt, final_negative_prompt: project.negativePrompt, size: project.output.size, quality: project.output.quality,
        output_format: project.output.format, count: project.output.count, output_dir: project.output.directory, task_type: project.assets.length ? 'edit' : 'generate',
        source_images: project.assets.map(a => a.path), task_source: 'manual', execution_mode: 'single',
      });
      useTaskStore.getState().addTask(task);
      if (billingRequestId) registerTaskAuthorization(task.id, billingRequestId);
      update({ status: 'generated', compiledPrompt: compiled.prompt, lastTaskId: task.id });
      setMessage('任务已提交。生成完成后可在图片库主动触发 AI 质检；质检不会自动消耗模型。');
    } catch (e: any) {
      if (billingRequestId) void settleImageTask(billingRequestId, false, 0, 'skill task create failed');
      setError(e?.message || String(e));
    } finally { setBusy(''); }
  };

  const runQualityReview = async () => {
    if (!project.lastTaskId) return;
    const task = useTaskStore.getState().getTask(project.lastTaskId);
    if (!task || task.status !== 'completed') { setError('任务尚未生成完成，请完成后再主动质检。'); return; }
    setBusy('qa'); setError('');
    try {
      const images = await api.getImages();
      await evaluateTaskImages(task, new Map(images.map(image => [image.id, image])), { force: true });
      const evaluations = task.sub_tasks.map(sub => sub.image_id ? useEvaluationStore.getState().evaluations[sub.image_id] : null).filter(Boolean);
      const scores = evaluations.map(e => e!.overall_score).filter((v): v is number => v != null);
      const score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      const issues = evaluations.flatMap(e => e!.issues).slice(0, 5);
      const suggestion = evaluations.map(e => e!.suggestion).filter(Boolean).join('；');
      setQa({ status: score == null ? 'failed' : score >= 85 ? 'passed' : score >= 70 ? 'warning' : 'failed', score, evidence: issues.join('；') || '未发现明显问题', suggestion });
    } catch (e: any) { setError(e?.message || '质检失败，请确认评价模型配置。'); } finally { setBusy(''); }
  };

  const createCorrectionProposal = () => {
    if (!qa?.suggestion) return;
    update({ userOverrides: [project.userOverrides, `质检修正：${qa.suggestion}`].filter(Boolean).join('\n') });
    setStep(6); setMessage('已创建新的修正提案。请检查 Prompt 与报价后再生成，不会覆盖原结果。');
  };

  return (
    <div className="page skill-workshop-page">
      <div className="page-header skill-workshop-header">
        <div><h2>技能工坊</h2><p>按专业工作流从素材理解到方案生成，新手也能清楚完成每一步。</p></div>
        <div className="app-segmented" aria-label="工作模式">
          <button className={`app-segmented-btn${project.mode === 'guided' ? ' active' : ''}`} aria-pressed={project.mode === 'guided'} onClick={() => update({ mode: 'guided' })}>向导模式</button>
          <button className={`app-segmented-btn${project.mode === 'professional' ? ' active' : ''}`} aria-pressed={project.mode === 'professional'} onClick={() => update({ mode: 'professional' })}>专业模式</button>
        </div>
      </div>

      <div className="skill-library-tabs app-segmented" aria-label="技能范围">
        <button className={`app-segmented-btn${libraryTab === 'library' ? ' active' : ''}`} onClick={() => setLibraryTab('library')}>技能库</button>
        <button className={`app-segmented-btn${libraryTab === 'mine' ? ' active' : ''}`} onClick={() => setLibraryTab('mine')}>我的技能 <span>{mySkills.length}</span></button>
      </div>

      {error && <div className="skill-banner error">{error}</div>}
      {message && <div className="skill-banner success">{message}</div>}

      {libraryTab === 'mine' && <section className="my-skills-panel">
        <div className="my-skills-heading"><div><h3>我的技能</h3><p>视觉理解项目保存的模板、AI 通用化 Skill 和公开投稿都集中在这里。</p></div></div>
        {mySkills.length === 0 ? (
          <div className="skill-empty my-skills-empty">
            <p>还没有保存的 Skill。</p>
            <button className="app-btn app-btn-primary" onClick={() => window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'vision' } }))}>去视觉理解保存</button>
          </div>
        ) : <div className="my-skills-grid">{mySkills.map(item => {
          const submission = submissions.find(row => row.local_skill_id === item.id);
          const status = submission?.status || item.status;
          const skillType = skillTypes[item.id] ?? 'generic';
          return (
            <article key={item.id}>
              <SkillCoverThumb
                path={skillCovers[item.id] ?? null}
                fallbackGlyph={skillType === 'template_reuse' ? '▣' : '◇'}
              />
              <div>
                <span>{ROLE_LABELS[item.domain as AssetRole] || item.domain}</span>
                <h3>{item.name}{skillType === 'template_reuse' && <em className="my-skill-type">模板复用</em>}</h3>
                <p>{skillType === 'template_reuse' ? '模板复用 · 从保存的完整方案重建（合同不降级）' : item.authoringState === 'project_template' ? '项目模板 · 尚未 AI 通用化' : '通用 Skill'}</p>
                <small>{status === 'changes_requested' ? `需修改：${submission?.review_message || ''}` : `状态：${status}`}</small>
              </div>
              <div className="my-skill-actions">
                <button className="app-btn app-btn-primary app-btn-sm" onClick={() => void useMySkill(item.id)}>使用</button>
                <button className="app-btn app-btn-secondary app-btn-sm" onClick={() => void useMySkill(item.id)}>{skillType === 'template_reuse' ? '查看方案' : '查看与编辑'}</button>
                <div className="my-skill-more">
                  <button
                    className="app-btn app-btn-secondary app-btn-sm my-skill-more-btn"
                    aria-label={`更多操作（${item.name}）`}
                    aria-expanded={skillMenuId === item.id}
                    onClick={() => setSkillMenuId(current => current === item.id ? '' : item.id)}
                  >⋯</button>
                  {skillMenuId === item.id && (
                    <>
                      <button type="button" className="my-skill-menu-catcher" aria-label="关闭菜单" onClick={() => setSkillMenuId('')} />
                      <div className="my-skill-menu" role="menu">
                        <button
                          type="button" role="menuitem"
                          onClick={() => setCoverPickId(item.id)}
                        >更换封面</button>
                        <button
                          type="button" role="menuitem" className="is-danger"
                          onClick={() => setDeleteTarget({
                            id: item.id,
                            name: item.name,
                            status,
                            hasSubmissionRecord: Boolean(submission),
                          })}
                        >删除技能</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}</div>}
      </section>}

      {libraryTab === 'library' && <><div className="skill-catalog-strip">
        {catalog.map(item => <button key={item.skill_id} disabled={item.readiness !== 'ready'} className={item.skill_id === project.skillId ? 'selected' : ''} title={item.summary} onClick={() => void selectCatalogSkill(item)}>
          <strong>{item.name}</strong><span>{item.readiness === 'ready' ? '正式可用' : '测试中'}</span>
        </button>)}
        <small>目录：{catalogSource === 'server' ? '在线' : catalogSource === 'cache' ? '离线缓存' : '内置回退'}</small>
      </div>

      <div className="skill-workbench">
        <aside className="skill-steps">
          <h3>制作步骤</h3>
          {STEP_LABELS.map((label, index) => <button key={label} className={step === index ? 'active' : index < step ? 'done' : ''} onClick={() => setStep(index)}>
            <span>{index + 1}</span>{label}
          </button>)}
          {savedProjects.length > 0 && <div className="skill-saved"><h4>本地项目</h4>{savedProjects.slice(0, 4).map(p => <button key={p.id} onClick={() => void openProject(p.id)}>{p.name}</button>)}</div>}
        </aside>

        <main className="skill-form-panel">
          <div className="skill-section-title"><div><small>步骤 {step + 1} / 8</small><h3>{STEP_LABELS[step]}</h3></div><button className="app-btn app-btn-secondary" onClick={() => void saveProject()} disabled={busy === 'save'}>{busy === 'save' ? '保存中…' : '保存项目'}</button></div>

          {step === 0 && <section className="skill-template-card"><div className="skill-template-mark">◇</div><div><h3>{pkg?.profiles.find(p => p.kind === 'base')?.name ?? pkg?.name ?? '基础模板'}</h3><p>{pkg?.summary ?? '技能包加载中…'}</p><span>v{pkg?.version ?? '…'} · {pkg?.readiness === 'ready' ? '正式可用' : '测试中'}</span></div></section>}
          {step === 1 && <section className="skill-fields">
            <div className="form-group"><label>你希望制作什么图片？</label><textarea rows={5} value={project.purpose} onChange={e => update({ purpose: e.target.value })} placeholder={`例如：用「${pkg?.name ?? '技能'}」做一张成熟、真实、可直接落地的画面，说明用途、风格倾向与必须保留的元素。`} /></div>
            <div className="form-group"><label>使用场景或目标受众（可选）</label><input value={project.audience} onChange={e => update({ audience: e.target.value })} placeholder="例如：社交媒体展示、桌搭方案提案" /></div>
          </section>}
          {step === 2 && <section><p className="skill-help">素材先标注角色。Logo 不会自动分析，也不会仅靠文字重绘。</p><div className="skill-asset-actions">{Object.entries(ROLE_LABELS).map(([role, label]) => <button className="app-btn app-btn-secondary app-btn-sm" key={role} onClick={() => void addAsset(role as AssetRole)}>＋ {label}</button>)}</div><AssetList assets={project.assets} onRemove={id => update({ assets: project.assets.filter(a => a.id !== id) })} /></section>}
          {(step === 3 || step === 4) && <section><p className="skill-help">AI 结论是推断。品牌规则必须由你确认；低置信度时建议对照正式品牌手册。</p><AssetList assets={project.assets} onAnalyze={analyzeLogo} onConfirm={confirmBrand} busy={busy} onNotes={(id, notes) => update({ assets: project.assets.map(a => a.id === id && a.brandCard ? { ...a, brandCard: { ...a.brandCard, confirmed: false, userNotes: notes } } : a) })} /></section>}
          {step === 5 && <section className="skill-fields skill-grid-fields">
            <div className="form-group"><label>风格</label><select value={project.styleId} onChange={e => update({ styleId: e.target.value })}>{styles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div className="form-group"><label>主题</label><select value={project.themeId} onChange={e => update({ themeId: e.target.value })}>{themes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div className="form-group"><label>图片尺寸</label><select value={project.output.size} onChange={e => updateOutput({ size: e.target.value })}><option>1536x1024</option><option>1024x1024</option><option>1024x1536</option></select></div>
            <div className="form-group"><label>生成张数</label><select value={project.output.count} onChange={e => updateOutput({ count: Number(e.target.value) })}><option value={1}>1 张</option><option value={2}>2 张</option><option value={4}>4 张</option></select></div>
            <div className="form-group full"><label>输出位置</label><OutputPathPicker value={project.output.directory} onChange={dir => updateOutput({ directory: dir })} label="输出位置" /></div>
            <div className="form-group full"><label>本次覆盖要求</label><textarea rows={4} value={project.userOverrides} onChange={e => update({ userOverrides: e.target.value })} placeholder="只写本次需要改变的内容；领域硬规则不会被覆盖。" /></div>
          </section>}
          {step >= 6 && <section>
            <div className="skill-review-list"><h4>生成前检查</h4><p className={compiled.blockers.length ? 'blocked' : 'passed'}>{compiled.blockers.length ? compiled.blockers.join(' ') : '素材与专业规则检查通过，可以进入报价确认。'}</p>{pkg?.review_rubric.map(item => <span key={item}>✓ {item}</span>)}</div>
            <button className="skill-prompt-toggle" onClick={() => setShowPrompt(v => !v)}>{showPrompt ? '收起完整 Prompt' : '查看完整 Prompt'} {project.mode === 'professional' ? '· 可编辑覆盖要求' : ''}</button>
            {showPrompt && <textarea className="skill-prompt-preview" readOnly value={compiled.prompt} rows={16} />}
            {step === 7 && <div className="skill-generate-box"><div><strong>确认生成 {project.output.count} 张</strong><span>点击后先显示服务端报价；取消或失败不会误扣点。</span></div><button className="app-btn app-btn-primary" disabled={busy === 'generate' || compiled.blockers.length > 0} onClick={() => void generate()}>{busy === 'generate' ? '提交中…' : '报价并生成'}</button></div>}
          </section>}

          <div className="skill-nav-actions"><button className="app-btn app-btn-secondary" disabled={step === 0} onClick={() => setStep(s => Math.max(0, s - 1))}>上一步</button><button className="app-btn app-btn-primary" disabled={step === 7} onClick={() => setStep(s => Math.min(7, s + 1))}>下一步</button></div>
        </main>

        <aside className="skill-summary-panel"><h3>实时方案</h3><div className="skill-summary-hero"><span>{pkg?.name ?? '技能工坊'}</span><strong>{styles.find(p => p.id === project.styleId)?.name || '默认风格'} + {themes.find(p => p.id === project.themeId)?.name || '无主题'}</strong></div><dl><div><dt>用途</dt><dd>{project.purpose || '待填写'}</dd></div><div><dt>素材</dt><dd>{project.assets.length} 个 · {project.assets.filter(a => a.brandCard?.confirmed).length} 个已确认品牌卡</dd></div><div><dt>输出</dt><dd>{project.output.size} · {project.output.count} 张</dd></div><div><dt>规则</dt><dd>{pkg?.core_rules.length ?? 0} 条硬规则</dd></div></dl><div className="skill-summary-status"><i className={compiled.blockers.length ? 'warning' : 'ready'} />{compiled.blockers.length ? `${compiled.blockers.length} 项待处理` : '方案可生成'}</div>{project.lastTaskId && <div className="skill-result-actions"><button className="app-btn app-btn-secondary app-btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'queue', focusTaskId: project.lastTaskId } }))}>查看生成任务</button><button className="app-btn app-btn-secondary app-btn-sm" disabled={busy === 'qa'} onClick={() => void runQualityReview()}>{busy === 'qa' ? '质检中…' : '主动 AI 质检'}</button>{qa && <div className={`skill-qa ${qa.status}`}><strong>{qa.status === 'passed' ? '通过' : qa.status === 'warning' ? '警告' : '不通过'}{qa.score != null ? ` · ${qa.score}分` : ''}</strong><p>{qa.evidence}</p>{qa.suggestion && <button className="app-btn app-btn-primary app-btn-sm" onClick={createCorrectionProposal}>一键创建修正提案</button>}</div>}</div>}</aside>
      </div></>}

      {/* V6 模板复用 Skill 使用弹窗（槽位绑定 + Recipe 重建 → 视觉工作台同源链路） */}
      {useDialogDraft && (
        <TemplateSkillUseDialog draft={useDialogDraft} onClose={() => setUseDialogDraft(null)} />
      )}

      {/* V6.1 删除我的技能：destructive 二次确认（文案区分 local / submitted） */}
      {deleteTarget && (
        <SkillDeleteDialog
          target={deleteTarget}
          busy={deleting}
          onConfirm={() => void confirmDeleteSkill()}
          onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        />
      )}

      {/* V6.3 更换封面：复用唯一图片库选择器（禁止第二个 picker 实现） */}
      <ImageLibraryPicker
        open={!!coverPickId}
        title="选择 Skill 封面"
        onClose={() => setCoverPickId(null)}
        onPick={image => { if (coverPickId) void applySkillCover(coverPickId, image); }}
      />
    </div>
  );
}

/**
 * V6.3 我的技能卡片封面：真实缩略图（Rust read_thumbnail），
 * 无封面 / 缩略图失败回落类型 glyph 图标。display-only——点击不打开编辑。
 */
function SkillCoverThumb({ path, fallbackGlyph }: { path: string | null; fallbackGlyph: string }) {
  const [thumb, setThumb] = useState('');
  useEffect(() => {
    let alive = true;
    if (!path) { setThumb(''); return; }
    api.readThumbnail(path).then(data => { if (alive) setThumb(data); }).catch(() => { if (alive) setThumb(''); });
    return () => { alive = false; };
  }, [path]);
  if (!path || !thumb) {
    return <div className="my-skill-cover" aria-hidden="true">{fallbackGlyph}</div>;
  }
  return <img className="my-skill-cover is-image" src={thumb} alt="" />;
}

function AssetList({ assets, onRemove, onAnalyze, onConfirm, onNotes, busy }: { assets: SkillAsset[]; onRemove?: (id: string) => void; onAnalyze?: (a: SkillAsset) => void; onConfirm?: (a: SkillAsset) => void; onNotes?: (id: string, notes: string) => void; busy?: string }) {
  if (!assets.length) return <div className="skill-empty">还没有素材。上传的原图会作为真实附件参与生成。</div>;
  return <div className="skill-assets">{assets.map(asset => <article key={asset.id}><div className="skill-asset-head"><div><strong>{asset.name}</strong><span>{ROLE_LABELS[asset.role]}</span></div>{onRemove && <button className="settings-btn settings-btn-link settings-btn-sm" onClick={() => onRemove(asset.id)}>移除</button>}</div>{asset.role === 'brand_logo' && <>{!asset.brandCard ? <button className="app-btn app-btn-primary" disabled={busy === asset.id} onClick={() => onAnalyze?.(asset)}>{busy === asset.id ? '分析中…' : '点击分析 Logo'}</button> : <div className="brand-card"><div><span>AI 推断 · 置信度 {Math.round(asset.brandCard.confidence * 100)}%</span><strong>{asset.brandCard.structure}</strong></div><p>文字：{asset.brandCard.visibleText || '未识别'} · 比例：{asset.brandCard.aspectRatio}</p><p>色彩：{asset.brandCard.colors.join('、') || '未识别'}</p><p>安全区：{asset.brandCard.safeArea}</p><p>禁止：{asset.brandCard.prohibitedTransformations.join('、') || '待确认'}</p>{onNotes && <textarea rows={2} value={asset.brandCard.userNotes} onChange={e => onNotes(asset.id, e.target.value)} placeholder="补充正式品牌手册中的规则（修改后需重新确认）" />}{asset.brandCard.confirmed ? <span className="brand-confirmed">✓ 已由用户确认</span> : <button className="app-btn app-btn-primary" onClick={() => onConfirm?.(asset)}>确认并锁定品牌卡</button>}</div>}</>}</article>)}</div>;
}
