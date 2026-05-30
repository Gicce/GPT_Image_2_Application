import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { serverApi, type ServerModel } from '../services/serverApi';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import type {
  AgentEndpointCheckResult,
  AgentStyleTemplate,
  AgentTaskTemplate,
  AgentTemplateDraftPayload,
  AgentTemplateExportPayload,
  AgentTemplateImportPayload,
  AgentTemplateLog,
  Settings as SettingsType,
} from '../types';
import {
  FORMATS,
  QUALITIES,
  QUALITY_LABELS,
  SIZES,
  STYLE_TEMPLATE_GROUPS,
  TASK_TEMPLATE_CATEGORIES,
  TASK_TEMPLATE_INTENTS,
  TASK_TEMPLATE_MATCH_MODES,
  TASK_TEMPLATE_SCENES,
} from '../types';
import { resolveAgentConfig } from '../utils/agentConfig';
import './Settings.css';

type TemplateTab = 'task' | 'style' | 'io' | 'logs';
type SettingsSection = 'defaults' | 'agent' | 'postprocess' | 'appearance';

const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const;

const SETTINGS_SECTION_FIELDS: Record<SettingsSection, (keyof SettingsType)[]> = {
  defaults: ['default_size', 'default_quality', 'default_format'],
  agent: [
    'ai_avatar_data_url',
    'agent_name',
    'agent_model',
    'chat_model',
    'agent_base_url',
    'chat_base_url',
    'agent_token',
    'agent_context_window',
    'chat_token',
    'vision_model',
    'agent_system_prompt',
    'chat_system_prompt',
  ],
  postprocess: ['removebg_api_key', 'topaz_api_key', 'upscale_provider'],
  appearance: ['theme'],
};

function nowIso() {
  return new Date().toISOString();
}

