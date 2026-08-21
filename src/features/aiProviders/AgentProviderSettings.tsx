import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useAIProviderStore,
  profileToSendSettings,
} from './store';
import { createEmptyProfile, normalizeBaseUrl, applyBillingModeToProfile } from './migration';
import {
  allowCustomModels,
  getBillingModeDefinition,
  getBillingModes,
  getBuiltInRegistry,
  getOfficialApiKeyLink,
  isNewlyDiscovered,
  recommendedModelId,
} from './registry/registry';
import { getProviderAdapter, validateProviderConnection, profileToken } from './adapters';
import { quickTestModelAvailability, deepTestModelAvailability } from './modelTest';
import { refreshModelCatalog, runQuickTestAll, type BatchTestHandle } from './modelCenter';
import { ProviderLogo } from './ProviderLogo';
import './ProviderLogo.css';
import {
  MODEL_ERROR_LABELS,
  MODEL_ERROR_HINTS,
  normalizeLegacyErrorCode,
} from './modelErrors';
import { api } from '../../services/api';
import { toastSuccess } from '../../components/Toast';
import type {
  AIProviderProfile,
  AIProviderType,
  AIProviderModel,
  BillingMode,
  ModelUseScope,
  ProviderCategory,
  ProviderValidationState,
  UseScopes,
} from './types';
import {
  ALL_USE_SCOPES,
  BILLING_MODE_LABELS,
  CAPABILITY_LABELS,
  LIFECYCLE_LABELS,
  PROVIDER_TYPE_LABELS,
  USE_SCOPE_LABELS,
  defaultUseScopes,
  profileCategory,
} from './types';
import { allowsVisionUse } from './store';

type View = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; profileId: string };

const PROVIDER_ADD_OPTIONS: { type: AIProviderType; title: string; desc: string }[] = [
  { type: 'deepseek_official', title: 'DeepSeek 官方', desc: '官方 API，模型来自官方目录与自动发现' },
  { type: 'glm_official', title: '智谱 GLM 官方', desc: '官方 API，模型来自官方目录与自动发现' },
  { type: 'openai_compatible', title: '第三方 API', desc: 'OpenAI Compatible，可自定义模型' },
];

/** V4.0.6 视觉模型类别：图片输入 → 文本/JSON 理解的 Provider 模板（全部真实协议端点） */
const VISION_PROVIDER_ADD_OPTIONS: { type: AIProviderType; title: string; desc: string }[] = [
  { type: 'openai_official', title: 'OpenAI 官方', desc: '官方 API（api.openai.com），视觉理解走多模态接口' },
  { type: 'gemini_official', title: 'Google Gemini 官方', desc: '官方 OpenAI 兼容端点，支持多图比较' },
  { type: 'qwen_official', title: '阿里云百炼 / Qwen', desc: '百炼兼容模式端点，Qwen-VL / Qwen3-VL 视觉系列' },
  { type: 'glm_official', title: '智谱 Vision', desc: 'GLM 官方 API（GLM-4V / GLM-5V 系列视觉模型）' },
  { type: 'openai_compatible', title: '第三方 API', desc: '任何 OpenAI Compatible 视觉服务，可自定义模型' },
];

function providerTypeLabel(type: AIProviderType): string {
  return PROVIDER_TYPE_LABELS[type];
}

async function openApiKeyLink(type: AIProviderType) {
  const url = getOfficialApiKeyLink(type);
  if (!url) return;
  try {
    await api.openExternalUrl(url);
  } catch (error) {
    console.warn('open official link failed', error);
  }
}

/** 统一 Switch（不要用普通 checkbox 表示 Provider / 使用范围状态） */
function Switch(props: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={`settings-switch ${props.checked ? 'on' : ''}`}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="settings-switch-knob" />
    </button>
  );
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 模型行综合状态（合并 lifecycle + 检测状态 + Provider 配置状态） */
function modelStatus(
  model: AIProviderModel,
  hasToken: boolean,
): { cls: 'ok' | 'fail' | 'pending' | 'muted' | 'warn'; text: string } {
  if (model.lifecycle === 'retired') return { cls: 'muted', text: '已下线' };
  if (model.lifecycle === 'missing') return { cls: 'warn', text: '已停止发现' };
  if (!hasToken) return { cls: 'muted', text: '未配置' };
  if (model.test_status === 'testing') return { cls: 'pending', text: '检测中…' };
  if (model.test_status === 'available') {
    if (model.last_check_level === 'quick') return { cls: 'ok', text: '基础验证通过' };
    if (model.last_check_level === 'deep') return { cls: 'ok', text: '当前 Key 可用' };
    return { cls: 'ok', text: '可用' };
  }
  if (model.test_status === 'failed') {
    const code = normalizeLegacyErrorCode(model.last_error_code);
    if (code === 'quick_check_unsupported') return { cls: 'muted', text: '快速检测不支持' };
    return { cls: 'fail', text: '异常' };
  }
  if (model.test_status === 'untested') {
    // 快速检测做过但无法判定（目录未收录 / 接口不支持）：不算异常，也不算可用
    if (model.last_error_code === 'not_in_catalog') return { cls: 'pending', text: '尚未验证调用权限' };
    if (model.last_error_code === 'quick_check_unsupported') return { cls: 'muted', text: '快速检测无法判定' };
  }
  return { cls: 'muted', text: '未测试' };
}

function validationLabel(state: ProviderValidationState | undefined): { text: string; cls: string } {
  switch (state) {
    case 'valid': return { text: '✓ 配置有效', cls: 'form-hint-success' };
    // 「Key 已保存」与「网络/连接检测结果」是两件事：检测失败绝不允许表述成 Key 未保存
    case 'invalid': return { text: '⚠ 配置已保存，但连接检测失败', cls: 'form-hint-warning' };
    case 'validating': return { text: '正在验证连接…', cls: 'form-hint' };
    default: return { text: '✓ 已保存', cls: 'form-hint' };
  }
}

/** 使用范围摘要（列表卡片 / 编辑页共用）：如「对话 · 任务规划 · Prompt 优化」 */
function useScopeSummary(profile: AIProviderProfile): string {
  const scopes = profile.use_scopes ?? defaultUseScopes();
  const parts = ALL_USE_SCOPES.filter(use => scopes[use]).map(use =>
    use === 'prompt_optimizer' ? 'Prompt 优化' : USE_SCOPE_LABELS[use],
  );
  return parts.length > 0 ? parts.join(' · ') : '未启用任何功能';
}

