/**
 * 「AI 模型使用」设置页（V4.1）—— 回答「这个功能现在到底是谁在跑」。
 *
 * 只读解析走 resolveModelForRole（与运行时同一入口，显示值 === 执行值）；
 * 修改只写 routing store（manual / follow），不触碰任何业务工作区状态（UI-only 铁律）。
 * 模型选择复用 ModelPicker（按 role 能力过滤），计费一律 BillingBadge。
 */

import { useMemo, useState } from 'react';
import { useAIProviderStore } from '../aiProviders/store';
import { ProviderLogo } from '../aiProviders/ProviderLogo';
import ModelPicker from '../../components/ModelPicker';
import BillingBadge from '../../components/BillingBadge';
import { useAiModelRoutingStore } from './modelRoutingPolicy';
import { resolveModelForRole, type ResolvedAiModel } from './resolveModelForRole';
import { describeFallback } from './aiRoutingLog';
import { buildRolePickerGroups } from './roleModelFilter';
import {
  AI_MODEL_ROLES,
  AI_ROLE_GROUP_LABELS,
  AI_ROLE_GROUP_ORDER,
  getAiRoleDefinition,
  type AiModelRole,
  type AiRoleDefinition,
} from './modelRoles';

function formatUsageTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  return new Date(iso).toLocaleTimeString();
}

function sourceLine(resolved: ResolvedAiModel): string {
  switch (resolved.source) {
    case 'manual':
      return '单独指定';
    case 'follow':
      return `跟随「${getAiRoleDefinition(resolved.followedRole!).label}」`;
    case 'fallback':
      return '当前回退';
    default:
      return '系统默认';
  }
}

