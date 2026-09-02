/**
 * 删除漫画项目确认弹窗（Destructive CRUD Pattern）：
 * 文案列明删除范围——只删本地项目文档，不删图片文件 / 不删技能与演员库；
 * 删除的是「当前打开项目」时由父层同步关闭编辑态。
 */

import { createPortal } from 'react-dom';
import './ComicDialog.css';

export interface ComicDeleteProjectDialogProps {
  projectName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ComicDeleteProjectDialog(props: ComicDeleteProjectDialogProps) {
  return createPortal(
    <div className="comic-dialog-overlay" onMouseDown={e => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <section className="comic-dialog comic-dialog-sm" role="dialog" aria-modal="true" aria-label="删除漫画项目" onMouseDown={e => e.stopPropagation()}>
        <header className="comic-dialog-header">
          <div><h3>删除漫画项目</h3></div>
        </header>
        <div className="comic-dialog-body">
          <p>确定要删除「{props.projectName}」吗？此操作无法撤销。</p>
          <p className="comic-muted">只删除本地项目文档；已生成的图片文件、漫画技能库与演员库不受影响。</p>
        </div>
        <footer className="comic-dialog-footer">
          <div />
          <div className="comic-dialog-actions">
            <button type="button" className="app-btn app-btn-secondary" onClick={props.onCancel}>取消</button>
            <button type="button" className="app-btn app-btn-danger" onClick={props.onConfirm}>删除</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