export default function AgentProviderSettings({ category = 'agent' }: { category?: ProviderCategory }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const isVision = category === 'vision';
  const { profiles, defaultProfileId, defaultVisionProfileId } = useAIProviderStore();
  const categoryDefaultId = isVision ? defaultVisionProfileId : defaultProfileId;
  const ordered = useMemo(() => {
    const scoped = profiles.filter(p => profileCategory(p) === category);
    const def = scoped.find(p => p.id === categoryDefaultId);
    const rest = scoped.filter(p => p.id !== categoryDefaultId);
    return def ? [def, ...rest] : rest;
  }, [profiles, categoryDefaultId, category]);

  if (view.kind === 'add') {
    return <AddProfileView onDone={() => setView({ kind: 'list' })} category={category} />;
  }
  if (view.kind === 'edit') {
    return <EditProfileView profileId={view.profileId} onBack={() => setView({ kind: 'list' })} category={category} />;
  }

  const active = isVision ? null : useAIProviderStore.getState().getSelection('');

  return (
    <div className="agent-provider-settings">
      <div className="settings-card agent-current-card">
        <div className="agent-current-head">
          <div>
            <h3 className="settings-section-title">{isVision ? '视觉模型服务' : 'AI 模型服务'}</h3>
            {isVision ? (
              ordered.length > 0 ? (
                <p className="form-hint">
                  {categoryDefaultId
                    ? `默认视觉模型：${ordered.find(p => p.id === categoryDefaultId)?.name ?? ''} / ${ordered.find(p => p.id === categoryDefaultId)?.models.find(m => m.model_id === ordered.find(p => p.id === categoryDefaultId)?.default_model_id)?.display_name ?? ''}`
                    : '尚未设置默认视觉模型服务，将使用第一个已启用服务。'}
                </p>
              ) : (
                <p className="form-hint">尚未配置视觉模型。视觉理解、反向提取 Prompt 与高复刻评审只能使用你自己配置的图片理解模型。</p>
              )
            ) : active ? (
              <p className="form-hint">
                当前默认：{active.profile.name} / {active.model.display_name || active.model.model_id}
                <span className={`agent-dot ${active.model.test_status === 'available' ? 'ok' : active.model.test_status === 'failed' ? 'fail' : 'muted'}`}>●</span>
                {active.model.test_status === 'available'
                  ? (active.model.last_check_level === 'deep' ? '当前 Key 可用' : '基础验证通过')
                  : active.model.test_status === 'failed' ? '测试失败' : '未测试'}
              </p>
            ) : (
              <p className="form-hint">尚未配置 AI 模型服务。AI 对话、任务规划与提示词优化只能使用你自己配置的模型。</p>
            )}
          </div>
        </div>
      </div>

      <div className="agent-provider-list-head">
        <div>
          <h3 className="settings-section-title">已配置的{isVision ? '视觉模型' : '模型'}服务</h3>
          <p className="settings-section-desc">{isVision
            ? '管理用于视觉理解、反向提取 Prompt 与高复刻双图评审的图片理解模型服务。'
            : '管理用于 AI 对话、任务规划、提示词优化和视觉理解的模型服务。'}</p>
        </div>
        <button className="settings-btn settings-btn-primary" onClick={() => setView({ kind: 'add' })}>+ 添加{isVision ? '视觉模型服务' : '模型服务'}</button>
      </div>

      {ordered.length === 0 && (
        <div className="agent-provider-empty">
          <p>还没有配置{isVision ? '视觉模型' : 'AI 模型'}服务。</p>
          <p className="form-hint">{isVision
            ? '可添加 OpenAI 官方、Google Gemini、阿里云百炼 / Qwen、智谱 Vision 或第三方 OpenAI Compatible 视觉服务。'
            : '可添加 DeepSeek 官方、智谱 GLM 官方或第三方 OpenAI Compatible API。'}</p>
        </div>
      )}

      <div className="agent-provider-list">
        {ordered.map(profile => {
          const defaultModel = profile.models.find(m => m.model_id === profile.default_model_id);
          const hasToken = !!profileToken(profile);
          const newCount = profile.models.filter(m => isNewlyDiscovered(m)).length;
          const isProfileVision = profileCategory(profile) === 'vision';
          const visionCount = profile.models.filter(m => m.supports_vision).length;
          return (
            <div className={`agent-provider-card ${profile.id === categoryDefaultId ? 'is-default' : ''}`} key={profile.id}>
              <div className="agent-provider-logo">
                <ProviderLogo providerType={profile.provider_type} name={profile.name} size={28} />
              </div>
              <div className="agent-provider-info">
                <div className="agent-provider-name-row">
                  <strong>{profile.name}</strong>
                  {profile.id === categoryDefaultId && <span className="agent-badge-default">默认</span>}
                  {!profile.enabled && <span className="agent-badge-disabled">已停用</span>}
                  {profile.billing_mode && <span className="agent-badge-muted">{BILLING_MODE_LABELS[profile.billing_mode]}</span>}
                  <span className={`form-hint ${hasToken ? 'form-hint-success' : ''}`}>
                    {hasToken ? '✓ 已配置' : '○ 未配置 API Key'}
                  </span>
                </div>
                <p className="form-hint agent-provider-meta">
                  <span>
                    {providerTypeLabel(profile.provider_type)}
                    {profile.billing_mode && getBillingModes(profile.provider_type).length > 1
                      ? `（${BILLING_MODE_LABELS[profile.billing_mode]}）`
                      : ''}
                    {hasToken
                      ? `${defaultModel ? ` · ${defaultModel.display_name || defaultModel.model_id}` : ''} · ${isProfileVision ? `${visionCount} 个视觉模型` : `${profile.models.length} 个模型`}`
                      : ''}
                    {newCount > 0 && ` · ✨${newCount} 个新模型`}
                    {profile.last_model_sync_at && ` · 同步于 ${formatRelativeTime(profile.last_model_sync_at)}`}
                  </span>
                </p>
                {hasToken && (
                  <p className="form-hint agent-provider-meta">
                    {isProfileVision ? '用于视觉理解 · 反向提取 Prompt · 高复刻评审' : useScopeSummary(profile)}
                  </p>
                )}
              </div>
              <div className="agent-provider-actions">
                {profile.id !== categoryDefaultId && profile.enabled && (
                  <button className="settings-btn settings-btn-outline settings-btn-sm" onClick={() => useAIProviderStore.getState().setDefaultProfile(profile.id)}>设为默认</button>
                )}
                <button
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={() => setView({ kind: 'edit', profileId: profile.id })}
                >
                  {hasToken ? '管理' : '配置'}
                </button>
                <button
                  className="settings-btn settings-btn-danger settings-btn-sm"
                  onClick={() => {
                    const usingHint = profile.id === categoryDefaultId ? '该模型服务是当前默认，删除后将自动切换到其它可用服务。' : '';
                    if (window.confirm(`确认删除模型服务「${profile.name}」？${usingHint}`)) {
                      useAIProviderStore.getState().removeProfile(profile.id);
                    }
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddProfileView({ onDone, category = 'agent' }: { onDone: () => void; category?: ProviderCategory }) {
  const [selectedType, setSelectedType] = useState<AIProviderType | null>(null);
  const addProfile = useAIProviderStore(state => state.addProfile);
  const isVision = category === 'vision';
  const addOptions = isVision ? VISION_PROVIDER_ADD_OPTIONS : PROVIDER_ADD_OPTIONS;

  if (!selectedType) {
    return (
      <div className="agent-provider-settings">
        <div className="agent-edit-head">
          <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={onDone}>← 返回</button>
          <h3 className="settings-section-title">添加{isVision ? '视觉模型' : 'AI 模型'}服务</h3>
        </div>
        <p className="settings-section-desc">{isVision
          ? '选择视觉 Provider 后配置 API Key，模型将自动同步。视觉模型只用于图片理解（分析 / 反向 Prompt / 双图评审），不会用于图片生成。'
          : '选择 Provider 后配置 API Key，模型将自动同步。创作能力（文生图 / 图生图 / 任务规划）属于 CyImagePro 本身，与 Provider 无关。'}</p>
        <div className="agent-add-grid">
          {addOptions.map(option => (
            <button key={option.type} className="agent-add-card" onClick={() => setSelectedType(option.type)}>
              <ProviderLogo providerType={option.type} name={option.title} size={22} />
              <strong>{option.title}</strong>
              <p>{option.desc}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return <ProfileFormView
    providerType={selectedType}
    category={category}
    initial={createEmptyProfile(selectedType, '', category)}
    submitLabel="保存配置"
    onCancel={onDone}
    onSubmit={profile => {
      addProfile(profile);
      onDone();
    }}
  />;
}

function EditProfileView({ profileId, onBack, category = 'agent' }: { profileId: string; onBack: () => void; category?: ProviderCategory }) {
  const profile = useAIProviderStore(state => state.profiles.find(p => p.id === profileId));
  const updateProfile = useAIProviderStore(state => state.updateProfile);
  if (!profile) {
    return (
      <div className="agent-provider-settings">
        <p className="form-hint">该模型服务不存在（可能已被删除）。</p>
        <button className="settings-btn settings-btn-secondary" onClick={onBack}>返回</button>
      </div>
    );
  }
  return (
    <ProfileFormView
      providerType={profile.provider_type}
      category={category}
      initial={profile}
      isEdit
      submitLabel="保存"
      onCancel={onBack}
      onSubmit={draft => {
        // 模型与 Key 已即时持久化；此处只提交表单类字段
        // billing_mode / base_url 由切换动作即时持久化，此处仅兜底同步镜像
        // 返回 persist 结果：localStorage 写入失败时向用户暴露保存错误
        return updateProfile(profile.id, {
          name: draft.name,
          base_url: draft.base_url,
          ...(draft.billing_mode ? { billing_mode: draft.billing_mode } : {}),
          context_window: draft.context_window,
          fallback_token: draft.fallback_token,
          enabled: draft.enabled,
        });
      }}
      onSaved={() => { /* 保存后留在编辑页，由保存状态条给出反馈 */ }}
    />
  );
}

type CredentialUiState = 'missing' | 'dirty' | 'saved' | 'validating' | 'valid' | 'invalid';

type FormSaveState = 'idle' | 'saving' | 'success' | 'error';

/** 需要点击「保存」才持久化的表单字段（模型 / Key / 使用范围 / 启用状态为即时持久化，不参与 dirty 判定）。 */
type FormShape = Pick<AIProviderProfile, 'name' | 'base_url' | 'context_window' | 'fallback_token'>;

function pickFormShape(profile: AIProviderProfile): FormShape {
  return {
    name: profile.name,
    base_url: profile.base_url,
    context_window: profile.context_window,
    fallback_token: profile.fallback_token,
  };
}

function sameFormShape(a: FormShape, b: FormShape): boolean {
  return a.name === b.name
    && a.base_url === b.base_url
    && a.context_window === b.context_window
    && a.fallback_token === b.fallback_token;
}

function UnsavedChangesDialog(props: {
  onSaveAndLeave: () => void;
  onDiscard: () => void;
  onContinue: () => void;
  saving: boolean;
}) {
  return (
    <div className="template-modal-overlay" onClick={e => e.stopPropagation()}>
      <div className="template-modal unsaved-dialog" role="alertdialog" aria-label="有未保存的修改">
        <div className="template-modal-header">
          <h3>当前模型服务有未保存的修改</h3>
        </div>
        <div className="template-modal-body">
          <p className="form-hint">离开将丢失未保存的修改（名称 / Base URL 等表单内容）。</p>
        </div>
        <div className="template-modal-footer">
          <button className="settings-btn settings-btn-outline" disabled={props.saving} onClick={props.onContinue}>继续编辑</button>
          <button className="settings-btn settings-btn-secondary" disabled={props.saving} onClick={props.onDiscard}>放弃修改</button>
          <button className="settings-btn settings-btn-primary" disabled={props.saving} onClick={props.onSaveAndLeave}>
            {props.saving ? '保存中…' : '保存并离开'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileFormView(props: {
  providerType: AIProviderType;
  category?: ProviderCategory;
  initial: AIProviderProfile;
  isEdit?: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (draft: AIProviderProfile) => boolean | void;
  onSaved?: () => void;
}) {
  const { providerType, initial, isEdit } = props;
  const isVision = (props.category ?? profileCategory(initial)) === 'vision';
  const billingModes = getBillingModes(providerType);
  const isCustom = allowCustomModels(providerType);
  const apiKeyLink = getOfficialApiKeyLink(providerType);

  // 编辑模式：模型中心直接订阅 store 内的实时 profile（Key / 模型 / 使用范围操作即时生效）
  const liveProfile = useAIProviderStore(state =>
    isEdit ? state.profiles.find(p => p.id === initial.id) : undefined,
  );

  const [draft, setDraft] = useState<AIProviderProfile>(() => ({ ...initial }));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [connDetailOpen, setConnDetailOpen] = useState(!!initial.api_key);
  const [formError, setFormError] = useState('');

  // ===== 表单 dirty state / 保存状态机 / 离开保护 =====
  const [baseline, setBaseline] = useState<FormShape>(() => pickFormShape(initial));
  const [saveState, setSaveState] = useState<FormSaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(isEdit ? initial.updated_at : null);
  const [guardVisible, setGuardVisible] = useState(false);
  const [, forceTick] = useState(0);

  const dirty = !sameFormShape(pickFormShape(draft), baseline);

  // 「最后保存：3 分钟前」相对时间需要周期性刷新
  useEffect(() => {
    if (!lastSavedAt) return;
    const timer = setInterval(() => forceTick(v => v + 1), 30_000);
    return () => clearInterval(timer);
  }, [lastSavedAt]);

  const saveStatusLabel = saveState === 'error'
    ? '保存失败，请重试'
    : dirty
      ? '● 有未保存的修改'
      : lastSavedAt
        ? `✓ 已保存 · 最后保存：${formatRelativeTime(lastSavedAt)}`
        : '✓ 已保存';

  // ===== API Key 显式保存状态机 =====
  const effectiveProfile = liveProfile || draft;
  const activeBillingMode = effectiveProfile.billing_mode;
  /** 官方 Provider 的固定地址按当前使用方式解析（UI 只读展示） */
  const officialBaseUrlFixed = getProviderAdapter(providerType).fixedBaseUrl(activeBillingMode);
  const activeBillingDef = getBillingModeDefinition(providerType, activeBillingMode);
  const savedKey = effectiveProfile.api_key;
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyDraftValue, setKeyDraftValue] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyFlowNote, setKeyFlowNote] = useState('');
  const keyInputRef = useRef<HTMLInputElement>(null);

  const hasToken = !!profileToken(effectiveProfile);
  const validationState: ProviderValidationState = effectiveProfile.validation_state || 'unknown';

  const credentialState: CredentialUiState = keyEditing && keyDraftValue !== savedKey
    ? 'dirty'
    : validationState === 'validating' ? 'validating'
      : validationState === 'valid' ? 'valid'
        : validationState === 'invalid' ? 'invalid'
          : savedKey ? 'saved'
            : 'missing';

  const store = useAIProviderStore;
  const patch = (partial: Partial<AIProviderProfile>) => setDraft(current => ({ ...current, ...partial }));

  function confirmDiscardKeyEdit(): boolean {
    if (keyEditing && keyDraftValue.trim() && keyDraftValue !== savedKey) {
      return window.confirm('API Key 有未保存修改，离开将丢失。确认离开？');
    }
    return true;
  }

  /** 保存 Key → 验证 Provider → 同步模型目录（完整推荐流程） */
  async function persistKey(rawValue: string) {
    const value = rawValue.trim();
    setKeySaving(true);
    setKeyFlowNote('');
    try {
      if (isEdit && liveProfile) {
        store.getState().saveApiKey(initial.id, value);
        patch({ api_key: value, api_key_saved_at: new Date().toISOString() });
      } else {
        patch({ api_key: value, api_key_saved_at: new Date().toISOString() });
      }
      setKeyEditing(false);
      setKeyDraftValue('');

      // 验证 Provider（快速，不产生生成请求）
      const target = { ...effectiveProfile, api_key: value, fallback_token: effectiveProfile.fallback_token };
      if (isEdit && liveProfile) store.getState().setValidationState(initial.id, 'validating');
      const validation = await validateProviderConnection(target);
      if (isEdit && liveProfile) {
        store.getState().setValidationState(initial.id, validation.ok ? 'valid' : 'invalid');
      } else {
        patch({ validation_state: validation.ok ? 'valid' : 'invalid' });
      }
      if (!validation.ok && validation.errorCode !== 'quick_check_unsupported') {
        setKeyFlowNote(`API Key 已保存，但验证失败：${MODEL_ERROR_LABELS[validation.errorCode || 'unknown']}`);
      }

      // 验证成功（或快速检测不支持但鉴权已通过）→ 同步模型目录
      if (validation.ok || validation.errorCode === 'quick_check_unsupported') {
        const profileForSync = { ...target, models: liveProfile?.models || draft.models };
        const report = await refreshModelCatalog(profileForSync);
        if (report.models) {
          const syncedAt = new Date().toISOString();
          if (isEdit && liveProfile) {
            store.getState().applyModelSync(initial.id, report.models, syncedAt);
          } else {
            patch({ models: report.models, last_model_sync_at: syncedAt });
          }
        }
      }
    } finally {
      setKeySaving(false);
    }
  }

  function handleClearKey() {
    if (!window.confirm('确认清除已保存的 API Key？')) return;
    if (isEdit && liveProfile) {
      store.getState().clearApiKey(initial.id);
    }
    patch({ api_key: '', api_key_saved_at: new Date().toISOString(), validation_state: 'unknown' });
    setKeyEditing(false);
    setKeyDraftValue('');
    setKeyFlowNote('API Key 已清除。');
  }

  /**
   * 切换使用方式（如 智谱 API ↔ Coding Plan）。
   * 当前模式的 Key / 模型目录 / 默认模型先存回该模式，再加载目标模式已保存状态 ——
   * 两个模式的 API Key 互不覆盖；Base URL 由 resolver 自动切换，不可手填。
   */
  function handleBillingModeChange(mode: BillingMode) {
    if (mode === activeBillingMode) return;
    if (isEdit && liveProfile) {
      store.getState().setBillingMode(initial.id, mode);
      const updated = store.getState().profiles.find(p => p.id === initial.id);
      if (updated) {
        setDraft(current => ({
          ...current,
          billing_mode: updated.billing_mode,
          base_url: updated.base_url,
          api_key: updated.api_key,
          api_key_saved_at: updated.api_key_saved_at,
          validation_state: updated.validation_state,
          last_validated_at: updated.last_validated_at,
          models: updated.models,
          last_model_sync_at: updated.last_model_sync_at,
          default_model_id: updated.default_model_id,
          vision_model_id: updated.vision_model_id,
          mode_states: updated.mode_states,
        }));
      }
    } else {
      setDraft(current => applyBillingModeToProfile(current, mode));
    }
    setKeyEditing(false);
    setKeyDraftValue('');
    setKeyFlowNote('');
  }

  /** 执行保存；返回是否成功。成功后刷新 baseline / 保存时间 / 状态条。 */
  async function persistDraft(): Promise<boolean> {
    if (!draft.name.trim()) {
      setFormError('请填写名称。');
      return false;
    }
    const submitted = isCustom ? { ...draft, base_url: normalizeBaseUrl(draft.base_url) } : draft;
    if (isCustom && !submitted.base_url) {
      setFormError('请填写 Base URL。');
      return false;
    }
    setSaveState('saving');
    setFormError('');
    try {
      const result = props.onSubmit(submitted);
      if (result === false) {
        setSaveState('error');
        return false;
      }
      setBaseline(pickFormShape(submitted));
      setLastSavedAt(new Date().toISOString());
      setSaveState('success');
      return true;
    } catch {
      setSaveState('error');
      return false;
    }
  }

  async function submit() {
    if (!confirmDiscardKeyEdit()) return;
    const ok = await persistDraft();
    if (ok) {
      toastSuccess('模型服务配置已保存');
      props.onSaved?.();
    }
  }

  /** 离开保护：dirty 时弹出自定义三选项对话框，绝不静默丢弃表单修改。 */
  function requestLeave() {
    if (!confirmDiscardKeyEdit()) return;
    if (dirty) {
      setGuardVisible(true);
      return;
    }
    props.onCancel();
  }

  async function saveAndLeave() {
    const ok = await persistDraft();
    if (!ok) return;
    toastSuccess('模型服务配置已保存');
    setGuardVisible(false);
    props.onSaved?.();
    props.onCancel();
  }

  function requestConfigureKey() {
    setKeyEditing(true);
    setTimeout(() => keyInputRef.current?.focus(), 50);
  }

  /** Provider 总开关：整个 Provider 是否启用（即时持久化，不走表单保存） */
  function handleEnabledToggle(next: boolean) {
    if (isEdit && liveProfile) {
      store.getState().setEnabled(initial.id, next);
    }
    patch({ enabled: next });
  }

  const showModelCenter = hasToken || keyEditing;
  const missingKey = !hasToken && !keyEditing;

  return (
    <div className="agent-provider-settings">
      <div className="agent-edit-head">
        <button
          className="settings-btn settings-btn-secondary settings-btn-sm"
          onClick={requestLeave}
        >
          ← 返回
        </button>
        <h3 className="settings-section-title">
          {isEdit
            ? `${isVision ? '视觉模型服务' : 'AI 模型服务'} › ${initial.name}`
            : `添加${isVision ? '视觉模型' : '模型'}服务 › ${providerTypeLabel(providerType)}`}
        </h3>
        <div className="provider-enabled-toggle">
          <span className="form-hint">{effectiveProfile.enabled ? '已启用' : '已停用'}</span>
          <Switch checked={effectiveProfile.enabled} onChange={handleEnabledToggle} label="启用该模型服务" />
        </div>
      </div>

      <section className="settings-card">
        <h4 className="settings-subsection-title">基本信息</h4>
        <div className="form-row">
          <div className="form-group">
            <label>名称</label>
            <input value={draft.name} onChange={e => patch({ name: e.target.value })} placeholder="例如：DeepSeek 官方 / 我的备用线路" />
          </div>
          <div className="form-group">
            <label>Provider 类型</label>
            <div className="provider-type-row">
              <ProviderLogo providerType={providerType} name={initial.name} size={18} />
              <input value={providerTypeLabel(providerType)} disabled />
            </div>
          </div>
        </div>
      </section>

      {/* ================= 连接配置 ================= */}
      <section className="settings-card">
        <h4 className="settings-subsection-title">连接配置</h4>

        {/* 使用方式（仅 registry 声明了多种模式的官方 Provider 显示；DeepSeek 等单模式 Provider 不渲染） */}
        {billingModes.length > 1 && (
          <div className="form-group">
            <label>使用方式</label>
            <div className="billing-mode-tabs">
              {billingModes.map(def => (
                <button
                  key={def.mode}
                  type="button"
                  className={`billing-mode-tab ${activeBillingMode === def.mode ? 'active' : ''}`}
                  onClick={() => handleBillingModeChange(def.mode)}
                >
                  {def.label}
                </button>
              ))}
            </div>
            {activeBillingDef && <p className="form-hint">{activeBillingDef.description}</p>}
            {activeBillingDef?.notes?.map(note => (
              <p key={note} className={`form-hint ${activeBillingMode === 'coding_plan' ? 'form-hint-warning' : ''}`}>{note}</p>
            ))}
          </div>
        )}

        {missingKey ? (
          /* ---------- 未配置 API Key：明显 Empty State，不展开无意义内容 ---------- */
          <div className="api-key-empty-state">
            <div className="api-key-empty-head">
              <span className="agent-dot muted">○</span>
              <strong>尚未配置</strong>
            </div>
            <p className="form-hint">需要配置 API Key 后才能同步和使用模型。</p>
            <div className="settings-actions-row">
              <button className="settings-btn settings-btn-primary settings-btn-sm" onClick={requestConfigureKey}>配置 API Key</button>
              {apiKeyLink && (
                <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => void openApiKeyLink(providerType)}>
                  获取官方 API Key ↗
                </button>
              )}
            </div>
            {!apiKeyLink && isCustom && <p className="form-hint">请从您的 API 服务提供商获取 API Key。</p>}
            <p className="form-hint">配置完成后将自动同步模型。</p>
          </div>
        ) : (
          <div className="form-group">
            <label>API Key</label>
            {!keyEditing ? (
              <div className="api-key-saved-row">
                {savedKey
                  ? <span className="api-key-masked">{'•'.repeat(20)}</span>
                  : <span className="form-hint">未配置 API Key</span>}
                <div className="api-key-actions">
                  {credentialState === 'dirty' && <span className="form-hint form-hint-warning">● 有未保存修改</span>}
                  {savedKey && credentialState !== 'dirty' && (
                    <span className={`form-hint ${credentialState === 'valid' ? 'form-hint-success' : credentialState === 'invalid' ? 'form-hint-error' : ''}`}>
                      {validationLabel(credentialState === 'saved' || credentialState === 'missing' ? undefined : validationState).text}
                      {effectiveProfile.api_key_saved_at && ` · 更新于 ${formatRelativeTime(effectiveProfile.api_key_saved_at)}`}
                    </span>
                  )}
                  <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={requestConfigureKey}>
                    {savedKey ? '修改' : '配置 API Key'}
                  </button>
                  {savedKey && (
                    <button className="settings-btn settings-btn-outline settings-btn-sm" onClick={handleClearKey}>清除</button>
                  )}
                  {apiKeyLink && (
                    <button className="settings-btn settings-btn-link settings-btn-sm" onClick={() => void openApiKeyLink(providerType)}>
                      API Key 管理 ↗
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="api-key-editing">
                <input
                  ref={keyInputRef}
                  type="password"
                  value={keyDraftValue}
                  onChange={e => setKeyDraftValue(e.target.value)}
                  placeholder={savedKey ? '输入新的 API Key' : 'sk-...'}
                  autoComplete="off"
                />
                <div className="api-key-actions">
                  {keyDraftValue && keyDraftValue !== savedKey && <span className="form-hint form-hint-warning">● 有未保存修改</span>}
                  <button
                    className="settings-btn settings-btn-primary settings-btn-sm"
                    disabled={keySaving || !keyDraftValue.trim()}
                    onClick={() => void persistKey(keyDraftValue)}
                  >
                    {keySaving ? '保存并验证中…' : savedKey ? '保存修改' : '保存配置'}
                  </button>
                  <button
                    className="settings-btn settings-btn-secondary settings-btn-sm"
                    disabled={keySaving}
                    onClick={() => { setKeyEditing(false); setKeyDraftValue(''); }}
                  >
                    取消
                  </button>
                  {apiKeyLink && (
                    <button className="settings-btn settings-btn-link settings-btn-sm" onClick={() => void openApiKeyLink(providerType)}>
                      获取官方 API Key ↗
                    </button>
                  )}
                </div>
                <p className="form-hint">保存后将自动验证连接并同步模型目录（不会发送生成请求，不产生 Token 消耗）。</p>
                {!apiKeyLink && isCustom && <p className="form-hint">请从您的 API 服务提供商获取 API Key。</p>}
              </div>
            )}
            {keyFlowNote && <p className={`form-hint ${credentialState === 'invalid' ? 'form-hint-warning' : 'form-hint-success'}`}>{keyFlowNote}</p>}
            {credentialState === 'invalid' && !keyFlowNote && (
              <p className="form-hint form-hint-warning">
                连接检测失败。API Key 已保存 —— 检测失败可能是网络、余额或模型权限问题，不一定是 Key 错误。
              </p>
            )}
          </div>
        )}

        <div className="form-group">
          <button className="settings-btn settings-btn-link" onClick={() => setConnDetailOpen(v => !v)}>
            {connDetailOpen ? '▾' : '▸'} 连接详情
          </button>
          {connDetailOpen && (
            <div className="conn-detail">
              {officialBaseUrlFixed ? (
                <div className="form-group">
                  <label>API 地址</label>
                  <input value={officialBaseUrlFixed} disabled />
                  <p className="form-hint">
                    🔒 {activeBillingDef?.notes?.[0] || '官方 Provider 地址，由 CyImagePro 管理，不可修改'}
                    {activeBillingMode && billingModes.length > 1 ? `（${BILLING_MODE_LABELS[activeBillingMode]}）` : ''}
                  </p>
                </div>
              ) : (
                <div className="form-group">
                  <label>Base URL</label>
                  <input value={draft.base_url} onChange={e => patch({ base_url: e.target.value })} placeholder="https://example.com/v1" />
                  <p className="form-hint">第三方 API：Base URL 由你的服务提供商提供。</p>
                </div>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label>协议</label>
                  <input value="OpenAI Compatible" disabled />
                </div>
                <div className="form-group">
                  <label>Provider ID</label>
                  <input value={providerType} disabled />
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ================= 模型中心 / 使用范围 / 默认模型（未配置 Key 时折叠为引导） ================= */}
      {showModelCenter ? (
        <>
          <ModelCenterSection
            profile={effectiveProfile}
            serviceCategory={isVision ? 'vision' : 'agent'}
            onSynced={(models, syncedAt, extra) => {
              if (isEdit && liveProfile) {
                if (extra) store.getState().updateProfile(initial.id, extra);
                store.getState().applyModelSync(initial.id, models, syncedAt);
              } else {
                patch({ models, last_model_sync_at: syncedAt, ...extra });
              }
            }}
          />
          {!isVision && (
            <UseScopeSection profile={effectiveProfile} isEdit={!!isEdit} profileId={initial.id} onDraftChange={patch} />
          )}
          <DefaultModelSection
            category={isVision ? 'vision' : 'agent'}
            profile={effectiveProfile}
            isEdit={!!isEdit}
            profileId={initial.id}
            onDraftChange={patch}
          />
        </>
      ) : (
        <section className="settings-card">
          <h4 className="settings-subsection-title">模型</h4>
          <p className="form-hint">尚未配置 API Key。保存 API Key 后将自动同步模型。</p>
        </section>
      )}

      <section className="settings-card">
        <button className="settings-btn settings-btn-link" onClick={() => setAdvancedOpen(v => !v)}>
          {advancedOpen ? '▾' : '▸'} 高级设置
        </button>
        {advancedOpen && (
          <div className="form-row">
            <div className="form-group">
              <label>上下文窗口</label>
              <input
                type="number"
                min={4096}
                value={draft.context_window}
                onChange={e => patch({ context_window: Math.max(4096, parseInt(e.target.value || '32768', 10) || 32768) })}
              />
            </div>
            {isCustom && (
              <div className="form-group">
                <label>对话 Token 兜底</label>
                <input
                  type="password"
                  value={draft.fallback_token}
                  onChange={e => patch({ fallback_token: e.target.value })}
                  placeholder="API Key 为空时兜底"
                />
                <p className="form-hint">仅在 API Key 为空时使用。</p>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="agent-edit-footer">
        <div className="agent-save-status">
          <span
            className={`form-hint ${saveState === 'error' ? 'form-hint-error' : dirty ? 'form-hint-warning' : 'form-hint-success'}`}
            aria-live="polite"
          >
            {saveStatusLabel}
          </span>
        </div>
        <div className="agent-edit-footer-actions">
          <button className="settings-btn settings-btn-secondary" onClick={requestLeave}>取消</button>
          <button
            className="settings-btn settings-btn-primary"
            disabled={saveState === 'saving' || (!dirty && saveState === 'success')}
            onClick={() => void submit()}
          >
            {saveState === 'saving'
              ? '保存中…'
              : saveState === 'error'
                ? '重新保存'
                : !dirty && isEdit && saveState === 'success'
                  ? '✓ 已保存'
                  : props.submitLabel}
          </button>
        </div>
      </div>
      {formError && <p className="form-hint form-hint-error">{formError}</p>}
      {guardVisible && (
        <UnsavedChangesDialog
          saving={saveState === 'saving'}
          onContinue={() => setGuardVisible(false)}
          onDiscard={() => { setGuardVisible(false); props.onCancel(); }}
          onSaveAndLeave={() => void saveAndLeave()}
        />
      )}
    </div>
  );
}

// ============================================================
// 模型中心
// ============================================================

/**
 * 模型中心分类（档案类别感知）：
 * - agent 档案：全部模型 / 支持视觉（视觉模型可作为对话模型的图片理解能力出现）
 * - vision 档案：视觉模型（默认，按 capabilities 筛选）/ 全部模型
 * - 「推理 / Tools / 结构化输出」等是 Capability Tag，展示在模型卡上，不做一级分类
 * - 「手动添加」（model_source=custom）与「能力待识别」（capabilities=['unknown']）是内部概念，
 *   不作为普通用户的一级 Tab；图片 / 视频模型属于其它设置模块
 */
type ModelCategory = 'all' | 'vision';

const AGENT_CATEGORY_TABS: { key: ModelCategory; label: string }[] = [
  { key: 'all', label: '全部模型' },
  { key: 'vision', label: '支持视觉' },
];

const VISION_CATEGORY_TABS: { key: ModelCategory; label: string }[] = [
  { key: 'vision', label: '视觉模型' },
  { key: 'all', label: '全部模型' },
];

function ModelCenterSection(props: {
  profile: AIProviderProfile;
  serviceCategory: ProviderCategory;
  onSynced: (models: AIProviderModel[], syncedAt: string, extra?: Partial<AIProviderProfile>) => void;
}) {
  const { profile } = props;
  const isVision = props.serviceCategory === 'vision';
  const isCustom = allowCustomModels(profile.provider_type);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ModelCategory>(isVision ? 'vision' : 'all');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [testingRow, setTestingRow] = useState<string | null>(null);
  const [detailModel, setDetailModel] = useState<AIProviderModel | null>(null);
  const [configModel, setConfigModel] = useState<AIProviderModel | null>(null);
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [newModelVision, setNewModelVision] = useState(isVision);
  const [addError, setAddError] = useState('');

  // 并发安全的模型列表基准：批量检测两个 worker 同时回写时避免互相覆盖
  const modelsRef = useRef<AIProviderModel[]>(profile.models);
  modelsRef.current = profile.models;
  const batchHandleRef = useRef<BatchTestHandle | null>(null);
  useEffect(() => () => batchHandleRef.current?.cancel(), []);

  function commitModels(updater: (models: AIProviderModel[]) => AIProviderModel[], extra?: Partial<AIProviderProfile>) {
    const next = updater(modelsRef.current);
    modelsRef.current = next;
    props.onSynced(next, profile.last_model_sync_at || new Date().toISOString(), extra);
  }

  const recommended = useMemo(
    () => recommendedModelId(getBuiltInRegistry(profile.provider_type)?.models || []),
    [profile.provider_type],
  );

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return profile.models.filter(model => {
      if (category === 'vision' && !model.supports_vision) return false;
      if (!keyword) return true;
      const haystack = [
        model.display_name,
        model.model_id,
        model.capabilities.map(c => CAPABILITY_LABELS[c]).join('/'),
      ].join(' ').toLowerCase();
      return haystack.includes(keyword);
    });
  }, [profile.models, search, category]);

  // 正在被 default/vision 引用、但已停止发现/下线的模型 → 迁移建议（绝不自动切换）
  const staleReferenced = useMemo(() => {
    const refIds = new Set([
      profile.default_model_id,
      profile.vision_model_id,
      profile.planner_model_id,
      profile.prompt_optimizer_model_id,
    ].filter(Boolean));
    return profile.models.filter(m => refIds.has(m.model_id)
      && (m.lifecycle === 'missing' || m.lifecycle === 'retired'));
  }, [profile.models, profile.default_model_id, profile.vision_model_id, profile.planner_model_id, profile.prompt_optimizer_model_id]);

  async function refreshModels() {
    setRefreshing(true);
    setRefreshNote('正在同步模型目录…');
    try {
      const report = await refreshModelCatalog(profile, { forceRemote: true });
      if (report.errorCode === 'stale') return;
      modelsRef.current = report.models;
      props.onSynced(report.models, new Date().toISOString());
      const parts: string[] = [];
      parts.push(`已同步 ${report.models.length} 个模型`);
      if (report.added.length > 0) parts.push(`新增 ${report.added.length} 个`);
      if (report.updated.length > 0) parts.push(`更新 ${report.updated.length} 个`);
      if (report.missing.length > 0) parts.push(`${report.missing.length} 个可能已停止提供`);
      if (report.discoveryUnsupported) {
        parts.push('当前接口不支持动态获取模型，已使用官方内置模型列表');
      }
      setRefreshNote(parts.join('，'));
    } finally {
      setRefreshing(false);
    }
  }

  function startBatchTest() {
    if (batch) return;
    const candidates = modelsRef.current.filter(m => m.enabled && m.lifecycle !== 'retired');
    const handle = runQuickTestAll(profile, candidates, {
      onProgress: (done, total) => setBatch(prev => (prev ? { ...prev, done, total } : prev)),
      onModelResult: (rowId, _modelId, result) => {
        // inconclusive（接口不支持快速检测）不标红：保持 untested，仅记录原因
        if (result.inconclusive) {
          commitModels(models => models.map(m => m.id === rowId
            ? { ...m, last_error_code: result.last_error_code, last_error_message: result.last_error_message }
            : m));
          return;
        }
        commitModels(models => models.map(m => m.id === rowId
          ? {
              ...m,
              test_status: result.test_status,
              last_tested_at: new Date().toISOString(),
              last_latency_ms: result.last_latency_ms,
              last_check_level: 'quick',
              last_error_code: result.last_error_code,
              last_error_message: result.last_error_message,
              last_error_status: result.last_error_status,
            }
          : m));
      },
    });
    batchHandleRef.current = handle;
    setBatch({ done: 0, total: candidates.length });
    void handle.promise.then(() => {
      batchHandleRef.current = null;
      setBatch(null);
    });
  }

  async function quickTestOne(model: AIProviderModel) {
    setTestingRow(model.id);
    try {
      const outcome = await quickTestModelAvailability(profile, model);
      const keepUntested = !outcome.ok && outcome.inconclusive;
      commitModels(models => models.map(m => m.id === model.id
        ? {
            ...m,
            test_status: keepUntested ? m.test_status : (outcome.ok ? 'available' : 'failed') as AIProviderModel['test_status'],
            last_tested_at: new Date().toISOString(),
            last_latency_ms: outcome.latencyMs,
            last_check_level: 'quick',
            last_error_code: outcome.errorCode,
            last_error_message: outcome.errorMessage,
            last_error_status: outcome.httpStatus,
          }
        : m));
    } finally {
      setTestingRow(null);
    }
  }

  async function deepTestOne(model: AIProviderModel) {
    if (!window.confirm(`深度测试会向「${model.model_id}」发送一次最小请求，可能产生少量 Token 或接口调用费用。确认执行？`)) return;
    setTestingRow(model.id);
    try {
      const outcome = await deepTestModelAvailability(profile, model);
      commitModels(models => models.map(m => m.id === model.id
        ? {
            ...m,
            test_status: (outcome.ok ? 'available' : 'failed') as AIProviderModel['test_status'],
            last_tested_at: new Date().toISOString(),
            last_latency_ms: outcome.latencyMs,
            last_check_level: 'deep',
            last_error_code: outcome.errorCode,
            last_error_message: outcome.errorMessage,
            last_error_status: outcome.httpStatus,
          }
        : m));
    } finally {
      setTestingRow(null);
    }
  }

  function removeCustomModelRow(model: AIProviderModel) {
    const inUse = [profile.default_model_id, profile.vision_model_id, profile.planner_model_id, profile.prompt_optimizer_model_id]
      .includes(model.model_id);
    if (inUse && !window.confirm('该模型正在被默认模型引用，删除后将切换到其它模型。确认删除？')) return;
    if (!inUse && !window.confirm(`确认删除模型「${model.display_name || model.model_id}」？`)) return;
    const remaining = modelsRef.current.filter(m => m.id !== model.id);
    const patch: Partial<AIProviderProfile> = {};
    if (profile.default_model_id === model.model_id) patch.default_model_id = remaining[0]?.model_id || '';
    if (profile.vision_model_id === model.model_id) patch.vision_model_id = '';
    if (profile.planner_model_id === model.model_id) patch.planner_model_id = '';
    if (profile.prompt_optimizer_model_id === model.model_id) patch.prompt_optimizer_model_id = '';
    commitModels(() => remaining, patch);
  }

  return (
    <section className="settings-card">
      <div className="model-center-head">
        <div>
          <h4 className="settings-subsection-title">模型</h4>
          <p className="form-hint">
            {isVision
              ? `已同步 ${profile.models.length} 个模型 · ${profile.models.filter(m => m.supports_vision).length} 个支持视觉理解`
              : `已同步 ${profile.models.length} 个模型`}
            {profile.last_model_sync_at && ` · 最后同步：${formatRelativeTime(profile.last_model_sync_at)}`}
          </p>
        </div>
        <div className="settings-actions-row">
          <button className="settings-btn settings-btn-secondary settings-btn-sm" disabled={refreshing} onClick={() => void refreshModels()}>
            {refreshing ? '同步中…' : '刷新模型'}
          </button>
          {batch ? (
            <>
              <span className="form-hint">正在检测 {batch.done} / {batch.total}</span>
              <button className="settings-btn settings-btn-outline settings-btn-sm" onClick={() => { batchHandleRef.current?.cancel(); batchHandleRef.current = null; setBatch(null); }}>取消检测</button>
            </>
          ) : (
            <button className="settings-btn settings-btn-secondary settings-btn-sm" disabled={refreshing} onClick={startBatchTest}>
              检测全部
            </button>
          )}
        </div>
      </div>
      {refreshNote && <p className="form-hint">{refreshNote}</p>}
      <p className="form-hint">快速检测不会主动生成内容，通常不会产生模型 Token 消耗；深度测试会发送最小生成请求。</p>

      {staleReferenced.length > 0 && (
        <div className="model-stale-warning">
          <p className="form-hint form-hint-warning">
            ⚠ 默认模型「{staleReferenced[0].display_name || staleReferenced[0].model_id}」已{LIFECYCLE_LABELS[staleReferenced[0].lifecycle]}，配置保持不变。
            {recommended && `建议迁移：${recommended}`}
          </p>
          {recommended && (
            <div className="settings-actions-row">
              <button
                className="settings-btn settings-btn-secondary settings-btn-sm"
                onClick={() => {
                  if (window.confirm(`将默认模型迁移为「${recommended}」？`)) {
                    commitModels(models => models, { default_model_id: recommended });
                  }
                }}
              >
                迁移模型
              </button>
              <button className="settings-btn settings-btn-outline settings-btn-sm" onClick={() => setRefreshNote('已保留当前模型配置。')}>暂不处理</button>
            </div>
          )}
        </div>
      )}

      <div className="model-center-toolbar">
        <input
          className="model-search-input"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="搜索模型名称或 ID…"
        />
        <div className="model-category-tabs">
          {(isVision ? VISION_CATEGORY_TABS : AGENT_CATEGORY_TABS).map(tab => (
            <button
              key={tab.key}
              className={`model-category-tab ${category === tab.key ? 'active' : ''}`}
              onClick={() => setCategory(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="agent-model-list">
        {filtered.map(model => {
          const status = modelStatus(model, true);
          const isNew = isNewlyDiscovered(model);
          const isRecommended = model.model_id === recommended;
          const capsUnknown = model.capabilities.length === 1 && model.capabilities[0] === 'unknown';
          const isOfficialCatalog = model.model_source === 'official_registry' || model.model_source === 'built_in';
          const isCustomSource = model.model_source === 'custom';
          const hidden = !model.enabled;
          return (
            <div className="agent-model-row" key={model.id}>
              <div className="agent-model-info">
                <div className="agent-model-title-row">
                  <strong>{model.display_name || model.model_id}</strong>
                  {isRecommended && <span className="model-badge model-badge-recommend">推荐</span>}
                  {isNew && <span className="model-badge model-badge-new">✨ 新发现</span>}
                  {isOfficialCatalog && <span className="model-badge model-badge-muted">官方目录</span>}
                  {isCustomSource && <span className="model-badge model-badge-muted">手动添加</span>}
                  {model.lifecycle === 'deprecated' && <span className="model-badge model-badge-warn">即将弃用</span>}
                  {model.lifecycle === 'retired' && <span className="model-badge model-badge-muted">已下线</span>}
                  {model.lifecycle === 'missing' && <span className="model-badge model-badge-warn">已停止发现</span>}
                  {hidden && <span className="model-badge model-badge-muted">已隐藏</span>}
                  <span className={`agent-dot ${status.cls}`}>●</span>
                  <span className="form-hint">{status.text}</span>
                  {model.test_status === 'failed' && model.last_error_code && model.last_error_code !== 'quick_check_unsupported' && (
                    <span className="form-hint form-hint-error">
                      {MODEL_ERROR_LABELS[normalizeLegacyErrorCode(model.last_error_code) || 'unknown']}
                    </span>
                  )}
                  {model.test_status === 'failed' && model.last_error_code === 'quick_check_unsupported' && (
                    <span className="form-hint">快速检测不支持，可尝试深度测试</span>
                  )}
                </div>
                <div className="agent-model-meta-row">
                  {!capsUnknown && model.capabilities
                    .filter(c => c !== 'unknown')
                    .map(c => <span className="model-cap-tag" key={c}>{CAPABILITY_LABELS[c]}</span>)}
                  {capsUnknown && <span className="model-cap-tag">能力待识别</span>}
                  {model.test_status === 'available' && model.last_latency_ms !== undefined && (
                    <span className="form-hint">{model.last_latency_ms} ms</span>
                  )}
                  {model.last_tested_at && model.test_status !== 'untested' && (
                    <span className="form-hint">上次检测：{formatRelativeTime(model.last_tested_at)}</span>
                  )}
                </div>
              </div>
              <div className="agent-model-actions">
                <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => setConfigModel(model)}>
                  配置
                </button>
                <button
                  className="settings-btn settings-btn-outline settings-btn-sm"
                  disabled={testingRow === model.id || !!batch || model.lifecycle === 'retired'}
                  onClick={() => void quickTestOne(model)}
                >
                  {testingRow === model.id ? '检测中…' : '检测'}
                </button>
                <button
                  className="settings-btn settings-btn-outline settings-btn-sm"
                  disabled={testingRow === model.id}
                  onClick={() => void deepTestOne(model)}
                  title="发送一次最小生成请求（可能产生少量费用）"
                >
                  深度测试
                </button>
                {(model.test_status === 'failed' || model.last_error_code === 'not_in_catalog' || model.lifecycle === 'missing' || model.lifecycle === 'retired') && (
                  <button className="settings-btn settings-btn-link settings-btn-sm" onClick={() => setDetailModel(model)}>
                    详情
                  </button>
                )}
                {isCustomSource && (
                  <button className="settings-btn settings-btn-danger settings-btn-sm" onClick={() => removeCustomModelRow(model)}>删除</button>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="form-hint">
            {isVision && category === 'vision'
              ? '当前目录暂无支持视觉理解的模型。请点击「刷新模型」同步目录，或切换到「全部模型」查看。'
              : '没有符合筛选条件的模型。'}
          </p>
        )}
      </div>

      {isCustom && (
        showAddModel ? (
          <div className="agent-add-model-form">
            <div className="form-row">
              <div className="form-group">
                <label>模型 ID</label>
                <input value={newModelId} onChange={e => setNewModelId(e.target.value)} placeholder="例如 my-glm-proxy-model" />
              </div>
              <div className="form-group">
                <label>显示名称</label>
                <input value={newModelName} onChange={e => setNewModelName(e.target.value)} placeholder="可选" />
              </div>
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={newModelVision} onChange={e => setNewModelVision(e.target.checked)} />
              支持图片理解（Vision）
            </label>
            <div className="settings-actions-row">
              <button
                className="settings-btn settings-btn-primary settings-btn-sm"
                onClick={() => {
                  const idTrim = newModelId.trim();
                  if (!idTrim) { setAddError('模型 ID 不能为空'); return; }
                  if (/\s/.test(idTrim)) { setAddError('模型 ID 不能包含空格'); return; }
                  if (profile.models.some(m => m.model_id === idTrim)) { setAddError(`模型 ${idTrim} 已存在`); return; }
                  const model: AIProviderModel = {
                    id: `model_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                    model_id: idTrim,
                    display_name: newModelName.trim() || idTrim,
                    model_source: 'custom',
                    enabled: true,
                    supports_vision: newModelVision,
                    capabilities: newModelVision ? ['text', 'vision'] : ['unknown'],
                    lifecycle: 'unknown',
                    test_status: 'untested',
                  };
                  commitModels(models => [...models, model]);
                  setNewModelId('');
                  setNewModelName('');
                  setNewModelVision(false);
                  setShowAddModel(false);
                  setAddError('');
                }}
              >
                添加模型
              </button>
              <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => setShowAddModel(false)}>取消</button>
            </div>
            {addError && <p className="form-hint form-hint-error">{addError}</p>}
          </div>
        ) : (
          <button className="settings-btn settings-btn-outline" onClick={() => setShowAddModel(true)}>+ 手动添加模型</button>
        )
      )}

      {configModel && (
        <ModelConfigDialog
          profile={profile}
          serviceCategory={isVision ? 'vision' : 'agent'}
          model={profile.models.find(m => m.id === configModel.id) || configModel}
          onClose={() => setConfigModel(null)}
          onApply={(patchModel, patchProfile) => {
            commitModels(models => models.map(m => (m.id === configModel.id ? { ...m, ...patchModel } : m)), patchProfile);
            setConfigModel(null);
          }}
        />
      )}

      {detailModel && (
        <ModelErrorDialog
          profile={profile}
          model={profile.models.find(m => m.id === detailModel.id) || detailModel}
          onClose={() => setDetailModel(null)}
        />
      )}
    </section>
  );
}

// ============================================================
// 模型级配置（显示 + 使用范围 + 设为默认）
// ============================================================

function ModelConfigDialog(props: {
  profile: AIProviderProfile;
  serviceCategory: ProviderCategory;
  model: AIProviderModel;
  onClose: () => void;
  onApply: (patchModel: Partial<AIProviderModel>, patchProfile?: Partial<AIProviderProfile>) => void;
}) {
  const { profile, model } = props;
  const isVision = props.serviceCategory === 'vision';
  const [visible, setVisible] = useState(model.enabled);
  const [scopes, setScopes] = useState<UseScopes>(model.use_scopes ?? defaultUseScopes());
  const scopesDirty = JSON.stringify(scopes) !== JSON.stringify(model.use_scopes ?? defaultUseScopes());

  // vision 档案：唯一默认位是「默认视觉理解模型」（default_model_id）；
  // agent 用途默认（对话 / 规划 / Prompt 优化）不适用于视觉档案，禁止写入。
  const defaults: { key: string; label: string; active: boolean; apply: () => Partial<AIProviderProfile> }[] = isVision
    ? [{
        key: 'vision',
        label: '默认视觉理解模型',
        active: profile.default_model_id === model.model_id,
        apply: () => ({ default_model_id: model.model_id }),
      }]
    : [
        {
          key: 'chat',
          label: '默认对话模型',
          active: profile.default_model_id === model.model_id,
          apply: () => ({ default_model_id: model.model_id }),
        },
        {
          key: 'planner',
          label: '默认任务规划模型',
          active: (profile.planner_model_id || profile.default_model_id) === model.model_id,
          apply: () => ({ planner_model_id: model.model_id }),
        },
        {
          key: 'prompt_optimizer',
          label: '默认 Prompt 优化模型',
          active: (profile.prompt_optimizer_model_id || profile.default_model_id) === model.model_id,
          apply: () => ({ prompt_optimizer_model_id: model.model_id }),
        },
      ];

  const capsUnknown = model.capabilities.length === 1 && model.capabilities[0] === 'unknown';

  return (
    <div className="template-modal-overlay" onClick={props.onClose}>
      <div className="template-modal model-config-dialog" onClick={e => e.stopPropagation()}>
        <div className="template-modal-header">
          <h3>{model.display_name || model.model_id}</h3>
          <button className="template-modal-close" onClick={props.onClose} aria-label="关闭">×</button>
        </div>
        <div className="template-modal-body">
          <p className="form-hint">model_id: {model.model_id}</p>

          <div className="use-scope-row">
            <span>在模型选择器中显示</span>
            <Switch checked={visible} onChange={setVisible} label="在模型选择器中显示" />
          </div>

          {!isVision && (
            <>
              <h4 className="settings-subsection-title">允许用于</h4>
              {ALL_USE_SCOPES.map(use => (
                <div className="use-scope-row" key={use}>
                  <span>{USE_SCOPE_LABELS[use]}</span>
                  <Switch
                    checked={scopes[use]}
                    onChange={next => setScopes(current => ({ ...current, [use]: next }))}
                    label={USE_SCOPE_LABELS[use]}
                  />
                </div>
              ))}
            </>
          )}
          <div className="use-scope-row disabled">
            <span>{isVision ? '图片理解能力' : '视觉理解'}</span>
            <span className="form-hint">{model.supports_vision ? '根据能力支持' : capsUnknown ? '能力待识别' : '不支持'}</span>
          </div>

          <h4 className="settings-subsection-title">设为默认</h4>
          {defaults.map(item => (
            <div className="use-scope-row" key={item.key}>
              <span>{item.label}</span>
              {item.active ? (
                <span className="form-hint form-hint-success">✓ 当前默认</span>
              ) : (
                <button
                  className="settings-btn settings-btn-outline settings-btn-sm"
                  onClick={() => props.onApply({}, item.apply())}
                >
                  设为默认
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="template-modal-footer">
          <button className="settings-btn settings-btn-secondary" onClick={props.onClose}>取消</button>
          <button
            className="settings-btn settings-btn-primary"
            disabled={visible === model.enabled && (isVision || !scopesDirty)}
            onClick={() => props.onApply(isVision ? { enabled: visible } : { enabled: visible, use_scopes: scopes })}
          >
            应用
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 使用范围（Provider 级）
// ============================================================

function UseScopeSection(props: {
  profile: AIProviderProfile;
  isEdit: boolean;
  profileId: string;
  onDraftChange: (partial: Partial<AIProviderProfile>) => void;
}) {
  const { profile } = props;
  const store = useAIProviderStore;
  const scopes = profile.use_scopes ?? defaultUseScopes();
  const hasVisionModel = profile.models.some(m => m.enabled && m.supports_vision);

  function update(next: UseScopes) {
    if (props.isEdit) {
      store.getState().setProfileUseScopes(props.profileId, next);
    }
    props.onDraftChange({ use_scopes: next });
  }

  return (
    <section className="settings-card">
      <h4 className="settings-subsection-title">使用范围</h4>
      <p className="form-hint">控制该模型服务可以在哪些功能中显示和使用。具体模型可在模型列表中单独配置。</p>
      {ALL_USE_SCOPES.map(use => (
        <div className="use-scope-row" key={use}>
          <span>{USE_SCOPE_LABELS[use]}</span>
          <Switch
            checked={scopes[use]}
            onChange={next => update({ ...scopes, [use]: next })}
            label={USE_SCOPE_LABELS[use]}
          />
        </div>
      ))}
      <div className="use-scope-row disabled">
        <span>视觉理解</span>
        <span className="form-hint">{hasVisionModel ? '根据模型能力支持' : '当前目录暂无支持视觉的模型'}</span>
      </div>
    </section>
  );
}

// ============================================================
// 默认模型（按用途：对话 / 任务规划 / Prompt 优化）
// ============================================================

function DefaultModelSection(props: {
  category: ProviderCategory;
  profile: AIProviderProfile;
  isEdit: boolean;
  profileId: string;
  onDraftChange: (partial: Partial<AIProviderProfile>) => void;
}) {
  const { profile, isEdit } = props;
  const isVision = props.category === 'vision';
  const store = useAIProviderStore;

  function allowedModels(use: ModelUseScope) {
    return profile.models.filter(m => {
      if (!m.enabled || m.lifecycle === 'retired') return false;
      const modelScopes = m.use_scopes ?? defaultUseScopes();
      return modelScopes[use];
    });
  }

  function visionAllowedModels() {
    return profile.models.filter(m => m.enabled && m.lifecycle !== 'retired' && allowsVisionUse(m));
  }

  function setDefault(patchValue: Partial<AIProviderProfile>) {
    if (isEdit) {
      store.getState().updateProfile(props.profileId, patchValue);
    }
    props.onDraftChange(patchValue);
  }

  if (isVision) {
    const models = visionAllowedModels();
    return (
      <section className="settings-card">
        <h4 className="settings-subsection-title">默认视觉模型</h4>
        <div className="form-row form-row-wrap">
          <div className="form-group">
            <label>视觉理解默认模型</label>
            {models.length > 0 ? (
              <select value={profile.default_model_id} onChange={e => setDefault({ default_model_id: e.target.value })}>
                {!models.some(m => m.model_id === profile.default_model_id) && (
                  <option value="">请选择视觉模型</option>
                )}
                {models.map(model => (
                  <option key={model.id} value={model.model_id}>
                    {model.display_name || model.model_id}
                    {model.lifecycle === 'missing' ? '（已停止发现）' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <p className="form-hint">暂无带「视觉理解」能力的启用模型，请先同步模型目录或调整模型能力。</p>
            )}
          </div>
        </div>
        <p className="form-hint">能力守卫：capabilities 明确声明但不含「视觉理解」的模型不会出现在此处；能力未知（未声明）的模型允许选择。</p>
      </section>
    );
  }

  const selects: { use: ModelUseScope; label: string; value: string; fallbackValue: string; onChange: (modelId: string) => void }[] = [
    {
      use: 'chat',
      label: '对话模型',
      value: profile.default_model_id,
      fallbackValue: '',
      onChange: modelId => setDefault({ default_model_id: modelId }),
    },
    {
      use: 'planner',
      label: '任务规划模型',
      value: profile.planner_model_id || profile.default_model_id,
      fallbackValue: profile.default_model_id,
      onChange: modelId => setDefault({ planner_model_id: modelId }),
    },
    {
      use: 'prompt_optimizer',
      label: 'Prompt 优化模型',
      value: profile.prompt_optimizer_model_id || profile.default_model_id,
      fallbackValue: profile.default_model_id,
      onChange: modelId => setDefault({ prompt_optimizer_model_id: modelId }),
    },
  ];

  return (
    <section className="settings-card">
      <h4 className="settings-subsection-title">默认模型</h4>
      <div className="form-row form-row-wrap">
        {selects.map(item => {
          const models = allowedModels(item.use);
          return (
            <div className="form-group" key={item.use}>
              <label>{item.label}</label>
              {models.length > 0 ? (
                <select value={item.value} onChange={e => item.onChange(e.target.value)}>
                  {models.map(model => (
                    <option key={model.id} value={model.model_id}>
                      {model.display_name || model.model_id}
                      {model.lifecycle === 'missing' ? '（已停止发现）' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="form-hint">暂无允许用于{USE_SCOPE_LABELS[item.use]}的模型。</p>
              )}
            </div>
          );
        })}
      </div>
      <p className="form-hint">任务规划 / Prompt 优化未单独选择时沿用对话模型；修改立即生效。</p>
    </section>
  );
}

function ModelErrorDialog(props: { profile: AIProviderProfile; model: AIProviderModel; onClose: () => void }) {
  const { profile, model } = props;
  const code = normalizeLegacyErrorCode(model.last_error_code) || 'unknown';
  const detail = [
    `Provider：${providerTypeLabel(profile.provider_type)}`,
    `模型：${model.model_id}`,
    `状态：${modelStatus(model, true).text}`,
    model.lifecycle !== 'unknown' && model.lifecycle !== 'active' ? `生命周期：${LIFECYCLE_LABELS[model.lifecycle]}` : '',
    model.last_error_code ? `错误：${MODEL_ERROR_LABELS[code]}` : '',
    model.last_error_message ? `Provider 消息：${model.last_error_message}` : '',
    model.last_error_status ? `HTTP Status：${model.last_error_status}` : '',
    model.last_tested_at ? `检测时间：${new Date(model.last_tested_at).toLocaleString('zh-CN')}` : '',
  ].filter(Boolean).join('\n');

  return (
    <div className="template-modal-overlay" onClick={props.onClose}>
      <div className="template-modal model-error-dialog" onClick={e => e.stopPropagation()}>
        <div className="template-modal-header">
          <h3>{model.test_status === 'failed' ? '模型检测失败' : '模型详情'}</h3>
          <button className="template-modal-close" onClick={props.onClose} aria-label="关闭">×</button>
        </div>
        <div className="template-modal-body">
          <pre className="model-error-detail">{detail}</pre>
          {model.last_error_code && <p className="form-hint">{MODEL_ERROR_HINTS[code]}</p>}
        </div>
        <div className="template-modal-footer">
          <button
            className="settings-btn settings-btn-secondary"
            onClick={() => void navigator.clipboard?.writeText(detail)}
          >
            复制诊断信息
          </button>
          <button className="settings-btn settings-btn-primary" onClick={props.onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 供外部（诊断页）获取 Profile 的发送配置。 */
export { profileToSendSettings };
