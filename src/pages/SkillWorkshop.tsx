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
import './SkillWorkshop.css';

const STEP_LABELS = ['选择模板', '填写用途', '上传素材', '视觉分析', '确认素材卡', '风格与配置', '摘要与报价', '确认生成'];
const ROLE_LABELS: Record<AssetRole, string> = { brand_logo: '品牌 Logo', product: '产品', space: '空间', device: '设备', style_reference: '风格参考' };

function createProject(settings: ReturnType<typeof useSettingsStore.getState>['settings']): SkillProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, id: crypto.randomUUID(), name: '我的专业桌搭', skillId: 'professional_desk_setup', skillVersion: '1.0.0',
    revision: 0, status: 'draft', mode: 'guided', purpose: '', audience: '', styleId: 'business', themeId: 'none', platformId: 'general',
    userOverrides: '', negativePrompt: '廉价塑料感，彩虹RGB，超广角畸变，不真实产品比例，杂乱电线，摆件侵占操作区，两套独立显示器支架', assets: [],
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
  const [project, setProject] = useState<SkillProject>(() => createProject(settings));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [savedProjects, setSavedProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [qa, setQa] = useState<{ status: 'passed' | 'warning' | 'failed'; score: number | null; evidence: string; suggestion: string } | null>(null);

  useEffect(() => {
    void loadSkillCatalog().then(result => { setCatalog(result.items); setCatalogSource(result.source); });
    void loadSkillPackage('professional_desk_setup', '1.0.0').then(setPkg);
    void api.listSkillProjects().then(rows => setSavedProjects(rows.map(r => ({ id: r.id, name: r.name })))).catch(() => {});
  }, []);

  const compiled = useMemo(() => pkg ? compileSkillPrompt(pkg, project) : { prompt: '', blockers: ['技能包尚未就绪'], sections: [] }, [pkg, project]);
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
        <div className="skill-mode-switch" aria-label="工作模式">
          <button className={project.mode === 'guided' ? 'active' : ''} onClick={() => update({ mode: 'guided' })}>向导模式</button>
          <button className={project.mode === 'professional' ? 'active' : ''} onClick={() => update({ mode: 'professional' })}>专业模式</button>
        </div>
      </div>

      {error && <div className="skill-banner error">{error}</div>}
      {message && <div className="skill-banner success">{message}</div>}

      <div className="skill-catalog-strip">
        {catalog.map(item => <button key={item.skill_id} disabled={item.readiness !== 'ready'} className={item.skill_id === project.skillId ? 'selected' : ''} title={item.summary}>
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
          <div className="skill-section-title"><div><small>步骤 {step + 1} / 8</small><h3>{STEP_LABELS[step]}</h3></div><button className="app-btn-secondary" onClick={() => void saveProject()} disabled={busy === 'save'}>{busy === 'save' ? '保存中…' : '保存项目'}</button></div>

          {step === 0 && <section className="skill-template-card"><div className="skill-template-mark">◇</div><div><h3>Business Walnut</h3><p>专业桌搭生产级模板：胡桃木商务基线、真实双屏结构、人体工学、理线和商业摄影。</p><span>v{pkg?.version ?? '…'} · 正式可用</span></div></section>}
          {step === 1 && <section className="skill-fields">
            <div className="form-group"><label>你希望制作什么图片？</label><textarea rows={5} value={project.purpose} onChange={e => update({ purpose: e.target.value })} placeholder="例如：为一位女性创作者设计高级少女风专业桌搭，成熟、真实、可购买落地。" /></div>
            <div className="form-group"><label>使用场景或目标受众（可选）</label><input value={project.audience} onChange={e => update({ audience: e.target.value })} placeholder="例如：社交媒体展示、桌搭方案提案" /></div>
          </section>}
          {step === 2 && <section><p className="skill-help">素材先标注角色。Logo 不会自动分析，也不会仅靠文字重绘。</p><div className="skill-asset-actions">{Object.entries(ROLE_LABELS).map(([role, label]) => <button className="app-btn-secondary" key={role} onClick={() => void addAsset(role as AssetRole)}>＋ {label}</button>)}</div><AssetList assets={project.assets} onRemove={id => update({ assets: project.assets.filter(a => a.id !== id) })} /></section>}
          {(step === 3 || step === 4) && <section><p className="skill-help">AI 结论是推断。品牌规则必须由你确认；低置信度时建议对照正式品牌手册。</p><AssetList assets={project.assets} onAnalyze={analyzeLogo} onConfirm={confirmBrand} busy={busy} onNotes={(id, notes) => update({ assets: project.assets.map(a => a.id === id && a.brandCard ? { ...a, brandCard: { ...a.brandCard, confirmed: false, userNotes: notes } } : a) })} /></section>}
          {step === 5 && <section className="skill-fields skill-grid-fields">
            <div className="form-group"><label>风格</label><select value={project.styleId} onChange={e => update({ styleId: e.target.value })}>{styles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div className="form-group"><label>主题</label><select value={project.themeId} onChange={e => update({ themeId: e.target.value })}>{themes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div className="form-group"><label>图片尺寸</label><select value={project.output.size} onChange={e => updateOutput({ size: e.target.value })}><option>1536x1024</option><option>1024x1024</option><option>1024x1536</option></select></div>
            <div className="form-group"><label>生成张数</label><select value={project.output.count} onChange={e => updateOutput({ count: Number(e.target.value) })}><option value={1}>1 张</option><option value={2}>2 张</option><option value={4}>4 张</option></select></div>
            <div className="form-group full"><label>输出目录</label><div className="skill-inline"><input value={project.output.directory} readOnly placeholder="请选择输出目录" /><button className="app-btn-secondary" onClick={async () => { const d = await api.selectDirectory(); if (d) updateOutput({ directory: d }); }}>浏览</button></div></div>
            <div className="form-group full"><label>本次覆盖要求</label><textarea rows={4} value={project.userOverrides} onChange={e => update({ userOverrides: e.target.value })} placeholder="只写本次需要改变的内容；领域硬规则不会被覆盖。" /></div>
          </section>}
          {step >= 6 && <section>
            <div className="skill-review-list"><h4>生成前检查</h4><p className={compiled.blockers.length ? 'blocked' : 'passed'}>{compiled.blockers.length ? compiled.blockers.join(' ') : '素材与专业规则检查通过，可以进入报价确认。'}</p>{pkg?.review_rubric.map(item => <span key={item}>✓ {item}</span>)}</div>
            <button className="skill-prompt-toggle" onClick={() => setShowPrompt(v => !v)}>{showPrompt ? '收起完整 Prompt' : '查看完整 Prompt'} {project.mode === 'professional' ? '· 可编辑覆盖要求' : ''}</button>
            {showPrompt && <textarea className="skill-prompt-preview" readOnly value={compiled.prompt} rows={16} />}
            {step === 7 && <div className="skill-generate-box"><div><strong>确认生成 {project.output.count} 张</strong><span>点击后先显示服务端报价；取消或失败不会误扣点。</span></div><button className="app-btn-primary" disabled={busy === 'generate' || compiled.blockers.length > 0} onClick={() => void generate()}>{busy === 'generate' ? '提交中…' : '报价并生成'}</button></div>}
          </section>}

          <div className="skill-nav-actions"><button className="app-btn-secondary" disabled={step === 0} onClick={() => setStep(s => Math.max(0, s - 1))}>上一步</button><button className="app-btn-primary" disabled={step === 7} onClick={() => setStep(s => Math.min(7, s + 1))}>下一步</button></div>
        </main>

        <aside className="skill-summary-panel"><h3>实时方案</h3><div className="skill-summary-hero"><span>专业桌搭</span><strong>{styles.find(p => p.id === project.styleId)?.name || '商务'} + {themes.find(p => p.id === project.themeId)?.name || '无主题'}</strong></div><dl><div><dt>用途</dt><dd>{project.purpose || '待填写'}</dd></div><div><dt>素材</dt><dd>{project.assets.length} 个 · {project.assets.filter(a => a.brandCard?.confirmed).length} 个已确认品牌卡</dd></div><div><dt>输出</dt><dd>{project.output.size} · {project.output.count} 张</dd></div><div><dt>规则</dt><dd>{pkg?.core_rules.length ?? 0} 条硬规则</dd></div></dl><div className="skill-summary-status"><i className={compiled.blockers.length ? 'warning' : 'ready'} />{compiled.blockers.length ? `${compiled.blockers.length} 项待处理` : '方案可生成'}</div>{project.lastTaskId && <div className="skill-result-actions"><button className="app-btn-secondary" onClick={() => window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'queue', focusTaskId: project.lastTaskId } }))}>查看生成任务</button><button className="app-btn-secondary" disabled={busy === 'qa'} onClick={() => void runQualityReview()}>{busy === 'qa' ? '质检中…' : '主动 AI 质检'}</button>{qa && <div className={`skill-qa ${qa.status}`}><strong>{qa.status === 'passed' ? '通过' : qa.status === 'warning' ? '警告' : '不通过'}{qa.score != null ? ` · ${qa.score}分` : ''}</strong><p>{qa.evidence}</p>{qa.suggestion && <button className="app-btn-primary" onClick={createCorrectionProposal}>一键创建修正提案</button>}</div>}</div>}</aside>
      </div>
    </div>
  );
}

