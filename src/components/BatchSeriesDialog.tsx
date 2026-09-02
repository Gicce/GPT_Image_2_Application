import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { useTaskStore } from '../store/useTaskStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { toastError, toastSuccess } from './Toast';
import type { ImageRecord, Task } from '../types';
import { getBatchPreset, listBatchPresets, type BatchPreset } from '../features/batchSeries/batchPresets';
import {
  buildSeriesItems,
  buildSeriesTemplate,
  collectCompletedSeriesValues,
  detectPresetValue,
  renderSeriesPrompt,
  SERIES_LOCKED_CONSTRAINT_LABELS,
  type SeriesItemDraft,
  type SeriesLockedConstraint,
} from '../features/batchSeries/seriesTemplate';
import { buildSeriesTask, resolveSourceExecutedPrompts } from '../features/batchSeries/buildSeriesTask';
import { formatTaskTime } from '../utils/taskDisplay';
import './BatchSeriesDialog.css';

/**
 * 系列批量（批量同效果生成）四步向导 —— V6.1 Wizard Geometry（固定 Header/Body/Footer）。
 *
 * Step1 来源任务 → Step2 继承与预设 → Step3 模板确认 → Step4 成员预览 → 开始批量生成。
 * 三入口共用本组件：批量页「从已有任务导入」/ 任务队列成功任务卡 / 历史详情。
 * 从队列 / 历史进入时携带 preselectedTaskId，直接从 Step2 开始。
 */

const SERIES_STEPS = ['选择来源', '继承与预设', '模板确认', '成员预览'] as const;

/** 系列候选来源：真实图片任务（generate / edit）且有成功产出 */
function eligibleSeriesSource(task: Task): boolean {
  if (task.task_type !== 'generate' && task.task_type !== 'edit') return false;
  return task.success_count > 0;
}

