import { useState, useEffect } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTaskStore } from '../store/useTaskStore';
import { api } from '../services/api';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import './CreateTask.css';

export default function CreateTask() {
  const { settings } = useSettingsStore();
  const { addTask } = useTaskStore();

  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [size, setSize] = useState(settings.default_size);
  const [quality, setQuality] = useState(settings.default_quality);
  const [format, setFormat] = useState(settings.default_format);
  const [count, setCount] = useState(4);
  const [outputDir, setOutputDir] = useState(settings.default_output_dir);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setSize(settings.default_size);
    setQuality(settings.default_quality);
    setFormat(settings.default_format);
    if (settings.default_output_dir) setOutputDir(settings.default_output_dir);
  }, [settings]);

  const handleSelectDir = async () => {
    const dir = await api.selectDirectory();
    if (dir) setOutputDir(dir);
  };

  const handleSubmit = async () => {
    setError('');

    if (!settings.token.trim()) {
      setError('请先在「设置」中填写 API Token');
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
      });
      addTask(task);
      setPrompt('');
      setNegativePrompt('');
      setCount(4);
    } catch (err: any) {
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
            {submitting ? '创建中...' : `开始生成 ${count} 张图片`}
          </button>
          <p className="summary-note">
            系统将为每张图片单独调用 API，确保稳定性。可在「任务队列」中查看实时进度。
          </p>
        </div>
      </div>
    </div>
  );
}
