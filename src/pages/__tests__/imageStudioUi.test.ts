import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 图片生成页（Creator Workspace Golden Sample）UI 契约守卫。
 *
 * 锁定 V4.0.8 UI 精修形成的规范，防止后续开发回退：
 * - 业务 CSS 只用语义 Token（禁止新增随机 hex / rgb）
 * - 三种生成模式共用 GenerationSettings / TaskSidebar / Primary CTA
 * - Workspace 网格：MainCreator 可压缩 + Sidebar 固定宽，页面限宽不产生横向滚动
 * - Dark / Light 双主题 Surface Token（--bg-section / --card-shadow）成对存在
 * - Segmented 选中态不得退化为实底强紫（紫色只留给 Primary CTA）
 */

const pageDir = resolve(__dirname, '..');
const css = readFileSync(resolve(pageDir, 'ImageStudio.css'), 'utf-8');
const tsx = readFileSync(resolve(pageDir, 'ImageStudio.tsx'), 'utf-8');
const appCss = readFileSync(resolve(pageDir, '../App.css'), 'utf-8');

function rule(source: string, selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`);
  const m = source.match(re);
  return m ? m[1] : '';
}

describe('图片生成页 UI 契约（Golden Sample）', () => {
  test('业务 CSS 不新增随机 hex / rgb 颜色（只允许语义 Token）', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  test('TSX 不再引用步骤编号与人造 Wizard（bp-stage-no 已移除）', () => {
    expect(tsx).not.toContain('bp-stage-no');
    expect(tsx).not.toContain('bp-stage-head');
  });

  test('三种生成模式共用 GenerationSettings（单张 / 批量各一处，无第二套实现）', () => {
    const uses = tsx.match(/<GenerationSettings/g) ?? [];
    expect(uses.length).toBe(2);
    // 旧的三列 form-row 内联实现不得回流
    expect(tsx).not.toMatch(/form-row form-row-wrap/);
  });

  test('单张与批量共用同一 Primary CTA（studio-cta-btn）且基于品牌 Token', () => {
    const ctaUses = tsx.match(/studio-cta-btn/g) ?? [];
    expect(ctaUses.length).toBeGreaterThanOrEqual(2);
    const cta = rule(css, '.studio-cta-btn');
    expect(cta).toContain('background: var(--accent-primary)');
    expect(cta).toContain('color: var(--text-on-accent)');
  });

  test('Primary CTA Disabled 保持可读（降透明度而非换灰底灰字）', () => {
    const disabled = rule(css, '.studio-cta-btn:disabled');
    expect(disabled).toContain('opacity');
    expect(disabled).not.toContain('background: var(--border-default)');
  });

  test('TaskSidebar 统一容器：任务摘要/生成摘要 + 最近任务同卡，单张批量同一 aside', () => {
    expect(tsx).toContain('className="studio-sidebar"');
    expect(tsx).toContain('<RecentTasksPanel tasks={tasks} />');
    expect(tsx).toContain('任务摘要');
    expect(tsx).toContain('生成摘要');
    // 最近任务不再是独立漂浮卡片（studio-recent 只是 side-section，不再自带卡片边框）
    const recent = rule(css, '.studio-side-section.studio-recent');
    expect(recent).not.toContain('border');
  });

  test('Workspace 网格：Main 可压缩 + Sidebar 固定宽度（不允许压缩到不可读）', () => {
    expect(css).toContain('--studio-sidebar-width: 320px');
    const grid = rule(css, '.studio-workspace');
    expect(grid).toContain('grid-template-columns: minmax(0, 1fr) var(--studio-sidebar-width)');
    const main = rule(css, '.studio-main');
    expect(main).toContain('min-width: 0');
  });

  test('页面限宽：大屏不无限扩张（≤1600px 且 >1200px），不产生横向滚动', () => {
    const page = rule(css, '.image-studio-page');
    const m = page.match(/max-width:\s*(\d+)px/);
    expect(m).not.toBeNull();
    const width = Number(m![1]);
    expect(width).toBeLessThanOrEqual(1600);
    expect(width).toBeGreaterThan(1200);
  });

  test('Dark / Light 双主题 Surface Token 成对存在（--bg-section / --card-shadow）', () => {
    for (const theme of ['light', 'dark']) {
      const block = appCss.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
      expect(block).not.toBeNull();
      expect(block![1]).toMatch(/--bg-section\s*:/);
      expect(block![1]).toMatch(/--card-shadow\s*:/);
    }
  });

  test('最近任务标题允许 ellipsis（长标题截断而非撑爆布局）', () => {
    const name = rule(css, '.studio-recent-name');
    expect(name).toContain('text-overflow: ellipsis');
    expect(name).toContain('white-space: nowrap');
  });

  test('Segmented 选中态不得使用实底强紫（品牌 Strong 只属于 Primary CTA）', () => {
    const active = rule(css, '.studio-seg-btn.active');
    expect(active).toContain('color: var(--accent-primary-text)');
    expect(active).not.toContain('background: var(--accent-primary)');
  });

  test('共享原语继续复用：settings-btn 系 / Toast（不重造按钮体系）', () => {
    expect(tsx).toMatch(/settings-btn settings-btn-secondary/);
    expect(tsx).toMatch(/from '\.\.\/components\/Toast'/);
    // Settings.css 显式导入（懒加载 chunk 依赖修复不得回退）
    expect(tsx).toContain("import './Settings.css'");
    expect(tsx).not.toContain("import './CreateTask.css'");
  });
});

describe('ReferenceImageInput 契约（Media Input Pattern）', () => {
  test('Empty 与 Loaded 互斥：载入后 Dropzone 消失，只渲染 Tile 网格 + Add Tile', () => {
    expect(tsx).toContain('function ReferenceImageInput');
    // Dropzone 只在 empty 分支渲染
    expect(tsx).toContain("props.images.length === 0 ?");
    // Loaded 分支 = tile 网格 + Add Tile（不恢复大 Dropzone）
    expect(tsx).toContain('className="studio-media-grid"');
    expect(tsx).toContain('className="studio-media-add"');
    expect(tsx).toContain('>添加图片</span>');
    // 旧的两个独立区域实现不得回流
    expect(tsx).not.toContain('SourceImagePicker');
    expect(tsx).not.toContain('studio-source-grid');
  });

  test('移除按钮 = secondary danger：默认 neutral 遮罩，Hover 才 danger，带 Tooltip', () => {
    expect(tsx).toContain('title="移除参考图片"');
    const remove = rule(css, '.studio-media-remove');
    expect(remove).toContain('background: var(--bg-overlay)');
    const hover = rule(css, '.studio-media-remove:hover');
    expect(hover).toContain('background: var(--accent-danger)');
  });

  test('文件名只是 metadata：不再常驻展示，仅 Tooltip；扩展名徽标代替', () => {
    expect(tsx).not.toContain('studio-source-name');
    expect(tsx).toContain('studio-media-ext');
    // Tooltip 承载完整文件名
    expect(tsx).toMatch(/title=\{`\$\{item\.name\}/);
  });

  test('Empty Dropzone 尺寸受控（120~140px）且整体可点击', () => {
    const dz = rule(css, '.studio-dropzone');
    const m = dz.match(/min-height:\s*(\d+)px/);
    expect(m).not.toBeNull();
    const h = Number(m![1]);
    expect(h).toBeGreaterThanOrEqual(120);
    expect(h).toBeLessThanOrEqual(140);
    expect(dz).toContain('cursor: pointer');
    expect(tsx).toContain('role="button"');
  });

  test('DragOver 反馈：Loaded 态网格描边 + Add Tile 品牌高亮', () => {
    const grid = rule(css, '.studio-media-input.drag-active .studio-media-grid');
    expect(grid).toContain('var(--accent-primary)');
    const add = rule(css, '.studio-media-input.drag-active .studio-media-add');
    expect(add).toContain('var(--accent-primary-text)');
  });

  test('AI 优化是提示词的辅助操作：字段头内嵌，四态可区分', () => {
    expect(tsx).toContain('studio-prompt-head');
    expect(tsx).toContain("'✨ AI 优化'");
    expect(tsx).toContain("optimizing ? 'AI 优化中…'");
    expect(tsx).toContain("hasResult ? '重新优化'");
    // completed 态用 Brand Soft 档区分（studio-btn-ai），未完成用 secondary
    expect(tsx).toMatch(/hasResult \? ' studio-btn-ai' : ' settings-btn-secondary'/);
    // 独立成行的旧优化操作行不得回流
    expect(css).not.toMatch(/\.studio-optimizer-row/);
  });
});
