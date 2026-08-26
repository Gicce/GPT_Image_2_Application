/**
 * 本轮验收 UI 布线守卫（任务 A/B/C/D）：
 *  - 删除项目：统一 handleDeleteProject（Library + HeaderBar 双入口）、
 *    应用内确认弹窗（禁 window.confirm）、删当前项目原子清理、失败 Toast；
 *  - 右栏：方案规则默认折叠 + 复制规则摘要；技能清单 checklist 点击打开抽屉；
 *  - Skill Trace：Drawer / History「复制全部执行过程」按钮 + Markdown 构建器；
 *  - 点数不足：QuoteConfirmDialog 去充值 CTA → cyimage-navigate(account/recharge)
 *    → App 写 cy_account_section → Account 锚点聚焦充值区。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const page = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const rail = readFileSync(resolve(__dirname, '../../features/vision/project/ContextRail.tsx'), 'utf-8');
const drawer = readFileSync(resolve(__dirname, '../../features/vision/skills/SkillTraceDrawer.tsx'), 'utf-8');
const quote = readFileSync(resolve(__dirname, '../../components/QuoteConfirmDialog.tsx'), 'utf-8');
const account = readFileSync(resolve(__dirname, '../Account.tsx'), 'utf-8');
const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf-8');
const history = readFileSync(resolve(__dirname, '../History.tsx'), 'utf-8');
const store = readFileSync(resolve(__dirname, '../../store/useVisualProjectStore.ts'), 'utf-8');

describe('任务A：删除项目链路', () => {
  test('统一删除入口：Library 与 ProjectHeaderBar 都接 handleDeleteProject', () => {
    expect(page).toContain('const handleDeleteProject');
    expect(page).toMatch(/onDeleteProject=\{handleDeleteProject\}/);
    expect(page).toMatch(/setPickerDeleting\(\{ id, name/);
  });

  test('禁用原生 confirm：删除确认走应用内 vision-modal', () => {
    expect(page).not.toContain('window.confirm');
    expect(page).toMatch(/\{pickerDeleting && \(/);
    expect(page).toContain('确认删除');
    expect(page).toContain('此操作不可撤销');
  });

  test('删除当前项目原子清理：关 Library / 关技能抽屉 / 重置工作区 + 成功 Toast', () => {
    expect(page).toMatch(/if \(wasActive\) \{[\s\S]*?setLibraryOpen\(false\);[\s\S]*?setSkillTraceMode\(null\);[\s\S]*?restartWorkspace\(\);[\s\S]*?\}/);
    expect(page).toContain("toastSuccess('项目已删除')");
    expect(page).toMatch(/toastError\(failure, '项目删除失败'\)/);
  });

  test('store 墓碑防复活：deleteProject 立墓碑 + persistProject 双重拦截', () => {
    expect(store).toContain('deletedProjectIds.add(id)');
    expect(store).toMatch(/if \(deletedProjectIds\.has\(project\.id\)\) return;/);
    expect(store).toContain('deletedProjectIds.delete(id)');
  });
});

describe('任务B：右栏可读性', () => {
  test('方案规则默认折叠：展开/收起 + 复制规则摘要', () => {
    expect(rail).toContain('rulesExpanded');
    expect(rail).toContain('展开 ▾');
    expect(rail).toContain('收起 ▴');
    expect(rail).toContain('复制规则摘要');
    expect(rail).toContain("toastSuccess('已复制规则摘要')");
  });

  test('技能清单 checklist：技能行可点击打开执行过程抽屉', () => {
    expect(rail).toContain('vision-rail-skill-item');
    expect(rail).toMatch(/className="vision-rail-skill-item"[\s\S]*?onClick=\{onOpenSkillTrace\}/);
  });

  test('@图片友好名：图库选择 label 优先 description（生成图哈希名不再直出）', () => {
    expect(page).toContain("img.description?.trim() || img.file_name");
  });
});

describe('任务C：复制全部执行过程（Markdown）', () => {
  test('Drawer 顶部操作区有复制按钮 + 成功 Toast 文案', () => {
    expect(drawer).toContain('复制全部执行过程');
    expect(drawer).toContain('已复制技能执行过程（Markdown）');
    expect(drawer).toContain('buildSkillTraceMarkdown');
  });

  test('History 执行详情也有复制入口（同一导出器）', () => {
    expect(history).toContain('buildSkillTraceMarkdown');
    expect(history).toContain('复制全部执行过程');
  });
});

describe('任务D：点数不足充值入口', () => {
  test('QuoteConfirmDialog：点数不足显示去充值 CTA + 禁用按钮有说明', () => {
    expect(quote).toContain('去充值');
    expect(quote).toContain('点数不足，需先充值后再生成');
    expect(quote).toMatch(/disabled=\{insufficient\}/);
    expect(quote).toContain("detail: { page: 'account', section: 'recharge' }");
  });

  test('App 导航分发 account section → cy_account_section 事件', () => {
    expect(app).toContain("detail.page === 'account' && detail.section");
    expect(app).toContain('cy_account_section');
    expect(app).toContain('cy-account-section');
  });

  test('Account：充值区锚点 + 滚动聚焦高亮', () => {
    expect(account).toContain('id="account-recharge"');
    expect(account).toContain('cy-account-section');
    expect(account).toContain('scrollIntoView');
    expect(account).toContain('is-focus-flash');
  });
});
