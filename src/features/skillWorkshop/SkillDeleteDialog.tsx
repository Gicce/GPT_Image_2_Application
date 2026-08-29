/**
 * 删除「我的技能」二次确认（V6.1 Destructive CRUD）：
 * - 只删除本机 Skill 实体；Submitted 类 Skill 额外说明“不撤回投稿记录”；
 * - 文案事实源 = describeSkillDeleteNotice（纯函数，测试共用）。
 */

import { describeSkillDeleteNotice } from './userSkill';
import './SkillDeleteDialog.css';

export interface SkillDeleteTarget {
  id: string;
  name: string;
  status: string;
  hasSubmissionRecord: boolean;
}

export default function SkillDeleteDialog(props: {
  target: SkillDeleteTarget;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const notice = describeSkillDeleteNotice({
    status: props.target.status,
    hasSubmissionRecord: props.target.hasSubmissionRecord,
  });
  return (
    <div className="skill-delete-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !props.busy) props.onCancel(); }}>
      <section className="skill-delete-dialog" role="dialog" aria-modal="true" aria-label="删除技能确认" onMouseDown={e => e.stopPropagation()}>
        <header><h3>删除「{props.target.name}」？</h3></header>
        <div className="skill-delete-body">
          <p className="skill-delete-lead">删除后：</p>
          <ul>
            {notice.scopeLines.map(line => <li key={line}>{line}</li>)}
          </ul>
          {notice.submissionLine && <p className="skill-delete-submission" role="alert">{notice.submissionLine}</p>}
        </div>
        <footer className="skill-delete-actions">
          <button type="button" className="app-btn app-btn-secondary" disabled={props.busy} onClick={props.onCancel}>取消</button>
          <button type="button" className="app-btn app-btn-danger" disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? '删除中…' : '删除技能'}
          </button>
        </footer>
      </section>
    </div>
  );
}