function splitListInput(value: string) {
  return value
    .split(/[\n,，]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function joinListInput(values: string[] | undefined) {
  return (values || []).join(', ');
}

function createEmptyTaskTemplate(): AgentTaskTemplate {
  const now = nowIso();
  return {
    id: '',
    name: '',
    enabled: true,
    priority: 100,
    category: 'generate',
    scene: 'general',
    intent: 'image_generate',
    match_mode: 'hybrid',
    trigger_keywords: [],
    exclude_keywords: [],
    requires_source_images: false,
    min_source_images: 0,
    max_source_images: null,
    requires_confirmation: true,
    allow_auto_execute: false,
    clarification_rules: {
      enabled: false,
      required_fields: [],
      fallback_question: '',
    },
    system_prompt: '',
    prompt_template: '',
    negative_prompt_template: '',
    recommended_action_template: '',
    output_schema: {
      final_prompt: true,
      final_negative_prompt: true,
      recommended_action: true,
      clarification_question: true,
    },
    notes: '',
    created_at: now,
    updated_at: now,
  };
}

function createEmptyStyleTemplate(): AgentStyleTemplate {
  const now = nowIso();
  return {
    id: '',
    name: '',
    enabled: true,
    priority: 100,
    style_group: 'visual_style',
    trigger_keywords: [],
    exclude_keywords: [],
    style_prompt_fragment: '',
    negative_prompt_fragment: '',
    compatible_intents: ['image_generate', 'image_edit'],
    compatible_scenes: ['general'],
    notes: '',
    created_at: now,
    updated_at: now,
  };
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function downloadJson(filename: string, payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function StatusBar({ text }: { text: string }) {
  if (!text) return null;
  return <div className="settings-status">{text}</div>;
}

function getAgentConfigWarning(settings: SettingsType) {
  const resolved = resolveAgentConfig(settings);
  if (!resolved.model) {
    return '当前未配置聊天模型，普通聊天会直接失败。';
  }
  if (!resolved.baseUrl) {
    return '当前未配置 Agent Base URL，普通聊天会直接失败。';
  }
  if (!resolved.token) {
    return '当前未配置 Agent Token，普通聊天会直接失败。';
  }
  if (resolved.mismatch) {
    return '检测到 agent/chat 配置不一致。聊天页会优先使用 Agent 配置，建议统一模型、Base URL 和 Token。';
  }
  if (!settings.agent_model.trim() && settings.chat_model.trim()) {
    return `当前将回退使用 chat_model：${settings.chat_model.trim()}。建议显式保存到 Agent 模型，避免后续误判。`;
  }
  return '';
}

function hasSectionChanges(base: SettingsType, draft: SettingsType, section: SettingsSection) {
  return SETTINGS_SECTION_FIELDS[section].some(key => base[key] !== draft[key]);
}

function buildSectionPartial(base: SettingsType, draft: SettingsType, section: SettingsSection) {
  return SETTINGS_SECTION_FIELDS[section].reduce<Partial<SettingsType>>((acc, key) => {
    if (base[key] !== draft[key]) {
      (acc as Record<string, string | number | boolean | undefined>)[key] = draft[key] as string | number | boolean | undefined;
    }
    return acc;
  }, {});
}

function resetSectionDraft(base: SettingsType, draft: SettingsType, section: SettingsSection): SettingsType {
  const next = { ...draft };
  for (const key of SETTINGS_SECTION_FIELDS[section]) {
    (next as Record<string, string | number | boolean | undefined>)[key] = base[key] as string | number | boolean | undefined;
  }
  return next;
}

export default function Settings() {
  const { settings, loadSettings, saveSettings, saving, saveError } = useSettingsStore();
  const { rescanImages } = useImageStore();
  const [draftSettings, setDraftSettings] = useState<SettingsType>(settings);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [savingSection, setSavingSection] = useState<SettingsSection | null>(null);

  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateTab, setTemplateTab] = useState<TemplateTab>('task');
  const [taskTemplates, setTaskTemplates] = useState<AgentTaskTemplate[]>([]);
  const [styleTemplates, setStyleTemplates] = useState<AgentStyleTemplate[]>([]);
  const [templateLogs, setTemplateLogs] = useState<AgentTemplateLog[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState<AgentTaskTemplate>(createEmptyTaskTemplate());
  const [styleDraft, setStyleDraft] = useState<AgentStyleTemplate>(createEmptyStyleTemplate());
  const [importText, setImportText] = useState('');
  const [conflictMode, setConflictMode] = useState<'overwrite' | 'skip'>('skip');
  const [exportText, setExportText] = useState('');
  const [exportTitle, setExportTitle] = useState('');
  const [templateStatus, setTemplateStatus] = useState('');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [endpointCheck, setEndpointCheck] = useState<AgentEndpointCheckResult | null>(null);
  const [checkingEndpoints, setCheckingEndpoints] = useState(false);
  const [agentStatus, setAgentStatus] = useState('');
  const [visionModelOptions, setVisionModelOptions] = useState<ServerModel[]>([]);
  const [visionModelHint, setVisionModelHint] = useState('');

  useEffect(() => {
    void loadSettings();
    void refreshTemplateCenter();
  }, [loadSettings]);

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  useEffect(() => {
    serverApi.getModels()
      .then(list => {
        const visionOptions = list.filter(model =>
          (model.model_type === 'agent' || model.model_type === 'chat') && model.supports_vision,
        );
        setVisionModelOptions(visionOptions);
        if (visionOptions.length === 0) {
          setVisionModelHint('当前账户下未发现明确标记 supports_vision 的对话模型，可手动填写图片理解模型。');
          return;
        }
        setVisionModelHint(`已发现 ${visionOptions.length} 个支持视觉的对话模型，带图聊天会优先使用这里的模型做独立图片理解。`);
        setDraftSettings(current => (
          current.vision_model.trim()
            ? current
            : { ...current, vision_model: visionOptions[0].name }
        ));
      })
      .catch(() => {
        setVisionModelOptions([]);
        setVisionModelHint('无法自动拉取支持视觉的模型列表，可手动填写图片理解模型。');
      });
  }, []);

  useEffect(() => {
    if (!templateModalOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTemplateModalOpen(false);
      }
    };
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [templateModalOpen]);

  const selectedTask = useMemo(
    () => taskTemplates.find(item => item.id === selectedTaskId) || null,
    [selectedTaskId, taskTemplates],
  );
  const selectedStyle = useMemo(
    () => styleTemplates.find(item => item.id === selectedStyleId) || null,
    [selectedStyleId, styleTemplates],
  );

  useEffect(() => {
    if (selectedTask) {
      setTaskDraft(JSON.parse(JSON.stringify(selectedTask)) as AgentTaskTemplate);
    }
  }, [selectedTask]);

  useEffect(() => {
    if (selectedStyle) {
      setStyleDraft(JSON.parse(JSON.stringify(selectedStyle)) as AgentStyleTemplate);
    }
  }, [selectedStyle]);

  const defaultsDirty = useMemo(() => hasSectionChanges(settings, draftSettings, 'defaults'), [settings, draftSettings]);
  const agentDirty = useMemo(() => hasSectionChanges(settings, draftSettings, 'agent'), [settings, draftSettings]);
  const postprocessDirty = useMemo(() => hasSectionChanges(settings, draftSettings, 'postprocess'), [settings, draftSettings]);
  const appearanceDirty = useMemo(() => hasSectionChanges(settings, draftSettings, 'appearance'), [settings, draftSettings]);

  const settingsStatusText = saveError
    ? `保存失败：${saveError}`
    : settingsStatus || (savingSection && saving ? '设置保存中...' : '');
  const resolvedAgentConfig = useMemo(() => resolveAgentConfig(draftSettings), [draftSettings]);
  const agentConfigWarning = useMemo(() => getAgentConfigWarning(draftSettings), [draftSettings]);

  async function refreshTemplateCenter() {
    try {
      const [tasks, styles, logs] = await Promise.all([
        api.getAgentTaskTemplates(),
        api.getAgentStyleTemplates(),
        api.getAgentTemplateLogs(100),
      ]);
      setTaskTemplates(tasks);
      setStyleTemplates(styles);
      setTemplateLogs(logs);
      setSelectedTaskId(current => (current && tasks.some(item => item.id === current) ? current : tasks[0]?.id ?? null));
      setSelectedStyleId(current => (current && styles.some(item => item.id === current) ? current : styles[0]?.id ?? null));
    } catch (error) {
      setTemplateStatus(error instanceof Error ? error.message : '模板中心加载失败');
    }
  }

  function updateDraft(partial: Partial<SettingsType>) {
    setDraftSettings(current => ({ ...current, ...partial }));
  }

  async function pickAiAvatar() {
    const path = await api.selectImageFile();
    if (!path) return;
    const dataUrl = await api.readImageData(path);
    updateDraft({ ai_avatar_data_url: dataUrl });
  }

  async function refreshLibrary() {
    await rescanImages();
  }

  function getAgentToken(source = draftSettings) {
    return source.agent_token?.trim() || source.chat_token?.trim() || '';
  }

  async function runEndpointCheck() {
    setCheckingEndpoints(true);
    setAgentStatus('');
    try {
      const resolved = resolveAgentConfig(draftSettings);
      const result = await api.checkAgentEndpoints(
        resolved.baseUrl,
        resolved.model,
        resolved.token,
        draftSettings.token,
        draftSettings.vision_model,
      );
      setEndpointCheck(result);
      setAgentStatus('连接自检已完成');
    } catch (error) {
      setEndpointCheck(null);
      setAgentStatus(error instanceof Error ? error.message : '连接自检失败');
    } finally {
      setCheckingEndpoints(false);
    }
  }

  async function saveSection(section: SettingsSection, successText: string) {
    const partial = buildSectionPartial(settings, draftSettings, section);
    if (Object.keys(partial).length === 0) {
      setSettingsStatus('当前区块没有需要保存的变更。');
      return;
    }

    setSavingSection(section);
    setSettingsStatus(`正在保存${successText.replace('已保存', '')}...`);
    try {
      await saveSettings(partial);
      const warning = section === 'agent' ? getAgentConfigWarning({ ...settings, ...draftSettings, ...partial }) : '';
      setSettingsStatus(warning ? `${successText} ${warning}` : successText);
      if (section === 'defaults') {
        await rescanImages();
      }
    } catch (error) {
      setSettingsStatus(error instanceof Error ? `保存失败：${error.message}` : '保存失败，请稍后重试。');
    } finally {
      setSavingSection(null);
    }
  }

  function resetSection(section: SettingsSection) {
    setDraftSettings(current => resetSectionDraft(settings, current, section));
    setSettingsStatus('已恢复到最近一次保存的设置。');
  }

  async function saveTaskTemplate() {
    setTemplateBusy(true);
    try {
      const saved = await api.saveAgentTaskTemplate({
        ...taskDraft,
        id: taskDraft.id.trim(),
        updated_at: nowIso(),
      });
      setTemplateStatus(`主任务模板已保存：${saved.name || saved.id}`);
      await refreshTemplateCenter();
      setSelectedTaskId(saved.id);
    } catch (error) {
      setTemplateStatus(error instanceof Error ? error.message : '保存主任务模板失败');
    } finally {
      setTemplateBusy(false);
    }
  }

  async function saveStyleTemplate() {
    setTemplateBusy(true);
    try {
      const saved = await api.saveAgentStyleTemplate({
        ...styleDraft,
        id: styleDraft.id.trim(),
        updated_at: nowIso(),
      });
      setTemplateStatus(`风格模板已保存：${saved.name || saved.id}`);
      await refreshTemplateCenter();
      setSelectedStyleId(saved.id);
    } catch (error) {
      setTemplateStatus(error instanceof Error ? error.message : '保存风格模板失败');
    } finally {
      setTemplateBusy(false);
    }
  }

  async function deleteTaskTemplate(id: string) {
    if (!window.confirm('确认删除这个主任务模板？')) return;
    await api.deleteAgentTaskTemplate(id);
    setTemplateStatus('主任务模板已删除');
    setSelectedTaskId(null);
    setTaskDraft(createEmptyTaskTemplate());
    await refreshTemplateCenter();
  }

  async function deleteStyleTemplate(id: string) {
    if (!window.confirm('确认删除这个风格模板？')) return;
    await api.deleteAgentStyleTemplate(id);
    setTemplateStatus('风格模板已删除');
    setSelectedStyleId(null);
    setStyleDraft(createEmptyStyleTemplate());
    await refreshTemplateCenter();
  }

  async function toggleTaskTemplate(id: string, enabled: boolean) {
    await api.toggleAgentTaskTemplate(id, enabled);
    await refreshTemplateCenter();
  }

  async function toggleStyleTemplate(id: string, enabled: boolean) {
    await api.toggleAgentStyleTemplate(id, enabled);
    await refreshTemplateCenter();
  }

  async function exportSystemTemplates(single?: { type: 'task' | 'style'; id: string }) {
    const payload = await api.exportAgentTemplates();
    let result: AgentTemplateExportPayload = payload;
    if (single?.type === 'task') {
      result = {
        ...payload,
        task_templates: payload.task_templates.filter(item => item.id === single.id),
        style_templates: [],
      };
    }
    if (single?.type === 'style') {
      result = {
        ...payload,
        task_templates: [],
        style_templates: payload.style_templates.filter(item => item.id === single.id),
      };
    }
    setExportTitle(single ? '导出系统模板（单个）' : '导出系统模板（全部）');
    setExportText(JSON.stringify(result, null, 2));
    setTemplateTab('io');
  }

  async function exportTemplateDraft(type: 'task' | 'style', id: string) {
    const payload: AgentTemplateDraftPayload = await api.exportAgentTemplateDraft(type, id);
    setExportTitle('导出给其他 Agent');
    setExportText(JSON.stringify(payload, null, 2));
    setTemplateTab('io');
  }

  async function handleImportTemplates() {
    let payload: AgentTemplateImportPayload;
    try {
      payload = JSON.parse(importText);
    } catch {
      setTemplateStatus('模板导入失败：JSON 格式无效');
      return;
    }
    setTemplateBusy(true);
    try {
      const imported = await api.importAgentTemplates(payload, conflictMode);
      setTemplateStatus(`模板导入完成：主任务 ${imported.task_templates.length} 条，风格 ${imported.style_templates.length} 条`);
      setImportText('');
      await refreshTemplateCenter();
    } catch (error) {
      setTemplateStatus(error instanceof Error ? error.message : '模板导入失败');
    } finally {
      setTemplateBusy(false);
    }
  }

  function resetTaskDraft() {
    setSelectedTaskId(null);
    setTaskDraft(createEmptyTaskTemplate());
  }

  function resetStyleDraft() {
    setSelectedStyleId(null);
    setStyleDraft(createEmptyStyleTemplate());
  }

  function renderEndpointStatus(label: string, status: AgentEndpointCheckResult[keyof AgentEndpointCheckResult]) {
    return (
      <div className={`endpoint-check-card ${status.ok ? 'ok' : 'fail'}`} key={label}>
        <div className="endpoint-check-head">
          <strong>{label}</strong>
          <span>{status.ok ? '成功' : status.kind === 'not_configured' ? '未配置' : '失败'}</span>
        </div>
        <div className="endpoint-check-message">{status.message}</div>
        {(status.kind || status.status) && (
          <div className="endpoint-check-meta">
            {status.kind && <span>{status.kind}</span>}
            {typeof status.status === 'number' && <span>HTTP {status.status}</span>}
          </div>
        )}
      </div>
    );
  }

  function renderTaskTemplateTab() {
    return (
      <div className="template-workspace">
        <div className="template-list-panel">
          <div className="template-list-head">
            <div>
              <h4>主任务模板</h4>
              <p>定义任务用途、追问规则和提案结构。</p>
            </div>
            <button className="settings-btn settings-btn-primary settings-btn-sm" onClick={resetTaskDraft}>新建</button>
          </div>
          <div className="template-list">
            {taskTemplates.map(template => (
              <div
                key={template.id}
                className={`template-list-item ${selectedTaskId === template.id ? 'active' : ''}`}
                onClick={() => setSelectedTaskId(template.id)}
              >
                <div className="template-item-head">
                  <div>
                    <strong>{template.name || template.id}</strong>
                    <p>{template.intent} · {template.scene} · 优先级 {template.priority}</p>
                  </div>
                  <label className="switch-row" onClick={event => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={template.enabled}
                      onChange={event => void toggleTaskTemplate(template.id, event.target.checked)}
                    />
                    启用
                  </label>
                </div>
                <div className="template-list-actions">
                  <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={event => { event.stopPropagation(); void exportSystemTemplates({ type: 'task', id: template.id }); }}>
                    导出系统模板
                  </button>
                  <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={event => { event.stopPropagation(); void exportTemplateDraft('task', template.id); }}>
                    导出给其他 Agent
                  </button>
                  <button className="settings-btn settings-btn-danger settings-btn-sm" onClick={event => { event.stopPropagation(); void deleteTaskTemplate(template.id); }}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="template-editor-panel">
          <div className="template-editor-head">
            <div>
              <h4>{selectedTaskId ? '编辑主任务模板' : '新建主任务模板'}</h4>
              <p>支持关键词、追问规则、模板 prompt 和输出控制。</p>
            </div>
          </div>

          <div className="template-editor-body">
            <div className="form-row">
              <div className="form-group">
                <label>模板 ID</label>
                <input value={taskDraft.id} onChange={event => setTaskDraft(draft => ({ ...draft, id: event.target.value }))} placeholder="amazon_a_plus_scene" />
              </div>
              <div className="form-group">
                <label>模板名称</label>
                <input value={taskDraft.name} onChange={event => setTaskDraft(draft => ({ ...draft, name: event.target.value }))} placeholder="亚马逊 A+ 场景图" />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>分类</label>
                <select value={taskDraft.category} onChange={event => setTaskDraft(draft => ({ ...draft, category: event.target.value as AgentTaskTemplate['category'] }))}>
                  {TASK_TEMPLATE_CATEGORIES.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>场景</label>
                <select value={taskDraft.scene} onChange={event => setTaskDraft(draft => ({ ...draft, scene: event.target.value as AgentTaskTemplate['scene'] }))}>
                  {TASK_TEMPLATE_SCENES.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Intent</label>
                <select value={taskDraft.intent} onChange={event => setTaskDraft(draft => ({ ...draft, intent: event.target.value as AgentTaskTemplate['intent'] }))}>
                  {TASK_TEMPLATE_INTENTS.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>匹配模式</label>
                <select value={taskDraft.match_mode} onChange={event => setTaskDraft(draft => ({ ...draft, match_mode: event.target.value as AgentTaskTemplate['match_mode'] }))}>
                  {TASK_TEMPLATE_MATCH_MODES.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
            </div>

            <div className="template-subsection">
              <h5>执行约束</h5>
              <div className="form-row">
                <div className="form-group">
                  <label>优先级</label>
                  <input type="number" value={taskDraft.priority} onChange={event => setTaskDraft(draft => ({ ...draft, priority: parseInt(event.target.value || '100', 10) || 100 }))} />
                </div>
                <div className="form-group">
                  <label>源图数量上限</label>
                  <input type="number" value={taskDraft.max_source_images ?? ''} onChange={event => setTaskDraft(draft => ({ ...draft, max_source_images: event.target.value ? parseInt(event.target.value, 10) : null }))} placeholder="留空表示不限" />
                </div>
              </div>
              <div className="checkbox-grid">
                <label className="checkbox-row"><input type="checkbox" checked={taskDraft.enabled} onChange={event => setTaskDraft(draft => ({ ...draft, enabled: event.target.checked }))} />启用</label>
                <label className="checkbox-row"><input type="checkbox" checked={taskDraft.requires_source_images} onChange={event => setTaskDraft(draft => ({ ...draft, requires_source_images: event.target.checked }))} />需要源图</label>
                <label className="checkbox-row"><input type="checkbox" checked={taskDraft.requires_confirmation} onChange={event => setTaskDraft(draft => ({ ...draft, requires_confirmation: event.target.checked }))} />需要确认</label>
                <label className="checkbox-row"><input type="checkbox" checked={taskDraft.allow_auto_execute} onChange={event => setTaskDraft(draft => ({ ...draft, allow_auto_execute: event.target.checked }))} />允许自动执行</label>
              </div>
              <div className="form-group">
                <label>最少源图数</label>
                <input type="number" value={taskDraft.min_source_images} onChange={event => setTaskDraft(draft => ({ ...draft, min_source_images: parseInt(event.target.value || '0', 10) || 0 }))} />
              </div>
            </div>

            <div className="template-subsection">
              <h5>关键词规则</h5>
              <div className="form-row">
                <div className="form-group">
                  <label>触发关键词</label>
                  <textarea rows={3} value={joinListInput(taskDraft.trigger_keywords)} onChange={event => setTaskDraft(draft => ({ ...draft, trigger_keywords: splitListInput(event.target.value) }))} placeholder="支持逗号或换行分隔" />
                </div>
                <div className="form-group">
                  <label>排除关键词</label>
                  <textarea rows={3} value={joinListInput(taskDraft.exclude_keywords)} onChange={event => setTaskDraft(draft => ({ ...draft, exclude_keywords: splitListInput(event.target.value) }))} placeholder="支持逗号或换行分隔" />
                </div>
              </div>
            </div>

            <div className="template-subsection">
              <h5>追问规则</h5>
              <label className="checkbox-row">
                <input type="checkbox" checked={taskDraft.clarification_rules.enabled} onChange={event => setTaskDraft(draft => ({ ...draft, clarification_rules: { ...draft.clarification_rules, enabled: event.target.checked } }))} />
                启用追问
              </label>
              <div className="form-row">
                <div className="form-group">
                  <label>必填字段</label>
                  <textarea rows={2} value={joinListInput(taskDraft.clarification_rules.required_fields)} onChange={event => setTaskDraft(draft => ({ ...draft, clarification_rules: { ...draft.clarification_rules, required_fields: splitListInput(event.target.value) } }))} placeholder="product, scene, selling_point" />
                </div>
                <div className="form-group">
                  <label>缺失时追问文案</label>
                  <textarea rows={2} value={taskDraft.clarification_rules.fallback_question} onChange={event => setTaskDraft(draft => ({ ...draft, clarification_rules: { ...draft.clarification_rules, fallback_question: event.target.value } }))} />
                </div>
              </div>
            </div>

            <div className="form-group">
              <label>System Prompt</label>
              <textarea rows={4} value={taskDraft.system_prompt} onChange={event => setTaskDraft(draft => ({ ...draft, system_prompt: event.target.value }))} />
            </div>
            <div className="form-group">
              <label>Prompt Template</label>
              <textarea rows={5} value={taskDraft.prompt_template} onChange={event => setTaskDraft(draft => ({ ...draft, prompt_template: event.target.value }))} />
            </div>
            <div className="form-group">
              <label>Negative Prompt Template</label>
              <textarea rows={4} value={taskDraft.negative_prompt_template} onChange={event => setTaskDraft(draft => ({ ...draft, negative_prompt_template: event.target.value }))} />
            </div>
            <div className="form-group">
              <label>Recommended Action Template</label>
              <textarea rows={3} value={taskDraft.recommended_action_template} onChange={event => setTaskDraft(draft => ({ ...draft, recommended_action_template: event.target.value }))} />
            </div>

            <div className="template-subsection">
              <h5>输出控制</h5>
              <div className="checkbox-grid">
                <label className="checkbox-row"><input type="checkbox" checked={taskDraft.output_schema.final_prompt} onChange={event => setTaskDraft(draft => ({ ...draft, output_schema: { ...draft.output_schema, final_prompt: event.target.checked } }))} />输出最终提示词</label>
                <label className="checkbox-row"><input type="checkbox" checked={taskDraft.output_schema.final_negative_prompt} onChange={event => setTaskDraft(draft => ({ ...draft, output_schema: { ...draft.output_schema, final_negative_prompt: event.target.checked } }))} />输出负面提示词</label>
                <label className="checkbox-row"><input type="checkbox" checked={taskDraft.output_schema.recommended_action} onChange={event => setTaskDraft(draft => ({ ...draft, output_schema: { ...draft.output_schema, recommended_action: event.target.checked } }))} />输出推荐动作</label>
                <label className="checkbox-row"><input type="checkbox" checked={taskDraft.output_schema.clarification_question} onChange={event => setTaskDraft(draft => ({ ...draft, output_schema: { ...draft.output_schema, clarification_question: event.target.checked } }))} />输出追问文案</label>
              </div>
            </div>

            <div className="form-group">
              <label>备注</label>
              <textarea rows={2} value={taskDraft.notes} onChange={event => setTaskDraft(draft => ({ ...draft, notes: event.target.value }))} />
            </div>
          </div>

          <div className="template-editor-actions sticky">
            <button className="settings-btn settings-btn-primary" disabled={templateBusy} onClick={() => void saveTaskTemplate()}>保存主任务模板</button>
            <button className="settings-btn settings-btn-secondary" onClick={resetTaskDraft}>重置</button>
          </div>
        </div>
      </div>
    );
  }

  function renderStyleTemplateTab() {
    return (
      <div className="template-workspace">
        <div className="template-list-panel">
          <div className="template-list-head">
            <div>
              <h4>风格模板</h4>
              <p>补充画面风格、光影、镜头和平台导向。</p>
            </div>
            <button className="settings-btn settings-btn-primary settings-btn-sm" onClick={resetStyleDraft}>新建</button>
          </div>
          <div className="template-list">
            {styleTemplates.map(template => (
              <div
                key={template.id}
                className={`template-list-item ${selectedStyleId === template.id ? 'active' : ''}`}
                onClick={() => setSelectedStyleId(template.id)}
              >
                <div className="template-item-head">
                  <div>
                    <strong>{template.name || template.id}</strong>
                    <p>{template.style_group} · 优先级 {template.priority}</p>
                  </div>
                  <label className="switch-row" onClick={event => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={template.enabled}
                      onChange={event => void toggleStyleTemplate(template.id, event.target.checked)}
                    />
                    启用
                  </label>
                </div>
                <div className="template-list-actions">
                  <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={event => { event.stopPropagation(); void exportSystemTemplates({ type: 'style', id: template.id }); }}>
                    导出系统模板
                  </button>
                  <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={event => { event.stopPropagation(); void exportTemplateDraft('style', template.id); }}>
                    导出给其他 Agent
                  </button>
                  <button className="settings-btn settings-btn-danger settings-btn-sm" onClick={event => { event.stopPropagation(); void deleteStyleTemplate(template.id); }}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="template-editor-panel">
          <div className="template-editor-head">
            <div>
              <h4>{selectedStyleId ? '编辑风格模板' : '新建风格模板'}</h4>
              <p>为主任务模板叠加风格片段和负面约束。</p>
            </div>
          </div>

          <div className="template-editor-body">
            <div className="form-row">
              <div className="form-group">
                <label>模板 ID</label>
                <input value={styleDraft.id} onChange={event => setStyleDraft(draft => ({ ...draft, id: event.target.value }))} placeholder="cyberpunk_style" />
              </div>
              <div className="form-group">
                <label>模板名称</label>
                <input value={styleDraft.name} onChange={event => setStyleDraft(draft => ({ ...draft, name: event.target.value }))} placeholder="赛博朋克风格" />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>风格组</label>
                <select value={styleDraft.style_group} onChange={event => setStyleDraft(draft => ({ ...draft, style_group: event.target.value as AgentStyleTemplate['style_group'] }))}>
                  {STYLE_TEMPLATE_GROUPS.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>优先级</label>
                <input type="number" value={styleDraft.priority} onChange={event => setStyleDraft(draft => ({ ...draft, priority: parseInt(event.target.value || '100', 10) || 100 }))} />
              </div>
            </div>

            <div className="checkbox-grid">
              <label className="checkbox-row"><input type="checkbox" checked={styleDraft.enabled} onChange={event => setStyleDraft(draft => ({ ...draft, enabled: event.target.checked }))} />启用</label>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>触发关键词</label>
                <textarea rows={3} value={joinListInput(styleDraft.trigger_keywords)} onChange={event => setStyleDraft(draft => ({ ...draft, trigger_keywords: splitListInput(event.target.value) }))} placeholder="支持逗号或换行分隔" />
              </div>
              <div className="form-group">
                <label>排除关键词</label>
                <textarea rows={3} value={joinListInput(styleDraft.exclude_keywords)} onChange={event => setStyleDraft(draft => ({ ...draft, exclude_keywords: splitListInput(event.target.value) }))} placeholder="支持逗号或换行分隔" />
              </div>
            </div>

            <div className="form-group">
              <label>Style Prompt Fragment</label>
              <textarea rows={4} value={styleDraft.style_prompt_fragment} onChange={event => setStyleDraft(draft => ({ ...draft, style_prompt_fragment: event.target.value }))} />
            </div>
            <div className="form-group">
              <label>Negative Prompt Fragment</label>
              <textarea rows={3} value={styleDraft.negative_prompt_fragment} onChange={event => setStyleDraft(draft => ({ ...draft, negative_prompt_fragment: event.target.value }))} />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>适用 Intent</label>
                <textarea rows={2} value={joinListInput(styleDraft.compatible_intents)} onChange={event => setStyleDraft(draft => ({ ...draft, compatible_intents: splitListInput(event.target.value) as AgentStyleTemplate['compatible_intents'] }))} placeholder="image_generate, image_edit" />
              </div>
              <div className="form-group">
                <label>适用 Scene</label>
                <textarea rows={2} value={joinListInput(styleDraft.compatible_scenes)} onChange={event => setStyleDraft(draft => ({ ...draft, compatible_scenes: splitListInput(event.target.value) }))} placeholder="general, poster" />
              </div>
            </div>

            <div className="form-group">
              <label>备注</label>
              <textarea rows={2} value={styleDraft.notes} onChange={event => setStyleDraft(draft => ({ ...draft, notes: event.target.value }))} />
            </div>
          </div>

          <div className="template-editor-actions sticky">
            <button className="settings-btn settings-btn-primary" disabled={templateBusy} onClick={() => void saveStyleTemplate()}>保存风格模板</button>
            <button className="settings-btn settings-btn-secondary" onClick={resetStyleDraft}>重置</button>
          </div>
        </div>
      </div>
    );
  }

  function renderImportExportTab() {
    const canDownload = Boolean(exportText.trim());
    return (
      <div className="template-io-grid">
        <div className="template-io-panel">
          <h4>导出</h4>
          <p className="template-panel-desc">支持导出全部模板、当前模板，或导出给其他 Agent 的草稿格式。</p>
          <div className="template-editor-actions">
            <button className="settings-btn settings-btn-primary" onClick={() => void exportSystemTemplates()}>导出全部系统模板</button>
            <button
              className="settings-btn settings-btn-secondary"
              disabled={!canDownload}
              onClick={() => downloadJson('agent-templates.json', JSON.parse(exportText || '{}'))}
            >
              下载当前导出内容
            </button>
          </div>
          <div className="template-export-meta">{exportTitle || '先点击导出按钮生成 JSON。'}</div>
          <textarea className="template-json-box" value={exportText} onChange={event => setExportText(event.target.value)} placeholder="导出后的 JSON 会显示在这里。" />
          <div className="template-editor-actions">
            <button className="settings-btn settings-btn-secondary" disabled={!exportText} onClick={() => void copyText(exportText)}>复制 JSON</button>
          </div>
        </div>

        <div className="template-io-panel">
          <h4>导入</h4>
          <p className="template-panel-desc">支持主任务模板和风格模板批量导入，冲突时可覆盖或跳过。</p>
          <div className="form-group">
            <label>冲突处理</label>
            <div className="theme-picker">
              <button className={`theme-picker-btn ${conflictMode === 'skip' ? 'active' : ''}`} onClick={() => setConflictMode('skip')}>跳过重复模板</button>
              <button className={`theme-picker-btn ${conflictMode === 'overwrite' ? 'active' : ''}`} onClick={() => setConflictMode('overwrite')}>覆盖已有模板</button>
            </div>
          </div>
          <textarea className="template-json-box" value={importText} onChange={event => setImportText(event.target.value)} placeholder="粘贴系统模板 JSON。" />
          <div className="template-editor-actions">
            <button className="settings-btn settings-btn-primary" disabled={templateBusy || !importText.trim()} onClick={() => void handleImportTemplates()}>导入模板</button>
            <button className="settings-btn settings-btn-secondary" onClick={() => setImportText('')}>清空</button>
          </div>
        </div>
      </div>
    );
  }

  function renderLogsTab() {
    return (
      <div className="template-log-panel">
        <div className="template-list-head">
          <div>
            <h4>命中日志</h4>
            <p>查看模板命中结果、执行接口和最终提示词。</p>
          </div>
          <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => void refreshTemplateCenter()}>刷新日志</button>
        </div>
        <div className="template-log-list">
          {templateLogs.length === 0 && <div className="template-log-empty">暂无命中日志。</div>}
          {templateLogs.map(log => (
            <div className="template-log-card" key={log.id}>
              <div className="template-log-head">
                <strong>{log.matched_task_template_id || '未记录主任务模板'}</strong>
                <span>{new Date(log.created_at).toLocaleString()}</span>
              </div>
              <div className="template-log-grid">
                <div><span>任务 ID</span><p>{log.task_id || '-'}</p></div>
                <div><span>Intent</span><p>{log.intent || '-'}</p></div>
                <div><span>接口</span><p>{log.api_kind || '-'}</p></div>
                <div><span>置信度</span><p>{log.confidence}</p></div>
              </div>
              <div className="template-log-grid">
                <div><span>风格模板</span><p>{log.matched_style_template_ids.join(', ') || '无'}</p></div>
                <div><span>推荐动作</span><p>{log.recommended_action || '无'}</p></div>
              </div>
              <details className="template-log-details">
                <summary>查看提示词详情</summary>
                <div className="template-log-block">
                  <span>原始需求</span>
                  <p>{log.user_prompt_raw || '-'}</p>
                </div>
                <div className="template-log-block">
                  <span>最终提示词</span>
                  <p>{log.final_prompt || '-'}</p>
                </div>
                <div className="template-log-block">
                  <span>负面提示词</span>
                  <p>{log.final_negative_prompt || '无'}</p>
                </div>
              </details>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="page settings-page settings-page-wide">
      <div className="page-header">
        <h2>设置</h2>
        <p>配置默认生成参数、智能体连接、自检能力、后处理工具和本地模板中心。</p>
      </div>
      <StatusBar text={settingsStatusText} />

      <div className="settings-form settings-form-upgraded">
        <section className="settings-card">
          <h3 className="settings-section-title">默认生成参数</h3>
          <div className="form-row">
            <div className="form-group">
              <label>默认图片尺寸</label>
              <select value={draftSettings.default_size} onChange={event => updateDraft({ default_size: event.target.value })}>
                {SIZES.map(size => <option key={size} value={size}>{size}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>默认质量</label>
              <select value={draftSettings.default_quality} onChange={event => updateDraft({ default_quality: event.target.value })}>
                {QUALITIES.map(quality => (
                  <option key={quality} value={quality}>
                    {QUALITY_LABELS[quality] || quality}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>默认输出格式</label>
              <select value={draftSettings.default_format} onChange={event => updateDraft({ default_format: event.target.value })}>
                {FORMATS.map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}
              </select>
            </div>
            <div className="form-group" />
          </div>
          <div className="settings-actions-row">
            <button className="settings-btn settings-btn-secondary" onClick={() => resetSection('defaults')} disabled={!defaultsDirty || savingSection === 'defaults'}>恢复已保存值</button>
            <button className="settings-btn settings-btn-primary" onClick={() => void saveSection('defaults', '默认生成参数已保存')} disabled={!defaultsDirty || savingSection === 'defaults'}>
              {savingSection === 'defaults' ? '保存中...' : '保存'}
            </button>
          </div>
        </section>

        <section className="settings-card">
          <h3 className="settings-section-title">AI 智能体</h3>
          <div className="form-group">
            <div className="label-row">
              <label>AI 头像</label>
            </div>
            <div className="avatar-setting-row">
              <div className="avatar-preview ai">
                {draftSettings.ai_avatar_data_url ? <img src={draftSettings.ai_avatar_data_url} alt="AI 头像" /> : 'AI'}
              </div>
              <div className="avatar-setting-actions">
                <button className="settings-btn settings-btn-primary" onClick={() => void pickAiAvatar()}>更换头像</button>
                <button className="settings-btn settings-btn-secondary" onClick={() => updateDraft({ ai_avatar_data_url: '' })} disabled={!draftSettings.ai_avatar_data_url}>清除</button>
                <p className="form-hint">头像仅保存在本机，不上传到服务端。</p>
              </div>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <div className="label-row">
                <label>智能体名称</label>
              </div>
              <input type="text" value={draftSettings.agent_name} onChange={event => updateDraft({ agent_name: event.target.value })} placeholder="CyImage Agent" />
            </div>
            <div className="form-group">
              <div className="label-row">
                <label>Agent 模型</label>
              </div>
              <input type="text" value={draftSettings.agent_model} onChange={event => updateDraft({ agent_model: event.target.value, chat_model: event.target.value })} placeholder="gpt-4o" />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <div className="label-row">
                <label>图片理解模型</label>
              </div>
              <input
                list="vision-model-options"
                type="text"
                value={draftSettings.vision_model}
                onChange={event => updateDraft({ vision_model: event.target.value })}
                placeholder="gpt-4o"
              />
              <datalist id="vision-model-options">
                {visionModelOptions.map(model => (
                  <option key={model.id} value={model.name}>{model.display_name || model.name}</option>
                ))}
              </datalist>
              <p className="form-hint">
                {visionModelHint || '带图聊天和图片内容识别会优先走官方 responses 图片理解能力，不依赖当前 Agent 模型是否支持视觉。'}
              </p>
            </div>
            <div className="form-group" />
          </div>

          <div className="form-row">
            <div className="form-group">
              <div className="label-row">
                <label>Agent Base URL</label>
              </div>
              <input type="text" value={draftSettings.agent_base_url} onChange={event => updateDraft({ agent_base_url: event.target.value, chat_base_url: event.target.value })} placeholder="https://www.packyapi.com/v1" />
            </div>
            <div className="form-group">
              <div className="label-row">
                <label>Agent Token</label>
              </div>
              <input type="password" value={draftSettings.agent_token} onChange={event => updateDraft({ agent_token: event.target.value })} placeholder="sk-..." />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <div className="label-row">
                <label>上下文窗口</label>
              </div>
              <input type="number" min={4096} value={draftSettings.agent_context_window} onChange={event => updateDraft({ agent_context_window: Math.max(4096, parseInt(event.target.value || '32768', 10) || 32768) })} />
            </div>
            <div className="form-group">
              <div className="label-row">
                <label>对话 Token 兜底</label>
              </div>
              <input type="password" value={draftSettings.chat_token} onChange={event => updateDraft({ chat_token: event.target.value })} placeholder="当 Agent Token 为空时可作为兜底" />
            </div>
          </div>

          <div className="form-group">
            <div className="label-row">
              <label>智能体系统提示词</label>
            </div>
            <textarea rows={4} value={draftSettings.agent_system_prompt} onChange={event => updateDraft({ agent_system_prompt: event.target.value, chat_system_prompt: event.target.value })} placeholder="该提示词会影响智能体的任务理解、追问方式和提案风格。" />
            <p className="form-hint">该提示词用于智能体理解任务和生成提案，不直接替代图片生成提示词。</p>
          </div>

          <div className="form-group">
            <div className="label-row">
              <label>当前聊天实际生效配置</label>
            </div>
            <p className="form-hint">
              {`来源：${resolvedAgentConfig.source === 'agent' ? 'Agent 配置优先' : 'Chat 兜底配置'} · 模型：${resolvedAgentConfig.model || '未配置'} · Base URL：${resolvedAgentConfig.baseUrl || '未配置'} · Token：${resolvedAgentConfig.token ? '已配置' : '未配置'}`}
            </p>
            {agentConfigWarning && <p className="form-hint">{agentConfigWarning}</p>}
          </div>

          <div className="settings-actions-row">
            <button className="settings-btn settings-btn-primary" disabled={checkingEndpoints} onClick={() => void runEndpointCheck()}>
              {checkingEndpoints ? '检测中...' : '连接自检'}
            </button>
            <p className="form-hint">依次检测基础对话、system prompt、多模态聊天兼容性、JSON 解析，以及文生图和图生图状态。</p>
          </div>

          <div className="settings-actions-row settings-actions-row-end">
            <button className="settings-btn settings-btn-secondary" onClick={() => resetSection('agent')} disabled={!agentDirty || savingSection === 'agent'}>恢复已保存值</button>
            <button className="settings-btn settings-btn-primary" onClick={() => void saveSection('agent', 'AI 智能体设置已保存')} disabled={!agentDirty || savingSection === 'agent'}>
              {savingSection === 'agent' ? '保存中...' : '保存'}
            </button>
          </div>

          {agentStatus && <StatusBar text={agentStatus} />}

          {endpointCheck && (
            <div className="endpoint-check-grid">
              {renderEndpointStatus('Agent 对话接口', endpointCheck.chat)}
              {renderEndpointStatus('带 System Prompt 的聊天请求', endpointCheck.chat_with_system)}
              {renderEndpointStatus('聊天链路兼容性检测', endpointCheck.chat_multimodal)}
              {renderEndpointStatus('官方图片理解能力', endpointCheck.official_vision)}
              {renderEndpointStatus('Agent 理解接口（JSON 解析）', endpointCheck.interpret)}
              {renderEndpointStatus('文生图接口', endpointCheck.generation)}
              {renderEndpointStatus('图生图接口', endpointCheck.edit)}
            </div>
          )}
        </section>

        <section className="settings-card">
          <h3 className="settings-section-title">后处理工具</h3>
          <div className="form-row">
            <div className="form-group">
              <div className="label-row">
                <label>remove.bg API Key</label>
              </div>
              <input type="password" value={draftSettings.removebg_api_key} onChange={event => updateDraft({ removebg_api_key: event.target.value })} placeholder="用于透明背景处理" />
            </div>
            <div className="form-group">
              <div className="label-row">
                <label>Topaz API Key（预留）</label>
              </div>
              <input type="password" value={draftSettings.topaz_api_key} onChange={event => updateDraft({ topaz_api_key: event.target.value, upscale_provider: event.target.value ? 'topaz' : 'disabled' })} placeholder="后续用于高清放大" />
            </div>
          </div>
          <div className="settings-actions-row">
            <button className="settings-btn settings-btn-secondary" onClick={() => resetSection('postprocess')} disabled={!postprocessDirty || savingSection === 'postprocess'}>恢复已保存值</button>
            <button className="settings-btn settings-btn-primary" onClick={() => void saveSection('postprocess', '后处理工具设置已保存')} disabled={!postprocessDirty || savingSection === 'postprocess'}>
              {savingSection === 'postprocess' ? '保存中...' : '保存'}
            </button>
          </div>
        </section>

        <section className="settings-card">
          <h3 className="settings-section-title">外观</h3>
          <div className="form-group">
            <label>主题模式</label>
            <div className="theme-picker">
              {THEME_OPTIONS.map(option => (
                <button
                  key={option.value}
                  className={`theme-picker-btn ${draftSettings.theme === option.value ? 'active' : ''}`}
                  onClick={() => updateDraft({ theme: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-actions-row">
            <button className="settings-btn settings-btn-secondary" onClick={() => resetSection('appearance')} disabled={!appearanceDirty || savingSection === 'appearance'}>恢复已保存值</button>
            <button className="settings-btn settings-btn-primary" onClick={() => void saveSection('appearance', '外观设置已保存')} disabled={!appearanceDirty || savingSection === 'appearance'}>
              {savingSection === 'appearance' ? '保存中...' : '保存'}
            </button>
          </div>
        </section>

        <section className="settings-card template-entry-card">
          <div className="template-entry-copy">
            <h3 className="settings-section-title">智能体模板</h3>
            <p>模板中心用于管理主任务模板、风格模板、导入导出和命中日志。复杂表单统一放进弹窗里处理，避免设置页继续堆叠。</p>
            <div className="template-entry-stats">
              <span>{taskTemplates.length} 个主任务模板</span>
              <span>{styleTemplates.length} 个风格模板</span>
              <span>{templateLogs.length} 条命中日志</span>
            </div>
          </div>
          <div className="template-entry-actions">
            <button className="settings-btn settings-btn-primary" onClick={() => setTemplateModalOpen(true)}>打开模板中心</button>
            <button className="settings-btn settings-btn-secondary" onClick={() => void refreshTemplateCenter()}>刷新数据</button>
          </div>
        </section>
      </div>

      {templateModalOpen && (
        <div className="template-modal-overlay" onClick={() => setTemplateModalOpen(false)}>
          <div className="template-modal" onClick={event => event.stopPropagation()}>
            <div className="template-modal-header">
              <div>
                <h3>智能体模板中心</h3>
                <p>管理主任务模板、风格模板、导入导出和命中日志。</p>
              </div>
              <button className="template-modal-close" onClick={() => setTemplateModalOpen(false)} aria-label="关闭模板中心">×</button>
            </div>

            <StatusBar text={templateStatus} />

            <div className="template-modal-tabs">
              <button className={templateTab === 'task' ? 'active' : ''} onClick={() => setTemplateTab('task')}>主任务模板</button>
              <button className={templateTab === 'style' ? 'active' : ''} onClick={() => setTemplateTab('style')}>风格模板</button>
              <button className={templateTab === 'io' ? 'active' : ''} onClick={() => setTemplateTab('io')}>导入导出</button>
              <button className={templateTab === 'logs' ? 'active' : ''} onClick={() => setTemplateTab('logs')}>命中日志</button>
            </div>

            <div className="template-modal-body">
              {templateTab === 'task' && renderTaskTemplateTab()}
              {templateTab === 'style' && renderStyleTemplateTab()}
              {templateTab === 'io' && renderImportExportTab()}
              {templateTab === 'logs' && renderLogsTab()}
            </div>

            <div className="template-modal-footer">
              <button className="settings-btn settings-btn-secondary" onClick={() => setTemplateModalOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

