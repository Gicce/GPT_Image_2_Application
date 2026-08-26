/**
 * Project List State Transition Pattern 守卫（§24-§28 / §53）：
 * 历史缺陷锚点——确认删除后标题「单字符纵向排列」：
 *   确认态在原 4 按钮旁**追加**确认/取消（共 6 按钮）+ 操作区 flex:0 0 auto 拒绝收缩
 *   ⇒ 内容列被挤到 ~26px，meta 行逐字换行呈竖排。
 * 修复 = 三区固定网格 + 确认态整体替换操作区 + 列表级单值确认态。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const library = readFileSync(
  resolve(__dirname, '../../features/vision/project/VisualProjectLibrary.tsx'),
  'utf-8',
);
const css = readFileSync(resolve(__dirname, '../VisionUnderstanding.css'), 'utf-8');

describe('§25 Project Card 固定三区', () => {
  test('projectDeleteConfirmDoesNotCollapseTitle：三区网格 + 内容列 minmax(0,1fr)', () => {
    expect(css).toContain('grid-template-columns: auto minmax(0, 1fr) auto');
    expect(css).toMatch(/\.vision-project-card-main \{[\s\S]*?min-width: 0;/);
    expect(css).toMatch(/\.vision-project-card-name \{[\s\S]*?white-space: nowrap;/);
    expect(css).toMatch(/\.vision-project-card-meta \{[\s\S]*?text-overflow: ellipsis;/);
  });

  test('操作区可换行收缩但绝不挤压内容列（max-width 上限 + 禁止 flex:0 0 auto 回归）', () => {
    expect(css).toMatch(/\.vision-project-card-actions \{[\s\S]*?flex-wrap: wrap;/);
    expect(css).toMatch(/\.vision-project-card-actions \{[\s\S]*?max-width: 60%;/);
    expect(css).not.toMatch(/\.vision-project-card-actions \{[\s\S]*?flex: 0 0 auto;/);
  });
});

describe('§26/§27 删除态 = 替换式操作区 + 状态机', () => {
  test('确认态整体替换操作区（确认删除 / 取消），普通按钮组不与确认组并存', () => {
    expect(library).toContain('confirmingDelete ? (');
    expect(library).toContain('data-testid="confirm-delete-project"');
    expect(library).toContain('data-testid="cancel-delete-project"');
    // 三元分支结构：确认组与普通组互斥（绝不追加）
    const confirmBlock = library.slice(
      library.indexOf('{confirmingDelete ? ('),
      library.indexOf('{confirmingDelete ? (') + 1600,
    );
    expect(confirmBlock).toContain('确认删除');
    expect(confirmBlock).toContain('取消');
    const normalBlockStart = confirmBlock.indexOf(') : (');
    expect(normalBlockStart).toBeGreaterThan(0);
    expect(confirmBlock.slice(0, normalBlockStart)).not.toContain('>打开<');
  });

  test('onlyOneProjectCanEnterDeleteConfirm：唯一事实源 = 列表级单值 pendingDeleteProjectId', () => {
    expect(library).toContain('pendingDeleteProjectId, setPendingDeleteProjectId');
    expect(library).not.toMatch(/useState.*isDeleting/);
    expect(library).toMatch(/const confirmingDelete = pendingDeleteProjectId === item\.id;/);
  });

  test('cancelDeleteRestoresRow：取消 / Escape 回落 null（恢复原按钮组）', () => {
    expect(library).toMatch(/if \(event\.key === 'Escape'\) \{[\s\S]*?if \(pendingDeleteProjectId\) setPendingDeleteProjectId\(null\);/);
    expect(library).toMatch(/onClick=\{\(\) => setPendingDeleteProjectId\(null\)\}/);
    expect(library).toMatch(/setPendingDeleteProjectId\(null\); onDeleteProject\(item\.id\);/);
  });

  test('deleteCurrentProjectLeavesSafeEmptyState：空列表渲染「暂无视觉项目」+ 新建入口', () => {
    expect(library).toContain("projects.length === 0 ? '暂无视觉项目'");
    expect(library).toContain('新建项目');
  });
});
