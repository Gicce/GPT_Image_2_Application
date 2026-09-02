/**
 * 新建演员草稿弹窗（Phase 1.2-E，规格 §22B/§22C）——
 * 「从图库添加演员」/「上传演员参考图」选定图片后，补齐名称与一句话设定，
 * 创建 Library Character Draft 入库。图片只引用（Asset ID / Local Path），不复制二进制（§25）。
 */

import { useState } from 'react';
import './ComicDialog.css';

export interface ComicActorDraftDialogProps {
  open: boolean;
  /** 弹窗标题（从图库添加演员 / 上传演员参考图）。 */
  title: string;
  /** 参考图预览（readThumbnail 数据 URL；null 显示占位）。 */
  preview: string | null;
  defaultName: string;
  busy: boolean;
  onCancel: () => void;
  /** 校验后的名称 / 一句话设定（空描述允许，normalize 有缺省）。 */
  onSave: (input: { name: string; description: string }) => void;
}

export default function ComicActorDraftDialog(props: ComicActorDraftDialogProps) {
  const [name, setName] = useState(props.defaultName);
  const [description, setDescription] = useState('');
  if (!props.open) return null;

  const trimmed = name.trim();
  return (
    <div className="comic-dialog-overlay" onMouseDown={e => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <section className="comic-dialog comic-dialog-sm" role="dialog" aria-modal="true" aria-label={props.title} onMouseDown={e => e.stopPropagation()}>
        <header className="comic-dialog-header">
          <div>
            <h3>{props.title}</h3>
            <p>图片只引用不入库副本；命名后即可在任意漫画项目里选这位演员</p>
          </div>
          <button type="button" className="comic-dialog-close" aria-label="关闭" onClick={props.onCancel}>×</button>
        </header>
        <div className="comic-dialog-body">
          {props.preview
            ? <img className="comic-actor-draft-preview" src={props.preview} alt="参考图预览" />
            : <span className="comic-actor-draft-preview comic-actor-thumb-placeholder">读取预览中…</span>}
          <div className="form-group">
            <label htmlFor="comic-actor-draft-name">演员名称</label>
            <input
              id="comic-actor-draft-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例：汤圆"
            />
          </div>
          <div className="form-group">
            <label htmlFor="comic-actor-draft-desc">一句话设定（可选）</label>
            <input
              id="comic-actor-draft-desc"
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="例：奶油黄圆脸猫，总是睡不醒"
            />
          </div>
          <div className="comic-actions-row">
            <button
              type="button"
              className="app-btn app-btn-primary app-btn-sm"
              disabled={props.busy || !trimmed}
              title={!trimmed ? '请先给演员起个名字' : undefined}
              onClick={() => props.onSave({ name: trimmed, description: description.trim() })}
            >
              {props.busy ? '保存中…' : '保存到演员库'}
            </button>
            <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onCancel}>取消</button>
          </div>
        </div>
      </section>
    </div>
  );
}