function RoleRow({
  def,
  resolved,
  error,
  lastUsed,
  expanded,
  onToggleExpand,
  onNavigateSection,
}: {
  def: AiRoleDefinition;
  resolved: ResolvedAiModel | null;
  error: string;
  lastUsed?: { displayName: string; at: string };
  expanded: boolean;
  onToggleExpand: () => void;
  onNavigateSection: (section: 'agents' | 'vision') => void;
}) {
  const profiles = useAIProviderStore(s => s.profiles);
  const routingConfig = useAiModelRoutingStore(s => s.config);
  const setEntry = useAiModelRoutingStore(s => s.setEntry);
  const resetRole = useAiModelRoutingStore(s => s.resetRole);
  const entry = routingConfig[def.role];
  const overridden = !!entry;

  const pickerGroups = useMemo(
    () => (def.configurable === 'routing' ? buildRolePickerGroups(def.role, profiles) : []),
    [def, profiles],
  );

  const manualSelection = entry?.mode === 'manual' && entry.profileId && entry.modelId
    ? { profileId: entry.profileId, modelId: entry.modelId }
    : null;
  const manualResolvedProfile = manualSelection
    ? profiles.find(p => p.id === manualSelection.profileId)
    : null;
  const manualResolvedModel = manualSelection && manualResolvedProfile
    ? manualResolvedProfile.models.find(m => m.model_id === manualSelection.modelId)
    : null;

  const goSection = def.role === 'vision_analysis' ? 'vision' : 'agents';

  return (
    <div className={`ai-role-row ${expanded ? 'expanded' : ''}`}>
      <div className="ai-role-main">
        <div className="ai-role-info">
          <div className="ai-role-name">{def.label}</div>
          <div className="ai-role-desc">{def.description}</div>
        </div>
        <div className="ai-role-model">
          {resolved ? (
            <>
              <span className="ai-role-model-name">
                {resolved.providerType && (
                  <ProviderLogo providerType={resolved.providerType} name={resolved.providerName} size={16} />
                )}
                <span className="ai-role-model-text" title={`${resolved.providerName} / ${resolved.displayName}（${resolved.resolvedModelId}）`}>
                  {resolved.displayName}
                </span>
                <BillingBadge mode={resolved.billingMode} />
              </span>
              <span className={`ai-role-source ${resolved.source === 'fallback' ? 'is-fallback' : ''}`}>
                {sourceLine(resolved)}
              </span>
              {lastUsed && (
                <span className="ai-role-used" title={`最近使用：${lastUsed.displayName}`}>
                  最近使用 {formatUsageTime(lastUsed.at)}
                </span>
              )}
            </>
          ) : (
            <span className="ai-role-source is-error" title={error}>{error}</span>
          )}
        </div>
        {resolved?.source === 'fallback' && (
          <p className="ai-role-fallback-note">{describeFallback(resolved)}</p>
        )}
      </div>

      <div className="ai-role-actions">
        {def.configurable === 'routing' && (
          <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={onToggleExpand}>
            {expanded ? '收起' : '更改'}
          </button>
        )}
        {def.configurable === 'external' && (
          <button
            className="settings-btn settings-btn-secondary settings-btn-sm"
            onClick={() => onNavigateSection(goSection)}
            title="前往对应模型设置页更改"
          >
            更改
          </button>
        )}
        {def.configurable === 'fixed' && <span className="ai-role-fixed-note">服务端模型</span>}
      </div>

      {def.configurable === 'routing' && expanded && (
        <div className="ai-role-config">
          <div className="ai-role-config-radios" role="radiogroup" aria-label={`${def.label}模型来源`}>
            <label className={`ai-role-radio ${entry?.mode !== 'manual' ? 'active' : ''}`}>
              <input
                type="radio"
                name={`ai-role-${def.role}`}
                checked={entry?.mode !== 'manual'}
                onChange={() => resetRole(def.role)}
              />
              <span>跟随「{getAiRoleDefinition(def.defaultFollow!).label}」（推荐）</span>
            </label>
            <label className={`ai-role-radio ${entry?.mode === 'manual' ? 'active' : ''}`}>
              <input
                type="radio"
                name={`ai-role-${def.role}`}
                checked={entry?.mode === 'manual'}
                onChange={() => setEntry(def.role, {
                  mode: 'manual',
                  profileId: manualSelection?.profileId,
                  modelId: manualSelection?.modelId,
                })}
              />
              <span>单独指定模型</span>
            </label>
          </div>

          {entry?.mode === 'manual' ? (
            <div className="ai-role-manual-picker">
              {manualSelection ? (
                <ModelPicker
                  profileGroups={pickerGroups}
                  resolvedSelection={manualResolvedProfile && manualResolvedModel
                    ? {
                        profile: {
                          id: manualResolvedProfile.id,
                          name: manualResolvedProfile.name,
                          provider_type: manualResolvedProfile.provider_type,
                          billing_mode: manualResolvedProfile.billing_mode,
                        },
                        model: manualResolvedModel,
                      }
                    : null}
                  conversationSelection={manualSelection}
                  onProfileSelect={(profileId, modelId) => setEntry(def.role, { mode: 'manual', profileId, modelId })}
                />
              ) : (
                <ModelPicker
                  profileGroups={pickerGroups}
                  resolvedSelection={null}
                  onProfileSelect={(profileId, modelId) => setEntry(def.role, { mode: 'manual', profileId, modelId })}
                />
              )}
              {!manualSelection && (
                <p className="form-hint">尚未选择模型，当前按推荐路由执行；选择后立即生效。</p>
              )}
            </div>
          ) : (
            <p className="form-hint">
              此功能默认使用「{getAiRoleDefinition(def.defaultFollow!).label}」当前选择的模型。
            </p>
          )}

          {overridden && entry?.mode !== 'manual' && (
            <div className="ai-role-config-actions">
              <button className="settings-btn settings-btn-outline settings-btn-sm" onClick={() => resetRole(def.role)}>
                恢复推荐设置
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AiModelUsageSettings({ onNavigateSection }: {
  onNavigateSection: (section: 'agents' | 'vision') => void;
}) {
  const profiles = useAIProviderStore(s => s.profiles);
  const profilesVersion = useAIProviderStore(s => s.profiles.length + '-' + s.profiles.map(p => p.updated_at).join(','));
  const routingConfig = useAiModelRoutingStore(s => s.config);
  const lastUsed = useAiModelRoutingStore(s => s.lastUsed);
  const resetAll = useAiModelRoutingStore(s => s.resetAll);
  const [expandedRole, setExpandedRole] = useState<AiModelRole | null>(null);
  void profilesVersion;

  const resolutions = useMemo(() => {
    const map: Partial<Record<AiModelRole, { resolved: ResolvedAiModel | null; error: string }>> = {};
    for (const def of AI_MODEL_ROLES) {
      const outcome = resolveModelForRole(def.role);
      map[def.role] = outcome.ok
        ? { resolved: outcome.resolved, error: '' }
        : { resolved: null, error: outcome.error };
    }
    return map;
  }, [profiles, routingConfig]);

  const hasOverrides = Object.keys(routingConfig).length > 0;

  return (
    <section className="settings-card ai-usage-card">
      <div className="ai-usage-head">
        <div>
          <h3 className="settings-section-title">AI 模型使用</h3>
          <p className="settings-section-desc">
            了解 CyImagePro 每项 AI 能力实际使用的模型。「跟随」表示该能力默认使用另一项功能当前选择的模型。
          </p>
        </div>
        {hasOverrides && (
          <button className="settings-btn settings-btn-outline settings-btn-sm" onClick={resetAll}>
            恢复推荐设置
          </button>
        )}
      </div>

      {AI_ROLE_GROUP_ORDER.map(group => (
        <div key={group} className="ai-usage-group">
          <h4 className="ai-usage-group-title">{AI_ROLE_GROUP_LABELS[group]}</h4>
          {AI_MODEL_ROLES.filter(def => def.group === group).map(def => {
            const outcome = resolutions[def.role] ?? { resolved: null, error: '' };
            return (
              <RoleRow
                key={def.role}
                def={def}
                resolved={outcome.resolved}
                error={outcome.error}
                lastUsed={lastUsed[def.role]}
                expanded={expandedRole === def.role}
                onToggleExpand={() => setExpandedRole(current => (current === def.role ? null : def.role))}
                onNavigateSection={onNavigateSection}
              />
            );
          })}
        </div>
      ))}
    </section>
  );
}
