/**
 * V6.1 ImageLibraryPicker Portal 守卫（源码文本断言）：
 * 根因 = 旧实现 render 在父 modal DOM 内，依赖懒加载 chunk 的 .template-modal*
 * 样式；chunk 缺失时无样式 div 在父 place-items:center 容器里塌成内容宽。
 * 铁律：独立 Portal + 自包含样式 + 独立层级，Escape 只关本层。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const tsx = readFileSync(resolve(__dirname, '../ImageLibraryPicker.tsx'), 'utf-8');
const css = readFileSync(resolve(__dirname, '../ImageLibraryPicker.css'), 'utf-8');
const creatorSrc = readFileSync(resolve(__dirname, '../../features/skillWorkshop/SkillCreatorDialog.tsx'), 'utf-8');
const useDialogSrc = readFileSync(resolve(__dirname, '../../features/skillWorkshop/TemplateSkillUseDialog.tsx'), 'utf-8');

describe('ImageLibraryPicker（V6.1 Portal 独立弹窗）', () => {
  test('imageLibraryPickerUsesPortal：createPortal 到 document.body，脱离父 modal DOM', () => {
    expect(tsx).toContain('createPortal');
    expect(tsx.match(/document\.body/g)?.length).toBeGreaterThanOrEqual(1);
    // 返回值以 createPortal(...) 包裹（不是普通 JSX 返回）
    expect(tsx).toMatch(/return createPortal\(/);
  });

  test('pickerDoesNotInheritParentColumnWidth：自包含 image-picker-* 样式，不依赖父弹窗类', () => {
    // 无 template-modal 类名使用（注释里的历史说明不算）
    expect(tsx).not.toMatch(/className="[^"]*template-modal/);
    expect(tsx).toContain("import './ImageLibraryPicker.css'");
    // 弹窗宽度是视口函数，不是父容器函数
    expect(css).toMatch(/\.image-picker-modal\s*{[^}]*width:\s*min\(960px,\s*calc\(100vw - 48px\)\)/s);
    expect(css).toMatch(/\.image-picker-modal\s*{[^}]*height:\s*min\(720px,\s*calc\(100vh - 48px\)\)/s);
    expect(css).toMatch(/\.image-picker-modal\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/s);
  });

  test('pickerHasIndependentBackdrop：独立 fixed backdrop + z-index 1300 独立 stacking', () => {
    expect(css).toMatch(/\.image-picker-overlay\s*{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.image-picker-overlay\s*{[^}]*z-index:\s*1300/s);
    expect(css).toMatch(/\.image-picker-overlay\s*{[^}]*background:/s);
    // backdrop 点击关闭（target 检查，正文点击冒泡不误关）
    expect(tsx).toMatch(/onMouseDown=\{e => \{ if \(e\.target === e\.currentTarget\) props\.onClose\(\); \}\}/);
    // 位于 Skill 弹窗（1200）之上
    expect(css).toContain('1200');
  });

  test('escapeClosesPickerBeforeCreator：Escape 只关本层，底层弹窗 galleryOpenRef 守卫', () => {
    expect(tsx).toMatch(/if \(e\.key === 'Escape'\) props\.onClose\(\)/);
    expect(creatorSrc).toMatch(/e\.key === 'Escape' && !galleryOpenRef\.current/);
    expect(useDialogSrc).toMatch(/e\.key === 'Escape' && !galleryOpenRef\.current/);
    // Picker 打开期间底层正文滚动锁定
    expect(creatorSrc).toContain("galleryOpen ? ' is-picker-open'");
    expect(css).not.toContain('is-picker-open'); // 滚动锁在 Creator CSS，不在 Picker
  });

  test('gridUsesResponsiveAutoFill：auto-fill minmax(140px,1fr) 响应网格 + 统一缩略图比例', () => {
    expect(css).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(140px,\s*1fr\)\)/);
    expect(css).not.toMatch(/grid-template-columns:\s*repeat\(2,/);
    expect(css).toMatch(/\.image-picker-thumb\s*{[^}]*aspect-ratio:\s*1/s);
    expect(css).toMatch(/\.image-picker-name\s*{[^}]*text-overflow:\s*ellipsis/s);
    // 双击预览走全局 ImageViewer，不做第二套 viewer
    expect(tsx).toContain('useImageViewerStore.getState().openViewer');
    expect(tsx).toMatch(/onDoubleClick=\{\(\) => previewImage\(image\)\}/);
  });

  test('pickerSelectionPersistsDuringDraft：选择是无状态回调（onPick 交父级持久 draft）', () => {
    // 组件不持有选择状态：唯一 useState 是缩略图缓存，选择由父级 draft 保存
    const componentStates = tsx.match(/useState[^(]*\(([^)]*)\)/g) ?? [];
    expect(componentStates.join('|')).not.toMatch(/selected|picked/);
    expect(tsx).toMatch(/onPick: \(image: ImageRecord\) => void/);
    expect(tsx).toMatch(/onClick=\{\(\) => props\.onPick\(image\)\}/);
    // 父级使用方把 pick 结果写入自身 state（关闭弹窗不丢）
    expect(creatorSrc).toMatch(/setSample\(|setDraft\(/);
    expect(useDialogSrc).toMatch(/set[A-Z]\w*\(/);
  });
});
