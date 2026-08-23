import { useEffect, useMemo, useRef, useState } from 'react';
import { ProviderLogo } from '../features/aiProviders/ProviderLogo';
import { isNewlyDiscovered } from '../features/aiProviders/registry/registry';
import { splitModelsForPicker } from '../features/aiProviders/modelUiPolicy';
import type { AIProviderModel, AIProviderType, BillingMode } from '../features/aiProviders/types';
import { LIFECYCLE_LABELS } from '../features/aiProviders/types';
import BillingBadge from './BillingBadge';
import './ModelPicker.css';

export interface ModelPickerProfile {
  id: string;
  name: string;
  provider_type: AIProviderType;
  billing_mode?: BillingMode;
  default_model_id: string;
}

export interface ModelPickerGroup {
  profile: ModelPickerProfile;
  models: AIProviderModel[];
}

export interface ModelPickerSelection {
  profile: { id: string; name: string; provider_type: AIProviderType; billing_mode?: BillingMode };
  model: AIProviderModel;
}

/**
 * AI 智能体模型选择器（V4.0.9 公共化）。
 *
 * 展示策略全部来自 modelUiPolicy（常用 / 更多分组、隐藏规则、排序）；
 * 计费文案全部来自 BillingBadge；本组件不维护任何模型白名单。
 * 布局约束：模型名单行 ellipsis，Badge 永不收缩换行，面板最大高度内部滚动。
 */
export default function ModelPicker({ profileGroups = [], resolvedSelection, conversationSelection, onProfileSelect, onGoToSettings }: {
  profileGroups?: ModelPickerGroup[];
  /** 会话级解析结果（含全局默认兜底），仅用于按钮文案与选中态展示 */
  resolvedSelection?: ModelPickerSelection | null;
  conversationSelection?: { profileId: string; modelId: string } | null;
  onProfileSelect?: (profileId: string, modelId: string) => void;
  onGoToSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // 唯一来源：用户已启用 Provider 的模型。没有 Provider 时显示配置引导。
  const display = resolvedSelection
    ? `${resolvedSelection.profile.name} · ${resolvedSelection.model.display_name || resolvedSelection.model.model_id}`
    : '尚未配置模型';

  const activeProfileId = conversationSelection?.profileId || resolvedSelection?.profile.id || '';
  const activeModelId = conversationSelection?.modelId || resolvedSelection?.model.model_id || '';

  const normalizedQuery = query.trim().toLowerCase();

  const groups = useMemo(() => profileGroups.map(group => {
    const groupActiveModelId =
      (activeProfileId && group.profile.id === activeProfileId) ? activeModelId : undefined;
    const split = splitModelsForPicker(
      { provider_type: group.profile.provider_type, default_model_id: group.profile.default_model_id, models: group.models },
      groupActiveModelId,
    );
    const matches = (model: AIProviderModel) =>
      !normalizedQuery
      || model.model_id.toLowerCase().includes(normalizedQuery)
      || (model.display_name || '').toLowerCase().includes(normalizedQuery);
    return { group, split, matches };
  }), [profileGroups, activeProfileId, activeModelId, normalizedQuery]);

  const totalMatches = groups.reduce(
    (sum, { group, matches }) =>
      sum + group.models.filter(model => matches(model)).length,
    0,
  );

  const handleSelect = (profileId: string, modelId: string) => {
    onProfileSelect?.(profileId, modelId);
    setOpen(false);
  };

  const renderRow = (profile: ModelPickerProfile, model: AIProviderModel) => {
    const selected = profile.id === activeProfileId && model.model_id === activeModelId;
    return (
      <div
        key={`${profile.id}:${model.model_id}`}
        className={`model-option ${selected ? 'selected' : ''}`}
        onClick={() => handleSelect(profile.id, model.model_id)}
      >
        <span className="model-option-name" title={`${model.display_name || model.model_id}（${model.model_id}）`}>
          {model.display_name || model.model_id}
        </span>
        {model.lifecycle === 'deprecated' && (
          <span className="model-option-tag lifecycle">{LIFECYCLE_LABELS.deprecated}</span>
        )}
        {isNewlyDiscovered(model) && <span className="model-option-tag new">✨新</span>}
        {model.supports_vision && <span className="model-option-tag vision">视觉</span>}
        {model.test_status === 'failed' && <span className="model-option-tag warn">⚠</span>}
        {selected && (
          <svg className="model-option-check" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.5 4.5L6 12 2.5 8.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </div>
    );
  };

  return (
    <div className="model-picker" ref={wrapRef}>
      <button
        type="button"
        className={`model-picker-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        <span className="model-picker-name">
          {resolvedSelection && (
            <ProviderLogo
              providerType={resolvedSelection.profile.provider_type}
              name={resolvedSelection.profile.name}
              size={16}
            />
          )}
          <span className="model-picker-name-text" title={display}>{display}</span>
          <BillingBadge mode={resolvedSelection?.profile.billing_mode} />
        </span>
        <svg className="model-picker-chevron" width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="model-picker-panel">
          {profileGroups.length === 0 ? (
            <div className="model-option empty">
              <div>尚未配置 AI 对话模型</div>
              <div className="model-option-empty-hint">请在「设置与更新 → AI 智能体」中添加</div>
              {onGoToSettings && (
                <button
                  className="model-option-goto"
                  onClick={() => {
                    onGoToSettings();
                    setOpen(false);
                  }}
                >
                  前往设置
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="model-picker-search">
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="搜索模型…"
                  spellCheck={false}
                />
              </div>
              {totalMatches === 0 && (
                <div className="model-picker-no-match">没有匹配的模型</div>
              )}
              {groups.map(({ group, split, matches }) => {
                const primaryRows = normalizedQuery
                  ? split.primary.filter(matches).map(model => renderRow(group.profile, model))
                  : split.primary.map(model => renderRow(group.profile, model));
                const secondaryRows = normalizedQuery
                  ? split.secondary.filter(matches).map(model => renderRow(group.profile, model))
                  : [];
                if (normalizedQuery && primaryRows.length + secondaryRows.length === 0) return null;
                const expanded = expandedGroups.has(group.profile.id) || !!normalizedQuery;
                return (
                  <div key={group.profile.id} className="model-picker-group">
                    <div className="model-option-group-title">
                      <ProviderLogo providerType={group.profile.provider_type} name={group.profile.name} size={14} />
                      <span className="model-option-group-name">{group.profile.name}</span>
                      <BillingBadge mode={group.profile.billing_mode} />
                    </div>
                    {primaryRows}
                    {!normalizedQuery && split.secondary.length > 0 && (
                      <button
                        type="button"
                        className={`model-picker-more ${expanded ? 'expanded' : ''}`}
                        aria-expanded={expanded}
                        onClick={() => setExpandedGroups(prev => {
                          const next = new Set(prev);
                          if (next.has(group.profile.id)) next.delete(group.profile.id);
                          else next.add(group.profile.id);
                          return next;
                        })}
                      >
                        更多模型（{split.secondary.length}）
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                          <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                    )}
                    {expanded && !normalizedQuery && split.secondary.map(model => renderRow(group.profile, model))}
                    {normalizedQuery && secondaryRows}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
