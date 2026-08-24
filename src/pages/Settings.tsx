import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { type ServerModel, testServerConnection } from '../services/serverApi';
import { useServerModelStore } from '../store/useServerModelStore';
import { useRuntimeStore } from '../store/useRuntimeStore';
import { useTaskStore } from '../store/useTaskStore';
import { TERMINAL_TASK_STATUSES } from '../types';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useServerStatusStore } from '../store/useServerStatusStore';
import { useAuthStore } from '../store/useAuthStore';
import { useUpdateStore } from '../store/useUpdateStore';
import { RELEASE_INFO } from '../config/release';
import { useAIProviderStore } from '../features/aiProviders/store';
import AgentProviderSettings from '../features/aiProviders/AgentProviderSettings';
import AiModelUsageSettings from '../features/aiRouting/AiModelUsageSettings';
import type {
  AgentEndpointCheckResult,
  AgentStyleTemplate,
  AgentTaskTemplate,
  AgentTemplateDraftPayload,
  AgentTemplateExportPayload,
  AgentTemplateImportPayload,
  AgentTemplateLog,
  EnvCheckResult,
  GenerateTestImageResult,
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
import './Settings.css';

type TemplateTab = 'task' | 'style' | 'io' | 'logs';
type SettingsSection =
  | 'general'
  | 'server'
  | 'agents'
  | 'vision'
  | 'airouting'
  | 'imagegen'
  | 'files'
  | 'postprocess'
  | 'diagnostics'
  | 'update';

type EditableSection = Exclude<SettingsSection, 'agents' | 'vision' | 'airouting' | 'diagnostics' | 'update'>;

const SETTINGS_NAV: { key: SettingsSection; label: string; desc: string }[] = [
  { key: 'general', label: '常规', desc: '主题外观与智能体模板入口。' },
  { key: 'server', label: '服务连接', desc: 'CyImagePro Server 地址与心跳。' },
  { key: 'agents', label: 'AI 智能体', desc: '管理 AI 模型服务（对话 / 任务规划 / 提示词优化）。' },
  { key: 'vision', label: '视觉模型', desc: '管理图片理解模型服务（视觉理解 / 反向 Prompt / 高复刻评审）。' },
  { key: 'airouting', label: 'AI 模型使用', desc: '查看并调整每项 AI 能力实际使用的模型。' },
  { key: 'imagegen', label: '图片生成', desc: '默认尺寸、质量与输出格式。' },
  { key: 'files', label: '图片与文件', desc: '生成目录与图片库素材目录。' },
  { key: 'postprocess', label: '后处理工具', desc: 'remove.bg 与 Topaz API Key。' },
  { key: 'diagnostics', label: '诊断与工具', desc: '运行环境检查与诊断工具。' },
  { key: 'update', label: '更新与关于', desc: '应用版本与软件更新。' },
];

const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const;

// 每个子页对应的可编辑字段（agents/diagnostics/update 独立管理，不进入统一保存）
const SETTINGS_SECTION_FIELDS: Record<EditableSection, (keyof SettingsType)[]> = {
  general: ['theme'],
  server: ['server_url'],
  imagegen: ['default_size', 'default_quality', 'default_format'],
  files: ['default_output_dir', 'library_input_dir'],
  postprocess: ['removebg_api_key', 'topaz_api_key', 'upscale_provider'],
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

function hasSectionChanges(base: SettingsType, draft: SettingsType, section: EditableSection) {
  return SETTINGS_SECTION_FIELDS[section].some(key => base[key] !== draft[key]);
}

function buildSectionPartial(base: SettingsType, draft: SettingsType, section: EditableSection) {
  return SETTINGS_SECTION_FIELDS[section].reduce<Partial<SettingsType>>((acc, key) => {
    if (base[key] !== draft[key]) {
      (acc as Record<string, string | number | boolean | undefined>)[key] = draft[key] as string | number | boolean | undefined;
    }
    return acc;
  }, {});
}

function resetSectionDraft(base: SettingsType, draft: SettingsType, section: EditableSection): SettingsType {
  const next = { ...draft };
  for (const key of SETTINGS_SECTION_FIELDS[section]) {
    (next as Record<string, string | number | boolean | undefined>)[key] = base[key] as string | number | boolean | undefined;
  }
  return next;
}

export default function Settings() {
  const { settings, loadSettings, saveSettings, saving, saveError } = useSettingsStore();
  const { rescanImages } = useImageStore();
  const { connectionStatus, serverHost, checking, serverService, serverVersion, checkConnection, heartbeatStatus, lastHeartbeatAt, heartbeatError, sendHeartbeat } = useServerStatusStore();
  const { isLoggedIn } = useAuthStore();
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');

  // 外部页面（图片生成工作台 / Chat Empty State）的「前往设置」跳转指定栏目
  useEffect(() => {
    const handler = () => {
      const section = localStorage.getItem('cy_settings_section') as SettingsSection | null;
      if (section && SETTINGS_NAV.some(item => item.key === section)) {
        setActiveSection(section);
        localStorage.removeItem('cy_settings_section');
      }
    };
    window.addEventListener('cy-settings-section', handler);
    return () => window.removeEventListener('cy-settings-section', handler);
  }, []);
  const [draftSettings, setDraftSettings] = useState<SettingsType>(settings);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [savingSection, setSavingSection] = useState<EditableSection | null>(null);
  const [testingServer, setTestingServer] = useState(false);
  const [serverTestResult, setServerTestResult] = useState<{ ok: boolean; message: string; host: string } | null>(null);

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
  const [envCheck, setEnvCheck] = useState<EnvCheckResult | null>(null);
  const [envChecking, setEnvChecking] = useState(false);
  const [envStatus, setEnvStatus] = useState('');
  const [testImage, setTestImage] = useState<GenerateTestImageResult | null>(null);
  const [testImageBusy, setTestImageBusy] = useState(false);
  const [testImageStatus, setTestImageStatus] = useState('');
  const [visionModelOptions, setVisionModelOptions] = useState<ServerModel[]>([]);
  const [visionModelHint, setVisionModelHint] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');

  // 更新与关于
  const { status: updateStatus, checkUpdate } = useUpdateStore();
  const [appVersion, setAppVersion] = useState('');

  const hydrateProfiles = useAIProviderStore(state => state.hydrate);

  useEffect(() => {
    void loadSettings();
    void refreshTemplateCenter();
    hydrateProfiles();
    // 连接检查与心跳调度由 App 级单例负责，页面不再自行启动 timer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  useEffect(() => {
    import('@tauri-apps/api/app').then(({ getVersion }) => getVersion().then(v => setAppVersion(v))).catch(() => setAppVersion(''));
  }, []);

  // 视觉模型列表（图片理解模型已随 Profile 管理，这里仅保留服务器视觉模型供诊断参考）。
  // 数据来自 useServerModelStore 统一同步（runtimeReady 后首发、按 Server 隔离、自动恢复）。
  const serverModels = useServerModelStore(s => s.models);
  const serverModelStatus = useServerModelStore(s => s.status);
  const serverModelError = useServerModelStore(s => s.error);
  const syncServerModels = useServerModelStore(s => s.sync);
  // 诊断面板只读 Runtime 状态的响应式来源
  const runtimePhase = useRuntimeStore(s => s.phase);
  const runtimeServerUrl = useRuntimeStore(s => s.resolvedServerUrl);
  const taskActiveCount = useTaskStore(s => s.tasks.filter(t => !TERMINAL_TASK_STATUSES.has(t.status)).length);
  void runtimePhase; void runtimeServerUrl; void taskActiveCount;
  useEffect(() => {
    if (!isLoggedIn) return;
    void syncServerModels();
  }, [isLoggedIn, settings.server_url, syncServerModels]);
  useEffect(() => {
    setModelsLoading(serverModelStatus === 'loading');
    if (serverModelStatus === 'ready') {
      const visionAccessible = serverModels.filter(model => model.supports_vision === true && model.user_has_access !== false);
      setVisionModelOptions(visionAccessible);
      setVisionModelHint(visionAccessible.length === 0
        ? '当前账户暂无可用视觉模型。'
        : `已发现 ${visionAccessible.length} 个当前账户可用的视觉模型。`);
      setModelsError('');
    } else if (serverModelStatus === 'error') {
      setVisionModelOptions([]);
      setModelsError(serverModelError?.message || '服务器模型获取失败');
      setVisionModelHint('');
    }
  }, [serverModels, serverModelStatus, serverModelError]);

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

  const sectionDirty = useMemo(() => {
    const editable: EditableSection[] = ['general', 'server', 'imagegen', 'files', 'postprocess'];
    return Object.fromEntries(editable.map(section => [
      section,
      hasSectionChanges(settings, draftSettings, section),
    ])) as Record<EditableSection, boolean>;
  }, [settings, draftSettings]);

  const currentSectionDirty = (['general', 'server', 'imagegen', 'files', 'postprocess'] as EditableSection[])
    .includes(activeSection as EditableSection)
    ? sectionDirty[activeSection as EditableSection]
    : false;

  const settingsStatusText = saveError
    ? `保存失败：${saveError}`
    : settingsStatus || (savingSection && saving ? '设置保存中...' : '');

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

  async function refreshLibrary() {
    await rescanImages();
  }

  async function pickDirectory(field: 'default_output_dir' | 'library_input_dir') {
    try {
      const dir = await api.selectDirectory();
      if (!dir) return;
      updateDraft({ [field]: dir } as Partial<SettingsType>);
    } catch (error) {
      setSettingsStatus(error instanceof Error ? `选择目录失败：${error.message}` : '选择目录失败');
    }
  }

  async function openDirectory(path: string) {
    const trimmed = path.trim();
    if (!trimmed) {
      setSettingsStatus('当前未配置目录，请先选择目录。');
      return;
    }
    try {
      await api.openFolder(trimmed);
    } catch (error) {
      setSettingsStatus(error instanceof Error
        ? `打开目录失败：${error.message}。可能目录不存在，请重新选择。`
        : '打开目录失败，可能目录不存在，请重新选择。');
    }
  }

  async function runEnvironmentCheck() {
    setEnvChecking(true);
    setEnvStatus('正在检查运行环境...');
    try {
      const result = await api.checkEnvironment();
      setEnvCheck(result);
      const okCount = result.items.filter(i => i.status === 'ok').length;
      const errCount = result.items.filter(i => i.status === 'error').length;
      const warnCount = result.items.filter(i => i.status === 'warn').length;
      setEnvStatus(`检查完成：${okCount} 正常 / ${warnCount} 提示 / ${errCount} 异常`);
    } catch (error) {
      setEnvStatus(error instanceof Error ? `自检失败：${error.message}` : '自检失败');
    } finally {
      setEnvChecking(false);
    }
  }

  async function runTestImageGeneration() {
    if (!window.confirm('这将实际调用一次 gpt-image-2（low quality），会产生一次真实图片生成费用。是否继续？')) {
      return;
    }
    setTestImageBusy(true);
    setTestImageStatus('正在生成测试图，预计 30~120 秒...');
    setTestImage(null);
    try {
      const result = await api.generateTestImage();
      setTestImage(result);
      if (result.ok) {
        setTestImageStatus(`生成成功，耗时 ${(result.latency_ms / 1000).toFixed(1)} 秒`);
      } else {
        setTestImageStatus(`生成失败：${result.error_kind || ''} ${result.error_message || ''}`);
      }
    } catch (error) {
      setTestImageStatus(error instanceof Error ? `生成失败：${error.message}` : '生成失败');
    } finally {
      setTestImageBusy(false);
    }
  }

  function buildRuntimeDiagnosticText(): string {
    const runtime = useRuntimeStore.getState();
    const server = useServerStatusStore.getState();
    const models = useServerModelStore.getState();
    return [
      `[Runtime] phase=${runtime.phase} settingsLoaded=${runtime.settingsLoaded} authRestored=${runtime.authRestored}`,
      `[Runtime] serverUrl=${runtime.resolvedServerUrl || '(未恢复)'}`,
      `[Server] connection=${server.connectionStatus} host=${server.serverHost || '-'}`,
      `[Server] heartbeat=${server.heartbeatStatus}${server.lastHeartbeatAt ? ` lastAt=${server.lastHeartbeatAt}` : ''}`,
      `[Models] status=${models.status} dataServer=${models.dataServerUrl || '-'} fromCache=${models.fromCache}${models.lastSyncAt ? ` syncedAt=${new Date(models.lastSyncAt).toISOString()}` : ''}`,
      `[Task] activeNonTerminal=${useTaskStore.getState().tasks.filter(t => !TERMINAL_TASK_STATUSES.has(t.status)).length}`,
    ].join('\n');
  }

  function copyDiagnosticInfo() {
    const runtimeText = buildRuntimeDiagnosticText();
    const text = envCheck ? `${runtimeText}\n${envCheck.diagnostic_text || ''}` : runtimeText;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => setEnvStatus('诊断信息已复制到剪贴板'),
        () => setEnvStatus('复制失败，请手动选中下方文本'),
      );
    } else {
      setEnvStatus('当前环境不支持自动复制，请手动选中下方文本');
    }
  }

  async function saveCurrentSection() {
    const section = activeSection as EditableSection;
    const partial = buildSectionPartial(settings, draftSettings, section);
    if (Object.keys(partial).length === 0) {
      setSettingsStatus('当前页面没有需要保存的变更。');
      return;
    }
    const labelMap: Record<EditableSection, string> = {
      general: '常规设置',
      server: '服务器地址',
      imagegen: '图片生成参数',
      files: '图片与文件设置',
      postprocess: '后处理工具设置',
    };
    setSavingSection(section);
    setSettingsStatus(`正在保存${labelMap[section]}...`);
    try {
      await saveSettings(partial);
      setSettingsStatus(`${labelMap[section]}已保存`);
      if (section === 'imagegen' || section === 'files') {
        await rescanImages();
      }
      if (section === 'server' && partial.server_url) {
        await checkConnection();
      }
    } catch (error) {
      setSettingsStatus(error instanceof Error ? `保存失败：${error.message}` : '保存失败，请稍后重试。');
    } finally {
      setSavingSection(null);
    }
  }

  function resetCurrentSection() {
    setDraftSettings(current => resetSectionDraft(settings, current, activeSection as EditableSection));
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

  async function handleCheckUpdate() {
    await checkUpdate(true);
  }

  // ============ 子页渲染 ============

  function renderGeneral() {
    return (
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

        <div className="template-entry-inner">
          <h3 className="settings-section-title">高级 · 智能体模板</h3>
          <p className="settings-section-desc">模板中心用于管理主任务模板、风格模板、导入导出和命中日志。</p>
          <div className="template-entry-stats">
            <span>{taskTemplates.length} 个主任务模板</span>
            <span>{styleTemplates.length} 个风格模板</span>
            <span>{templateLogs.length} 条命中日志</span>
          </div>
          <div className="template-entry-actions">
            <button className="settings-btn settings-btn-primary" onClick={() => setTemplateModalOpen(true)}>打开模板中心</button>
            <button className="settings-btn settings-btn-secondary" onClick={() => void refreshTemplateCenter()}>刷新数据</button>
          </div>
        </div>
      </section>
    );
  }

  function renderServer() {
    const serverDirty = sectionDirty.server;
    return (
      <section className="settings-card server-connection-card">
        <h3 className="settings-section-title">服务连接</h3>
        <p className="settings-section-desc">CyImagePro Server，用于账户、支付、用量统计、设备心跳和在线状态。</p>

        <div className="form-row">
          <div className="form-group form-group-server-url">
            <label>服务器地址</label>
            <input
              type="text"
              value={draftSettings.server_url}
              onChange={event => {
                updateDraft({ server_url: event.target.value });
                setServerTestResult(null);
              }}
              placeholder="http://localhost:4001"
            />
            {serverDirty && <p className="form-hint form-hint-warning">当前地址未保存</p>}
          </div>
        </div>

        <div className="server-status-row-full">
          <span className={`server-status-indicator ${serverTestResult ? (serverTestResult.ok ? 'connected' : 'disconnected') : connectionStatus}`} title={
            serverTestResult
              ? (serverTestResult.ok ? '测试连接成功' : serverTestResult.message)
              : (connectionStatus === 'connected' ? '已连接' : connectionStatus === 'disconnected' ? '未连接' : '连接中')
          }>
            {serverTestResult
              ? (serverTestResult.ok ? '🟢' : '🔴')
              : (connectionStatus === 'connected' && '🟢')}
            {connectionStatus === 'disconnected' && !serverTestResult && '🔴'}
            {connectionStatus === 'connecting' && !serverTestResult && '🟡'}
          </span>
          <span className="server-status-text">
            {serverTestResult
              ? (serverTestResult.ok ? `已连接：${serverTestResult.host}` : serverTestResult.message)
              : (connectionStatus === 'connected' && `已连接服务器：${serverHost}${serverService ? ` (${serverService})` : ''}`)}
            {connectionStatus === 'disconnected' && !serverTestResult && '未连接服务器'}
            {connectionStatus === 'connecting' && !serverTestResult && '正在检测中...'}
          </span>
          <button
            className="settings-btn settings-btn-secondary settings-btn-sm"
            disabled={testingServer || checking || !draftSettings.server_url.trim()}
            onClick={async () => {
              setTestingServer(true);
              setServerTestResult(null);
              const url = draftSettings.server_url.trim();
              const result = await testServerConnection(url);
              setServerTestResult(result);
              setTestingServer(false);
              if (result.ok) {
                useServerStatusStore.setState({
                  connectionStatus: 'connected',
                  serverHost: result.host,
                  serverService: result.service,
                  serverVersion: result.version,
                  lastCheckedAt: new Date().toISOString(),
                });
              }
            }}
          >
            {testingServer ? '检测中...' : '测试连接'}
          </button>
        </div>

        {isLoggedIn && (
          <div className="heartbeat-status-row">
            <span className={`form-hint ${
              heartbeatStatus === 'success' ? 'form-hint-success' :
              heartbeatStatus === 'failed' ? 'form-hint-error' :
              heartbeatStatus === 'pending' ? 'form-hint-info' : 'form-hint-muted'
            }`}>
              {heartbeatStatus === 'success' && `已登录，心跳正常 (最后成功心跳 ${lastHeartbeatAt ? new Date(lastHeartbeatAt).toLocaleTimeString() : '-'})`}
              {heartbeatStatus === 'failed' && `已登录，心跳失败 (${heartbeatError || '网络错误'})，下一周期自动重试${lastHeartbeatAt ? `；最后成功心跳 ${new Date(lastHeartbeatAt).toLocaleTimeString()}` : ''}`}
              {heartbeatStatus === 'pending' && '已登录，心跳发送中...'}
              {heartbeatStatus === 'idle' && `已登录，心跳未上报${lastHeartbeatAt ? `（历史最后心跳 ${new Date(lastHeartbeatAt).toLocaleTimeString()}）` : ''}`}
            </span>
            <button
              className="settings-btn settings-btn-sm settings-btn-outline"
              disabled={heartbeatStatus === 'pending'}
              title="手动诊断：强制立即发送一次心跳"
              onClick={() => void sendHeartbeat()}
            >
              立即上报
            </button>
          </div>
        )}

        <div className="form-group">
          <label>连接状态</label>
          <p className="form-hint">
            {`服务器版本：${serverVersion || '未知'} · Runtime：由登录账户下发 · 心跳：${heartbeatStatus === 'success' ? '正常' : heartbeatStatus || '未上报'}`}
          </p>
        </div>
      </section>
    );
  }

  function renderImageGen() {
    return (
      <section className="settings-card">
        <h3 className="settings-section-title">默认图片生成参数</h3>
        <p className="settings-section-desc">新任务的默认尺寸、质量与输出格式。图片生成模型与 AI 对话模型相互独立。</p>
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
      </section>
    );
  }

  function renderFiles() {
    return (
      <section className="settings-card">
        <h3 className="settings-section-title">图片与文件</h3>
        <div className="form-group">
          <div className="label-row">
            <label>生成图片保存目录</label>
          </div>
          <div className="dir-input">
            <input
              type="text"
              value={draftSettings.default_output_dir}
              onChange={event => updateDraft({ default_output_dir: event.target.value })}
              placeholder="留空将使用桌面作为默认目录"
            />
            <button className="settings-btn settings-btn-secondary" onClick={() => void pickDirectory('default_output_dir')}>选择目录</button>
            <button
              className="settings-btn settings-btn-secondary"
              onClick={() => void openDirectory(draftSettings.default_output_dir)}
              disabled={!draftSettings.default_output_dir.trim()}
            >打开目录</button>
          </div>
          <p className="form-hint">生成、编辑和批量任务产生的图片默认保存到这里。留空时会回退到桌面。</p>
        </div>
        <div className="form-group">
          <div className="label-row">
            <label>图片库素材目录</label>
          </div>
          <div className="dir-input">
            <input
              type="text"
              value={draftSettings.library_input_dir}
              onChange={event => updateDraft({ library_input_dir: event.target.value })}
              placeholder="可选，留空表示不扫描额外素材"
            />
            <button className="settings-btn settings-btn-secondary" onClick={() => void pickDirectory('library_input_dir')}>选择目录</button>
            <button
              className="settings-btn settings-btn-secondary"
              onClick={() => void openDirectory(draftSettings.library_input_dir)}
              disabled={!draftSettings.library_input_dir.trim()}
            >打开目录</button>
          </div>
          <p className="form-hint">可选。设置后，图片库会额外扫描该目录中的本地图片。</p>
        </div>
        <div className="settings-actions-row">
          <button className="settings-btn settings-btn-outline" onClick={() => void refreshLibrary()}>重新扫描图片库</button>
        </div>
      </section>
    );
  }

  function renderPostprocess() {
    return (
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
      </section>
    );
  }

  function renderDiagnostics() {
    // AI 智能体诊断动态化：展示当前选中 Profile + 模型
    const active = useAIProviderStore.getState().getSelection('');
    return (
      <section className="settings-card env-check-card">
        <h3 className="settings-section-title">运行环境诊断</h3>
        <p className="settings-section-desc">
          一键检查 CyImagePro Server、账户状态、Windows 网络与系统代理、Runtime Token、当前 AI 智能体、图片生成、图片目录与后处理。
          Token 仅显示掩码；轻量自检不会调用真实图片生成，不会产生费用。
        </p>

        <div className="form-group">
          <label>当前 AI 模型服务</label>
          <p className="form-hint">
            {active
              ? `模型服务：${active.profile.name} · 模型：${active.model.display_name || active.model.model_id} · 状态：${active.model.test_status === 'available' ? '可用' : active.model.test_status === 'failed' ? '测试失败' : '未测试'}`
              : '未选择用户模型服务，AI 对话与任务规划将不可用（请在上方「AI 智能体」中配置）。'}
          </p>
        </div>

        <div className="form-group">
          <label>Runtime 状态（只读）</label>
          <pre
            className="endpoint-check-meta"
            style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}
          >{buildRuntimeDiagnosticText()}</pre>
        </div>

        <div className="settings-actions-row">
          <button
            className="settings-btn settings-btn-primary"
            disabled={envChecking}
            onClick={() => void runEnvironmentCheck()}
          >
            {envChecking ? '检查中...' : '一键检查运行环境'}
          </button>
          <button
            className="settings-btn settings-btn-secondary"
            onClick={() => copyDiagnosticInfo()}
          >
            复制诊断信息
          </button>
          <button
            className="settings-btn settings-btn-outline"
            disabled={testImageBusy}
            onClick={() => void runTestImageGeneration()}
            title="将调用一次真实 gpt-image-2，会产生一次图片生成费用"
          >
            {testImageBusy ? '生成中...' : '生成 1 张测试图'}
          </button>
        </div>
        {envStatus && <p className="form-hint">{envStatus}</p>}
        {testImageStatus && <p className="form-hint">{testImageStatus}</p>}

        {envCheck && (
          <div className="endpoint-check-grid">
            {envCheck.items.map(item => (
              <div key={item.key} className={`endpoint-check-card ${item.status === 'ok' ? 'ok' : item.status === 'warn' ? 'warn' : 'fail'}`}>
                <div className="endpoint-check-head">
                  <strong>{item.title}</strong>
                  <span>
                    {item.status === 'ok' && '✅ 正常'}
                    {item.status === 'warn' && '⚠ 提示'}
                    {item.status === 'error' && '❌ 异常'}
                    {item.status === 'pending' && '⏳ 检查中'}
                    {item.latency_ms != null && ` · ${item.latency_ms} ms`}
                  </span>
                </div>
                <div className="endpoint-check-message">{item.summary}</div>
                {item.detail && (
                  <pre className="endpoint-check-meta" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{item.detail}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        {testImage && (
          <div className={`endpoint-check-card ${testImage.ok ? 'ok' : 'fail'}`}>
            <div className="endpoint-check-head">
              <strong>测试图结果</strong>
              <span>{testImage.ok ? '✅ 成功' : '❌ 失败'}{testImage.http_status ? ` · HTTP ${testImage.http_status}` : ''}{testImage.latency_ms ? ` · ${(testImage.latency_ms / 1000).toFixed(1)} s` : ''}</span>
            </div>
            <div className="endpoint-check-message">
              Endpoint：{testImage.endpoint}
            </div>
            {testImage.saved_path && (
              <pre className="endpoint-check-meta" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>保存路径：{testImage.saved_path}</pre>
            )}
            {testImage.error_message && (
              <pre className="endpoint-check-meta" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{testImage.error_message}</pre>
            )}
          </div>
        )}

        <div className="form-group">
          <label>服务器视觉模型（参考）</label>
          <p className="form-hint">
            {modelsLoading
              ? '正在加载服务器模型...'
              : modelsError
                ? `服务器模型获取失败：${modelsError}`
                : visionModelHint}
          </p>
        </div>
      </section>
    );
  }

  function renderUpdate() {
    const busy = updateStatus.phase === 'checking' || updateStatus.phase === 'downloading' || updateStatus.phase === 'installing';
    return (
      <section className="settings-card">
        <h3 className="settings-section-title">CyImagePro</h3>
        <div className="form-group">
          <label>当前版本</label>
          <div className="current-version-row">
            <span className="current-version-value">{appVersion ? `V${appVersion}` : '读取中...'}</span>
            <span className="release-stage-badge">{RELEASE_INFO.label}</span>
          </div>
        </div>
        <div className="settings-actions-row">
          <button className="settings-btn settings-btn-primary" disabled={busy} onClick={() => void handleCheckUpdate()}>
            {updateStatus.phase === 'checking' ? '检查中...' : updateStatus.phase === 'check_failed' ? '重新检查' : '检查更新'}
          </button>
          {updateStatus.phase === 'update_available' && (
            <span className="form-hint form-hint-warning">
              发现新版本 V{updateStatus.latestVersion}（当前 V{appVersion || '?'}），请点击左侧「关于我们」下方的版本按钮，或前往侧边栏底部版本入口立即更新。
            </span>
          )}
          {updateStatus.phase === 'restart_required' && (
            <span className="form-hint form-hint-warning">更新 V{updateStatus.latestVersion} 已下载完成，请通过侧边栏版本入口重启安装。</span>
          )}
          {updateStatus.phase === 'downloading' && (
            <span className="form-hint form-hint-warning">正在下载更新 V{updateStatus.latestVersion}...</span>
          )}
          {updateStatus.phase === 'download_failed' && (
            <span className="form-hint form-hint-error">V{updateStatus.latestVersion} 下载失败：{updateStatus.error ?? '暂时无法连接更新服务器，请检查网络后重试。'}请通过侧边栏版本入口重试更新。</span>
          )}
          {updateStatus.phase === 'installing' && (
            <span className="form-hint form-hint-warning">正在安装更新，应用将自动重启...</span>
          )}
          {updateStatus.phase === 'latest' && (
            <span className="form-hint form-hint-success">✓ 当前已是最新版本。</span>
          )}
          {updateStatus.phase === 'check_failed' && (
            <span className="form-hint form-hint-error">检查更新失败：{updateStatus.error ?? '无法获取最新版本信息，请检查网络后重试。'}</span>
          )}
        </div>
        <div className="form-group">
          <label>应用信息</label>
          <p className="form-hint">更新通道：官方服务器（www.zjcypc.com，GitHub Releases 备用）· 安装模式：passive（下载完成后询问安装）。</p>
        </div>
      </section>
    );
  }

  const sectionContent = () => {
    switch (activeSection) {
      case 'general': return renderGeneral();
      case 'server': return renderServer();
      case 'agents': return <AgentProviderSettings category="agent" />;
      case 'vision': return <AgentProviderSettings category="vision" />;
      case 'airouting': return (
        <AiModelUsageSettings onNavigateSection={section => { setActiveSection(section); setSettingsStatus(''); }} />
      );
      case 'imagegen': return renderImageGen();
      case 'files': return renderFiles();
      case 'postprocess': return renderPostprocess();
      case 'diagnostics': return renderDiagnostics();
      case 'update': return renderUpdate();
      default: return null;
    }
  };

  const showSectionFooter = ['general', 'server', 'imagegen', 'files', 'postprocess'].includes(activeSection);

  return (
    <div className="page settings-page settings-page-wide">
      <div className="page-header">
        <h2>设置与更新</h2>
        <p>配置服务、AI 智能体、生成参数、文件、工具与软件更新。</p>
      </div>
      <StatusBar text={settingsStatusText} />

      <div className="settings-center">
        <nav className="settings-nav">
          {SETTINGS_NAV.map(item => (
            <button
              key={item.key}
              className={`settings-nav-item ${activeSection === item.key ? 'active' : ''}`}
              onClick={() => {
                setActiveSection(item.key);
                setSettingsStatus('');
              }}
              title={item.desc}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {sectionContent()}
          {showSectionFooter && (
            <div className="settings-section-footer">
              <button className="settings-btn settings-btn-secondary" onClick={resetCurrentSection} disabled={!currentSectionDirty || savingSection !== null}>
                恢复已保存值
              </button>
              <button className="settings-btn settings-btn-primary" onClick={() => void saveCurrentSection()} disabled={!currentSectionDirty || savingSection !== null}>
                {savingSection !== null ? '保存中...' : '保存更改'}
              </button>
            </div>
          )}
        </div>
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

  // ============ 模板中心 Tabs（保持原有能力） ============

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
}
