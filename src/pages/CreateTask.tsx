import { useState, useEffect } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTaskStore } from '../store/useTaskStore';
import { useDraftStore } from '../store/useDraftStore';
import { useAuthStore } from '../store/useAuthStore';
import { api } from '../services/api';
import { serverApi } from '../services/serverApi';
import { authorizeImageTask, settleImageTask, createRequestId, registerTaskAuthorization, isQuoteCancelled } from '../services/billingService';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import SuccessDialog from '../components/SuccessDialog';
import './CreateTask.css';

export default function CreateTask() {
  const { settings } = useSettingsStore();
  const { addTask } = useTaskStore();
  const {
    textToImagePrompt: prompt,
    textToImageNegative: negativePrompt,
    setTextToImagePrompt: setPrompt,
    setTextToImageNegative: setNegativePrompt,
  } = useDraftStore();

  const [size, setSize] = useState(settings.default_size);
  const [quality, setQuality] = useState(settings.default_quality);
  const [format, setFormat] = useState(settings.default_format);
  const [count, setCount] = useState(4);
  const [outputDir, setOutputDir] = useState(settings.default_output_dir);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [submittedCount, setSubmittedCount] = useState(0);
  // 生成按钮价格展示（§9）：单张点数来自服务端权益，客户端不自行计价
  const [unitCredits, setUnitCredits] = useState<number | null>(null);

  useEffect(() => {
    setSize(settings.default_size);
    setQuality(settings.default_quality);
    setFormat(settings.default_format);
    if (settings.default_output_dir) setOutputDir(settings.default_output_dir);
  }, [settings]);

  useEffect(() => {
    let alive = true;
    serverApi.getAccountEntitlements()
      .then(e => { if (alive) setUnitCredits(e.unit_credits ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const handleSelectDir = async () => {
    const dir = await api.selectDirectory();
    if (dir) setOutputDir(dir);
  };

  const handleSubmit = async () => {
    setError('');

    if (!settings.token.trim()) {
      setError('请先在「设置与更新 → 服务连接」中确认服务器连接');
      return;
    }
    if (!prompt.trim()) {
      setError('请输入提示词');
      return;
    }
    if (!outputDir.trim()) {
      setError('请选择输出目录');
      return;
    }

    // 生成前报价确认 + 预占额度（server billing mode）：报价弹层取消 / 点数不足在此阻断
    const { isLoggedIn } = useAuthStore.getState();
    let billingRequestId: string | undefined;
    if (isLoggedIn) {
      try {
        billingRequestId = createRequestId('task');
        await authorizeImageTask(billingRequestId, count);
      } catch (err: any) {
        if (!isQuoteCancelled(err)) {
          setError(err?.message || '点数不足，请充值后继续使用');
        }
        return;
      }
    }

    setSubmitting(true);
    try {
      const task = await api.createTask({
        prompt: prompt.trim(),
        negative_prompt: negativePrompt.trim(),
        size,
        quality,
        output_format: format,
        count,
        output_dir: outputDir,
        task_type: 'generate',
        source_images: [],
      });
      addTask(task);
      if (billingRequestId) registerTaskAuthorization(task.id, billingRequestId);
      setSubmittedCount(count);
      setPrompt('');
      setNegativePrompt('');
      setCount(4);
      setShowSuccess(true);
    } catch (err: any) {
      if (billingRequestId) void settleImageTask(billingRequestId, false, 0, 'create task failed');
      setError(err?.toString() || '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>创建批量生成任务</h2>
        <p>配置参数并批量生成多张 AI 图片</p>
      </div>

      <div className="create-layout">
        <div className="create-form">
          {error && <div className="error-banner">{error}</div>}

          <div className="form-group">
            <label>提示词 <span className="required">*</span></label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="描述你想要生成的图片，越详细效果越好..."
              rows={4}
            />
          </div>

          <div className="form-group">
            <label>负面提示词</label>
            <textarea
              value={negativePrompt}
              onChange={e => setNegativePrompt(e.target.value)}
              placeholder="描述你不希望出现在图片中的内容（当前接口暂不支持，预留字段）"
              rows={2}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>图片尺寸</label>
              <select value={size} onChange={e => setSize(e.target.value)}>
                {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>质量</label>
              <select value={quality} onChange={e => setQuality(e.target.value)}>
                {QUALITIES.map(q => <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>)}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>输出格式</label>
              <select value={format} onChange={e => setFormat(e.target.value)}>
                {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>生成数量</label>
              <input
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={e => setCount(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
              />
            </div>
          </div>

          <div className="form-group">
            <label>输出目录</label>
            <div className="dir-input">
              <input
                type="text"
                value={outputDir}
                onChange={e => setOutputDir(e.target.value)}
                placeholder="选择图片保存位置"
                readOnly
              />
              <button className="browse-btn" onClick={handleSelectDir}>浏览</button>
            </div>
          </div>
        </div>

        <div className="task-summary-card">
          <h3>任务摘要</h3>
          <div className="summary-item">
            <span className="summary-label">提示词</span>
            <span className="summary-value">{prompt || '未填写'}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">图片尺寸</span>
            <span className="summary-value">{size}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">质量</span>
            <span className="summary-value">{quality}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">输出格式</span>
            <span className="summary-value">{format.toUpperCase()}</span>
          </div>
          <div className="summary-divider" />
          <div className="summary-item highlight">
            <span className="summary-label">生成数量</span>
            <span className="summary-value">{count} 张</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">输出目录</span>
            <span className="summary-value path">{outputDir || '未选择'}</span>
          </div>
          <button
            className="start-btn"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? '创建中...'
              : `开始生成 ${count} 张图片${unitCredits != null ? ` · 预计 ${unitCredits * count} 点` : ''}`}
          </button>
          <p className="summary-note">
            系统将为每张图片单独调用 API，确保稳定性。可在「任务队列」中查看实时进度；
            提交前会显示本次预计消耗的点数，按实际成功张数结算。
          </p>
        </div>
      </div>

      {showSuccess && (
        <SuccessDialog
          title="任务已提交"
          message={`已成功创建 ${submittedCount} 张图片的生成任务，请前往「任务队列」查看实时进度。`}
          onClose={() => setShowSuccess(false)}
        />
      )}
    </div>
  );
}
