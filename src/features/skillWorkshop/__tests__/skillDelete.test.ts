/**
 * V6.1 我的技能删除（领域 + wiring）测试：
 *  - 文案边界（describeSkillDeleteNotice）：local / submitted / published / 有投稿记录；
 *  - 删除语义：只删本地 user_skills 行，不撤回投稿、不动源图与历史项目（Rust 行为测试见 user_skills.rs）；
 *  - UI 链路：更多菜单 → 二次确认 → 确认删除 → 列表过滤 + 当前编辑态清理 + Toast。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSkillDeleteNotice } from '../userSkill';

const pageSrc = readFileSync(resolve(__dirname, '../../../pages/SkillWorkshop.tsx'), 'utf8');
const dialogSrc = readFileSync(resolve(__dirname, '../SkillDeleteDialog.tsx'), 'utf8');
const rustSrc = readFileSync(resolve(__dirname, '../../../../src-tauri/src/user_skills.rs'), 'utf8');

describe('describeSkillDeleteNotice（删除文案纯函数）', () => {
  it('local Skill：无投稿提示，只说明本地范围', () => {
    const notice = describeSkillDeleteNotice({ status: 'local' });
    expect(notice.submissionLine).toBeNull();
    expect(notice.scopeLines.some(line => line.includes('本机保存的 Skill 将移除'))).toBe(true);
    expect(notice.scopeLines.some(line => line.includes('历史项目'))).toBe(true);
  });

  it('submitted / under_review / published：均给出「不撤回审核记录」提示', () => {
    for (const status of ['submitted', 'under_review', 'changes_requested', 'published']) {
      const notice = describeSkillDeleteNotice({ status });
      expect(notice.submissionLine).toContain('已提交审核');
      expect(notice.submissionLine).toContain('不会撤回已提交的审核记录');
    }
  });

  it('status=local 但存在投稿记录（hasSubmissionRecord）：仍按已投稿提示', () => {
    const notice = describeSkillDeleteNotice({ status: 'local', hasSubmissionRecord: true });
    expect(notice.submissionLine).not.toBeNull();
  });
});

describe('Skill Delete（UI 链路 wiring）', () => {
  it('mySkillShowsDeleteAction：卡片操作区有更多菜单，「删除技能」在菜单内', () => {
    expect(pageSrc).toContain('my-skill-menu');
    expect(pageSrc).toContain('删除技能');
    expect(pageSrc).toMatch(/aria-expanded=\{skillMenuId === (?:skill|item)\.id\}/);
    expect(pageSrc).toContain('my-skill-menu-catcher');
  });

  it('deleteRequiresConfirmation：必须经 SkillDeleteDialog 二次确认才调用删除', () => {
    // 删除 API 只出现在 confirmDeleteSkill 内，菜单项只 setDeleteTarget（先确认）
    expect(pageSrc).toContain('SkillDeleteDialog');
    expect(pageSrc).toContain('deleteTarget');
    const menuIdx = pageSrc.indexOf('删除技能');
    const confirmIdx = pageSrc.indexOf('confirmDeleteSkill');
    const callIdx = pageSrc.indexOf('api.deleteUserSkill');
    expect(menuIdx).toBeGreaterThan(-1);
    // api.deleteUserSkill 不在「删除技能」菜单 onClick 一行内触发
    expect(pageSrc.slice(menuIdx, menuIdx + 400)).not.toContain('deleteUserSkill');
    // confirmDeleteSkill 是唯一调用点
    expect(pageSrc.slice(confirmIdx)).toContain('api.deleteUserSkill');
    expect(pageSrc.split('api.deleteUserSkill').length - 1).toBe(1);
    // 对话框有 danger 确认 + 取消
    expect(dialogSrc).toContain('删除技能');
    expect(dialogSrc).toContain('取消');
    expect(dialogSrc).toMatch(/is-danger|app-btn-danger/);
  });

  it('cancelDeleteKeepsSkill：取消/遮罩不触发删除，busy 期间禁点', () => {
    expect(pageSrc).toContain('onCancel={() => { if (!deleting) setDeleteTarget(null); }}');
    expect(dialogSrc).toContain('props.onCancel');
    expect(dialogSrc).toMatch(/disabled=\{props\.busy\}/);
    // 遮罩点击 = 取消；确认按钮独立（取消不触发删除链路）
    expect(dialogSrc).toMatch(/if \(e\.target === e\.currentTarget && !props\.busy\) props\.onCancel\(\)/);
    expect(dialogSrc.match(/onClick=\{props\.onConfirm\}/g)?.length).toBe(1);
  });

  it('confirmDeleteRemovesSkill：确认后调 deleteUserSkill、过滤列表并 Toast', () => {
    expect(pageSrc).toContain('await api.deleteUserSkill(deleteTarget.id)');
    expect(pageSrc).toMatch(/setMySkills\(prev => prev\.filter\(skill => skill\.id !== deleteTarget\.id\)\)/);
    expect(pageSrc).toContain('已删除「');
    expect(pageSrc).toMatch(/toastSuccess\(`已删除「\$\{deleteTarget\.name\}」`\)/);
    // 成功后清理菜单与确认目标
    expect(pageSrc).toMatch(/setDeleteTarget\(null\)/);
    expect(pageSrc).toMatch(/setSkillMenuId\(''\)/);
  });

  it('deleteCurrentSkillClearsSelectionSafely：删除当前打开的 Skill 时关闭使用弹窗', () => {
    expect(pageSrc).toContain("if (useDialogDraft?.id === deleteTarget.id) setUseDialogDraft(null)");
  });

  it('deleteSubmittedSkillDoesNotDeleteSubmissionRecord：无任何撤稿/删投稿 API 调用', () => {
    // 确认链路只有 deleteUserSkill；不存在撤回投稿类调用
    const forbidden = ['withdrawSkillSubmission', 'revokeSkillSubmission', 'deleteSkillSubmission', 'cancelSkillSubmission'];
    for (const name of forbidden) expect(pageSrc).not.toContain(name);
    // Rust 侧：只 DELETE user_skills，不触 skill_submissions
    expect(rustSrc).toMatch(/DELETE FROM user_skills WHERE id = \?1/);
    expect(rustSrc).not.toMatch(/DELETE FROM skill_submissions/);
  });

  it('deleteDoesNotRemoveSourceImages：确认链路不删除图库图片/视觉项目', () => {
    // 前端：confirmDeleteSkill 内无图片删除调用
    const confirmIdx = pageSrc.indexOf('confirmDeleteSkill');
    const nextFnIdx = pageSrc.indexOf('\n  function', confirmIdx + 10) === -1
      ? pageSrc.length
      : pageSrc.indexOf('\n  function', confirmIdx + 10);
    const body = pageSrc.slice(confirmIdx, nextFnIdx);
    for (const name of ['deleteImage', 'removeImage', 'deleteAsset', 'deleteVisualProject', 'deleteProject']) {
      expect(body).not.toContain(name);
    }
    // Rust 行为测试锁定：visual_projects 表在删除后仍存在
    expect(rustSrc).toContain('视觉项目（历史项目）绝不随 Skill 删除');
  });

  it('deletePersistsAfterReload：走 Rust 持久化命令（DB 行删除，非 UI 隐藏）', () => {
    expect(pageSrc).toContain('deleteUserSkill');
    expect(rustSrc).toMatch(/#\[tauri::command\]\s*\n?pub fn delete_user_skill/);
    expect(rustSrc).toContain('delete_missing_id_is_idempotent_no_error');
    expect(rustSrc).toContain('delete_removes_only_target_skill_row');
  });

  it('mySkillsEmpty：空态提供「去视觉理解保存」入口', () => {
    expect(pageSrc).toContain('my-skills-empty');
    expect(pageSrc).toContain('去视觉理解保存');
    expect(pageSrc).toContain("page: 'vision'");
  });
});