export default function BatchSeriesDialog(props: { preselectedTaskId?: string; onClose: () => void }) {
  const { tasks, createSeriesTask } = useTaskStore();
  const candidates = useMemo(
    () => tasks.filter(eligibleSeriesSource).slice(0, 30),
    [tasks],
  );

  const [step, setStep] = useState(props.preselectedTaskId ? 1 : 0);
  const [sourceTaskId, setSourceTaskId] = useState(props.preselectedTaskId ?? '');
  const [imagesById, setImagesById] = useState<Map<string, ImageRecord>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  // Step2 状态（默认预设取注册表第一条，组件不硬编码任何具体预设 id）
  const [presetId, setPresetId] = useState<string>(() => listBatchPresets()[0]?.id ?? '');
  const [customValuesText, setCustomValuesText] = useState('');
  /** 主题原值判定：auto = 自动检测；none = 明确未包含（追加式）；custom = 用户指定 */
  const [themeMode, setThemeMode] = useState<'auto' | 'none' | 'custom'>('auto');
  const [themeValueCustom, setThemeValueCustom] = useState('');
  const [skipCompleted, setSkipCompleted] = useState(true);
  const [locked, setLocked] = useState<Set<SeriesLockedConstraint>>(new Set<SeriesLockedConstraint>([
    'positive-prompt-base', 'negative-prompt', 'style', 'generation-params',
  ]));
  const [useSuccessRef, setUseSuccessRef] = useState(true);

  // Step3 状态（null = 跟随自动模板；编辑后固定为用户文本）
  const [templateText, setTemplateText] = useState<string | null>(null);
  const [negativeText, setNegativeText] = useState<string | null>(null);

  // Step4 状态
  const [items, setItems] = useState<SeriesItemDraft[] | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editNegative, setEditNegative] = useState('');

  const source = tasks.find(t => t.id === sourceTaskId) ?? null;
  const presets = listBatchPresets();
  const preset: BatchPreset | null = useMemo(() => {
    if (presetId !== 'custom') return getBatchPreset(presetId);
    const lines = customValuesText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    return {
      id: 'custom',
      name: '自定义系列',
      variableKey: 'item',
      variableLabel: '变量',
      items: lines.map((line, index) => ({ id: `custom-${index}`, label: line, value: line })),
    };
  }, [presetId, customValuesText]);

  // 图片 id → 记录（成功结果图路径解析；弹窗打开时拉一次）
  useEffect(() => {
    let alive = true;
    void api.getImages().then(records => {
      if (!alive) return;
      setImagesById(new Map(records.map(record => [record.id, record])));
    }).catch(() => { /* 图库读取失败不阻断：仅影响成功图预览与参考继承 */ });
    return () => { alive = false; };
  }, []);

  const sourceExec = source ? resolveSourceExecutedPrompts(source) : null;
  const successImagePath = useMemo(() => {
    if (!source) return undefined;
    const completedImageId = source.sub_tasks.find(st => st.status === 'completed' && st.image_id)?.image_id;
    if (!completedImageId) return undefined;
    return imagesById.get(completedImageId)?.local_path;
  }, [source, imagesById]);

  const detectedValue = preset && sourceExec ? detectPresetValue(sourceExec.positivePrompt, preset) : null;
  const themeValue = themeMode === 'none' ? null : themeMode === 'custom' ? (themeValueCustom.trim() || null) : detectedValue;

  const template = useMemo(() => {
    if (!source || !sourceExec || !preset) return null;
    const effectiveType: 'generate' | 'edit' = useSuccessRef && successImagePath
      ? 'edit'
      : (source.source_images?.length ?? 0) > 0 ? 'edit' : 'generate';
    const base = buildSeriesTemplate({
      sourceTaskId: source.id,
      sourcePositivePrompt: sourceExec.positivePrompt,
      sourceNegativePrompt: sourceExec.negativePrompt,
      sourceUserRequirement: sourceExec.userRequirement,
      sourceTaskType: effectiveType,
      preset,
      themeValue,
      lockedConstraints: [...locked, ...(useSuccessRef && successImagePath ? (['success-image-reference'] as SeriesLockedConstraint[]) : [])],
      referenceImages: locked.has('reference-images') ? source.source_images ?? [] : [],
      generationParams: locked.has('generation-params')
        ? { size: source.size, quality: source.quality, format: source.output_format }
        : {},
      useSuccessImageAsReference: useSuccessRef,
      ...(successImagePath ? { successImagePath } : {}),
    });
    return {
      ...base,
      sharedPositiveTemplate: templateText ?? base.sharedPositiveTemplate,
      sharedNegativePrompt: negativeText ?? (locked.has('negative-prompt') ? base.sharedNegativePrompt : ''),
    };
    // 模板编辑文本单独跟随（不重算），来源/预设/主题/继承变化时以自动模板为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, preset, themeMode, themeValueCustom, detectedValue, locked, useSuccessRef, successImagePath]);

  // 来源 / 预设 / 主题 / 继承变化 → 清除手动模板文本（回到自动模板）
  useEffect(() => {
    setTemplateText(null);
    setNegativeText(null);
  }, [sourceTaskId, presetId, customValuesText, themeMode, themeValueCustom, useSuccessRef]);

  // 进入 Step4：按当前模板重建成员（修改模板后回到本页会重新生成）
  useEffect(() => {
    if (step === 3 && template && preset) {
      setItems(buildSeriesItems({
        template,
        preset,
        completedValues: collectCompletedSeriesValues(tasks, preset.id),
        skipCompleted,
      }));
      setEditingIndex(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const completedValues = preset ? collectCompletedSeriesValues(tasks, preset.id) : [];
  const slotKey = template?.variableSlots[0]?.key ?? preset?.variableKey ?? '';
  const templateHasSlot = template ? template.sharedPositiveTemplate.includes(`{{${slotKey}}}`) : false;
  const previewRender = template && preset
    ? renderSeriesPrompt(template.sharedPositiveTemplate, { [slotKey]: preset.items[0]?.value ?? '' })
    : '';

  function toggleLocked(key: SeriesLockedConstraint) {
    setLocked(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function patchItem(index: number, patch: Partial<SeriesItemDraft>) {
    setItems(prev => prev?.map((item, i) => (i === index ? { ...item, ...patch } : item)) ?? null);
  }

  function startEdit(index: number) {
    const item = items?.[index];
    if (!item) return;
    setEditingIndex(index);
    setEditPrompt(item.prompt);
    setEditNegative(item.negativePrompt);
  }

  async function startGeneration() {
    if (!template || !preset || !items) return;
    const enabled = items.filter(item => item.enabled);
    if (enabled.length === 0) {
      toastError('请至少启用一个系列成员');
      return;
    }
    const settings = useSettingsStore.getState().settings;
    setSubmitting(true);
    try {
      const built = buildSeriesTask({
        template,
        items,
        presetId: preset.id,
        userRequirement: `系列批量 · ${preset.name}（基于来源任务效果）`,
        outputDir: settings.default_output_dir,
        size: template.generationParams.size || settings.default_size,
        quality: template.generationParams.quality || settings.default_quality,
        outputFormat: template.generationParams.format || settings.default_format,
      });
      await createSeriesTask(built.params, built.total);
      toastSuccess(`已提交系列批量任务（${built.total} 张），可在任务队列查看进度`);
      window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'queue' } }));
      props.onClose();
    } catch (err: any) {
      toastError(err?.message || '创建系列批量任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  const canNext = step === 0
    ? Boolean(sourceTaskId)
    : step === 1
      ? Boolean(preset)
      : step === 2
        ? Boolean(template && template.sharedPositiveTemplate.trim())
        : Boolean(items && items.some(item => item.enabled));

  return (
    <div className="bsr-overlay" onClick={props.onClose}>
      <div className="bsr-dialog" role="dialog" aria-label="系列批量（批量同效果生成）" onClick={e => e.stopPropagation()}>
        <div className="bsr-header">
          <div>
            <h2>批量同效果生成</h2>
            <p>把成功任务拆成「固定部分 + 变量槽」模板，逐项独立生成同效果系列</p>
          </div>
          <ol className="bsr-stepper" aria-label="步骤">
            {SERIES_STEPS.map((label, index) => (
              <li key={label} className={index === step ? 'is-active' : index < step ? 'is-done' : ''}>
                <b>{index + 1}</b><span>{label}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="bsr-close" aria-label="关闭" onClick={props.onClose}>×</button>
        </div>

        <div className="bsr-body">
          {step === 0 && (
            <div className="bsr-step">
              <p className="bsr-hint">选择一个有成功结果的图片任务作为系列来源（模板从它的实际执行 Prompt 拆分）：</p>
              {candidates.length === 0 && <p className="bsr-empty">暂无可选任务：需要有成功产出的文生图 / 图生图任务。</p>}
              <div className="bsr-task-list">
                {candidates.map(task => (
                  <label key={task.id} className={`bsr-task-item${sourceTaskId === task.id ? ' is-selected' : ''}`}>
                    <input
                      type="radio"
                      name="bsr-source"
                      checked={sourceTaskId === task.id}
                      onChange={() => setSourceTaskId(task.id)}
                    />
                    <span className="bsr-task-main">
                      <span className="bsr-task-title">{(task.user_prompt_raw || task.prompt || '未命名任务').slice(0, 80)}</span>
                      <span className="bsr-task-meta">
                        {formatTaskTime(task.created_at)} · 成功 {task.success_count} 张 · {task.execution_mode === 'batch' ? '批量' : '单张'}
                        {task.execution_snapshot ? ' · 有执行快照' : ' · 旧任务（无快照）'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {step === 1 && source && sourceExec && (
            <div className="bsr-step">
              <div className="bsr-block">
                <h3>继承内容</h3>
                {successImagePath && (
                  <label className="bsr-check">
                    <input
                      type="checkbox"
                      checked={useSuccessRef}
                      onChange={e => setUseSuccessRef(e.target.checked)}
                    />
                    <span>{SERIES_LOCKED_CONSTRAINT_LABELS['success-image-reference']}（推荐：保证系列风格一致）</span>
                  </label>
                )}
                {([
                  ['positive-prompt-base', (source.source_images?.length ?? 0) > 0],
                  ['negative-prompt', true],
                  ['style', true],
                  ['generation-params', true],
                  ['reference-images', (source.source_images?.length ?? 0) > 0],
                ] as Array<[SeriesLockedConstraint, boolean]>).map(([key, applicable]) => (
                  <label key={key} className={`bsr-check${applicable ? '' : ' is-na'}`}>
                    <input
                      type="checkbox"
                      disabled={!applicable}
                      checked={applicable && locked.has(key)}
                      onChange={() => toggleLocked(key)}
                    />
                    <span>{SERIES_LOCKED_CONSTRAINT_LABELS[key]}{applicable ? '' : '（来源任务无此项）'}</span>
                  </label>
                ))}
                {!sourceExec.fromSnapshot && (
                  <p className="bsr-notice">旧版本任务：未记录完整执行快照，模板将基于 final_prompt 字段构建。</p>
                )}
              </div>

              <div className="bsr-block">
                <h3>系列预设</h3>
                <div className="bsr-preset-row">
                  {presets.map(p => (
                    <label key={p.id} className={`bsr-preset${presetId === p.id ? ' is-selected' : ''}`}>
                      <input type="radio" name="bsr-preset" checked={presetId === p.id} onChange={() => setPresetId(p.id)} />
                      <span>{p.name}（{p.items.length} 项）</span>
                    </label>
                  ))}
                  <label className={`bsr-preset${presetId === 'custom' ? ' is-selected' : ''}`}>
                    <input type="radio" name="bsr-preset" checked={presetId === 'custom'} onChange={() => setPresetId('custom')} />
                    <span>自定义系列</span>
                  </label>
                </div>
                {presetId === 'custom' && (
                  <textarea
                    className="bsr-custom-values"
                    rows={4}
                    value={customValuesText}
                    onChange={e => setCustomValuesText(e.target.value)}
                    placeholder="每行一个变量值，例如：&#10;红色&#10;蓝色&#10;金色"
                  />
                )}
                {presetId !== 'custom' && preset && (
                  <p className="bsr-hint">成员：{preset.items.map(item => item.label).join(' · ')}</p>
                )}
              </div>

              {preset && (
                <div className="bsr-block">
                  <h3>主题原值判定</h3>
                  <p className="bsr-hint">
                    系统在来源 Prompt 中{detectedValue ? <>检测到主题值「<b>{detectedValue}</b>」</> : '未检测到预设主题值'}；
                    检测结果可修改，判定影响模板拆分方式。
                  </p>
                  <div className="bsr-preset-row">
                    <label className={`bsr-preset${themeMode === 'auto' ? ' is-selected' : ''}`}>
                      <input type="radio" name="bsr-theme" checked={themeMode === 'auto'} onChange={() => setThemeMode('auto')} />
                      <span>自动检测{detectedValue ? `（${detectedValue}）` : '（将追加主题声明）'}</span>
                    </label>
                    <label className={`bsr-preset${themeMode === 'custom' ? ' is-selected' : ''}`}>
                      <input type="radio" name="bsr-theme" checked={themeMode === 'custom'} onChange={() => setThemeMode('custom')} />
                      <span>手动指定</span>
                    </label>
                    <label className={`bsr-preset${themeMode === 'none' ? ' is-selected' : ''}`}>
                      <input type="radio" name="bsr-theme" checked={themeMode === 'none'} onChange={() => setThemeMode('none')} />
                      <span>不替换（文末追加主题声明）</span>
                    </label>
                  </div>
                  {themeMode === 'custom' && (
                    <input
                      className="bsr-theme-input"
                      value={themeValueCustom}
                      onChange={e => setThemeValueCustom(e.target.value)}
                      placeholder="来源 Prompt 中的主题词（将被 {{变量槽}} 替换）"
                    />
                  )}
                  <label className="bsr-check">
                    <input type="checkbox" checked={skipCompleted} onChange={e => setSkipCompleted(e.target.checked)} />
                    <span>跳过已经完成的主题{completedValues.length > 0 ? `（检测到已完成 ${completedValues.length} 项：${completedValues.join('、')}）` : '（暂无已完成记录）'}</span>
                  </label>
                </div>
              )}
            </div>
          )}

          {step === 2 && template && preset && (
            <div className="bsr-step">
              <div className="bsr-block">
                <h3>系列模板（固定部分 + {'{{' + slotKey + '}}'} 变量槽）</h3>
                {template.appendedDeclaration && (
                  <p className="bsr-notice">来源 Prompt 未包含主题值，模板采用文末追加声明（独立段落，不与原主题冲突）。</p>
                )}
                <textarea
                  className="bsr-template-textarea"
                  rows={8}
                  value={template.sharedPositiveTemplate}
                  onChange={e => setTemplateText(e.target.value)}
                />
                {!templateHasSlot && (
                  <p className="bsr-notice warn">模板中没有变量槽 {'{{' + slotKey + '}}'}：所有成员将使用完全相同的 Prompt。</p>
                )}
                <p className="bsr-hint">首项渲染预览：{previewRender.slice(0, 160)}{previewRender.length > 160 ? '…' : ''}</p>
              </div>
              <div className="bsr-block">
                <h3>共享负面 Prompt{locked.has('negative-prompt') ? '' : '（未继承，可留空）'}</h3>
                <textarea
                  className="bsr-template-textarea"
                  rows={3}
                  value={template.sharedNegativePrompt}
                  onChange={e => setNegativeText(e.target.value)}
                  placeholder="不希望出现在任何成员中的内容（可编辑，可为空）"
                />
              </div>
            </div>
          )}

          {step === 3 && items && template && (
            <div className="bsr-step">
              <p className="bsr-hint">
                共 {items.length} 个成员，启用 {items.filter(i => i.enabled).length} 个；
                修改模板后回到本页会按新模板重新生成。每项独立执行、独立计费、失败互不影响。
              </p>
              <table className="bsr-items-table">
                <thead>
                  <tr><th>状态</th><th>主题</th><th>Prompt</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={item.presetItemId} className={item.enabled ? '' : 'is-disabled'}>
                      <td>{item.enabled ? '启用' : item.completed ? '已完成·跳过' : '已禁用'}</td>
                      <td><b>{item.label}</b></td>
                      <td className="bsr-item-prompt" title={item.prompt}>
                        {editingIndex === index ? (
                          <div className="bsr-item-edit">
                            <textarea rows={4} value={editPrompt} onChange={e => setEditPrompt(e.target.value)} />
                            <textarea rows={2} value={editNegative} onChange={e => setEditNegative(e.target.value)} placeholder="负面 Prompt（可为空）" />
                          </div>
                        ) : (item.prompt.length > 80 ? `${item.prompt.slice(0, 80)}…` : item.prompt)}
                      </td>
                      <td className="bsr-item-actions">
                        {editingIndex === index ? (
                          <>
                            <button type="button" className="settings-btn settings-btn-link settings-btn-sm" onClick={() => { patchItem(index, { prompt: editPrompt, negativePrompt: editNegative }); setEditingIndex(null); }}>保存</button>
                            <button type="button" className="settings-btn settings-btn-link settings-btn-sm" onClick={() => setEditingIndex(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="settings-btn settings-btn-link settings-btn-sm" onClick={() => startEdit(index)}>编辑</button>
                            <button type="button" className="settings-btn settings-btn-link settings-btn-sm" onClick={() => setItems(prev => prev?.filter((_, i) => i !== index) ?? null)}>删除</button>
                            <button type="button" className="settings-btn settings-btn-link settings-btn-sm" onClick={() => patchItem(index, { enabled: !item.enabled })}>
                              {item.enabled ? '禁用' : '恢复'}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bsr-footer">
          <button type="button" className="app-btn app-btn-secondary" onClick={props.onClose}>取消</button>
          <div className="bsr-footer-right">
            {step > (props.preselectedTaskId ? 1 : 0) && (
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setStep(s => s - 1)}>上一步</button>
            )}
            {step < 3 ? (
              <button type="button" className="app-btn app-btn-primary" disabled={!canNext} onClick={() => setStep(s => s + 1)}>下一步</button>
            ) : (
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={submitting || !canNext}
                onClick={() => void startGeneration()}
              >
                {submitting ? '创建中…' : `开始批量生成（${items?.filter(i => i.enabled).length ?? 0} 张）`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