function AssetList({ assets, onRemove, onAnalyze, onConfirm, onNotes, busy }: { assets: SkillAsset[]; onRemove?: (id: string) => void; onAnalyze?: (a: SkillAsset) => void; onConfirm?: (a: SkillAsset) => void; onNotes?: (id: string, notes: string) => void; busy?: string }) {
  if (!assets.length) return <div className="skill-empty">还没有素材。上传的原图会作为真实附件参与生成。</div>;
  return <div className="skill-assets">{assets.map(asset => <article key={asset.id}><div className="skill-asset-head"><div><strong>{asset.name}</strong><span>{ROLE_LABELS[asset.role]}</span></div>{onRemove && <button onClick={() => onRemove(asset.id)}>移除</button>}</div>{asset.role === 'brand_logo' && <>{!asset.brandCard ? <button className="app-btn-primary" disabled={busy === asset.id} onClick={() => onAnalyze?.(asset)}>{busy === asset.id ? '分析中…' : '点击分析 Logo'}</button> : <div className="brand-card"><div><span>AI 推断 · 置信度 {Math.round(asset.brandCard.confidence * 100)}%</span><strong>{asset.brandCard.structure}</strong></div><p>文字：{asset.brandCard.visibleText || '未识别'} · 比例：{asset.brandCard.aspectRatio}</p><p>色彩：{asset.brandCard.colors.join('、') || '未识别'}</p><p>安全区：{asset.brandCard.safeArea}</p><p>禁止：{asset.brandCard.prohibitedTransformations.join('、') || '待确认'}</p>{onNotes && <textarea rows={2} value={asset.brandCard.userNotes} onChange={e => onNotes(asset.id, e.target.value)} placeholder="补充正式品牌手册中的规则（修改后需重新确认）" />}{asset.brandCard.confirmed ? <span className="brand-confirmed">✓ 已由用户确认</span> : <button className="app-btn-primary" onClick={() => onConfirm?.(asset)}>确认并锁定品牌卡</button>}</div>}</>}</article>)}</div>;
}
