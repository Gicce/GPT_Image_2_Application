import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BUBBLE_SURFACE_COLORS } from '../../features/comic/bubbleShape';

/**
 * AI 漫画 UI Conformance 守卫（V4.2.7 UI System 收口，docs/ai-comic/13 §6 / 14）。
 *
 * 锁定的规范：
 * - Raw action button = 0：漫画 UI 面上每个 <button> 必须是以下二者之一——
 *   a) `app-btn` 基类 + 恰一个真实 variant（primary/secondary/danger，可加 app-btn-sm）；
 *   b) 白名单自定义交互控件（选择卡 / 步骤栏 / 分段 tab / 弹窗关闭，§54 允许的漫画 layout）；
 * - variant 缺基类 = 0、app-btn-ghost = 0（App.css 从未定义 ghost；弱操作一律 secondary）；
 * - 破坏性动作（删除*）必须 danger variant；
 * - 每个操作行（comic-actions-row）同时可见的 primary ≤ 1（条件互斥的 CTA 不计）；
 * - 漫画 CSS 不给 .app-btn 上皮肤（颜色/边框/字体禁止，布局属性允许），
 *   不自建 tab/chip 皮肤（一律 app-segmented）；
 * - 键盘焦点：App.css 有 .app-btn:focus-visible；白名单控件在 ComicStudio.css 有同规范焦点。
 */

const read = (path: string): string =>
  readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const componentsDir = resolve(__dirname, '../../features/comic/components');
const componentFiles = readdirSync(componentsDir).filter(name => name.endsWith('.tsx'));

/** 漫画 UI 面 = 页面 + 全部组件源码（文件名 → 源码）。 */
const uiSources: Record<string, string> = {
  'ComicStudio.tsx': read('../ComicStudio.tsx'),
  ...Object.fromEntries(componentFiles.map(name => [name, read(`../../features/comic/components/${name}`)])),
};

/** §54 白名单：漫画自有 layout 的自定义交互控件（选择卡 / 步骤栏 / tab / 关闭）。 */
const CUSTOM_INTERACTIVE_ALLOWLIST = new Set([
  'comic-step', // 步骤栏（Stepper，状态语义自成体系）
  'comic-project-open', // 项目库整卡选择器
  'comic-presentation-card', // 漫画形式选择卡
  'comic-form-selector-card', // V4.2.8 新建弹窗「漫画形式」约束小卡（radiogroup 成员）
  'comic-mode-card', // 对白方式 / 视觉风格选择卡
  'comic-style-card', // 视觉风格卡（comic-mode-card 的变体 token）
  'comic-concept-card', // 新建弹窗概念方案选择卡
  'comic-concept-mini', // V4.2.8 推荐方案 Mini Concept Card（tablist 成员）
  'comic-text-thumb', // 文字精修分镜缩略选择卡
  'comic-bubble-picker-card', // V4.2.12 气泡样式视觉选择卡（radiogroup 成员，含 :focus-visible）
  'comic-dialogue-chip', // V4.2.12 本格对白列表 chip（tablist 成员，含 :focus-visible）
  'comic-ref-view', // V4.2.10 角色参考图点击放大（进全局 ImageViewer，含 :focus-visible）
  'comic-dialog-close', // 弹窗家族关闭控件（ComicDialog.css）
  'app-segmented-btn', // 项目标准分段 tab（App.css 共享组件）
]);

const VARIANTS = ['app-btn-primary', 'app-btn-secondary', 'app-btn-danger'];

interface ExtractedButton {
  file: string;
  /** 静态类名（模板串截到 ${ 前）。 */
  classes: string[];
  /** 纯文本按钮的文案（含子元素 / 插值的按钮为空或残段，只用于纯文本断言）。 */
  text: string;
  raw: boolean;
}

/**
 * 提取源码中每个 <button>…</button> 字面量。
 * 注意：不能用 /<button[^>]*>/ —— 属性里的箭头函数（onClick={() => …}）含 ">"，
 * 会把开标签截断。这里惰性匹配到最近 </button>，className 取片段内首个（必属开标签）。
 */
function extractButtons(source: string, file: string): ExtractedButton[] {
  const buttons: ExtractedButton[] = [];
  for (const match of source.matchAll(/<button\b([\s\S]*?)<\/button>/g)) {
    const chunk = match[1]!;
    const classNameMatch = chunk.match(/className=\{?["'`]([^"'`]+)/);
    const classes = classNameMatch
      ? classNameMatch[1]!.replace(/\$\{[\s\S]*$/, '').trim().split(/\s+/).filter(Boolean)
      : [];
    // 纯文本按钮：最后一个 ">" 就是开标签收口；含子元素的按钮取到残段（不参与文案断言）
    const inner = chunk.slice(chunk.lastIndexOf('>') + 1);
    const text = inner.replace(/\{[\s\S]*?\}/g, '').replace(/<[^>]*>/g, '').trim();
    buttons.push({ file, classes, text, raw: !classNameMatch });
  }
  return buttons;
}

const allButtons: ExtractedButton[] = Object.entries(uiSources)
  .flatMap(([file, source]) => extractButtons(source, file));

/** 条件渲染段（{cond && ( … )} / {cond ? ( … ) : ( … )}）的区间集合：段落级互斥 CTA 判定用。 */
function conditionalSpans(block: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const marker of block.matchAll(/&&\s*\(|\?\s*\(/g)) {
    const open = block.indexOf('(', marker.index!);
    let depth = 1;
    let index = open + 1;
    while (index < block.length && depth > 0) {
      if (block[index] === '(') depth += 1;
      else if (block[index] === ')') depth -= 1;
      index += 1;
    }
    spans.push([open, index]);
  }
  return spans;
}

describe('全局按钮规范（raw button 清零 / 基类 + 恰一 variant / ghost 清零）', () => {
  test('漫画 UI 面存在足量按钮（守卫自身有效）', () => {
    expect(allButtons.length).toBeGreaterThan(30);
  });

  test('raw button = 0（每个按钮要么 app-btn 族要么白名单自定义控件）', () => {
    const offenders: string[] = [];
    for (const button of allButtons) {
      if (button.raw) {
        offenders.push(`${button.file}: 无 className 的 <button>「${button.text}」`);
        continue;
      }
      const classes = button.classes;
      if (classes[0] === 'app-btn') {
        const variants = classes.filter(token => VARIANTS.includes(token));
        if (variants.length !== 1) {
          offenders.push(`${button.file}: 「${button.text}」classes=${classes.join(' ')}（variant 数 ${variants.length}）`);
        }
        continue;
      }
      const nonAllowed = classes.filter(token => !CUSTOM_INTERACTIVE_ALLOWLIST.has(token));
      if (nonAllowed.length > 0) {
        offenders.push(`${button.file}: 「${button.text}」非白名单类 ${nonAllowed.join(' ')}`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  test('variant 缺 app-btn 基类 = 0', () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(uiSources)) {
      for (const match of source.matchAll(/className=\{?["'`]([^"'`]+)/g)) {
        const classes = match[1]!.replace(/\$\{[\s\S]*$/, '').trim().split(/\s+/).filter(Boolean);
        if (classes.some(token => VARIANTS.includes(token)) && classes[0] !== 'app-btn') {
          offenders.push(`${file}: ${match[1]}`);
        }
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  test('app-btn-ghost = 0（App.css 从未定义；弱操作一律 secondary）', () => {
    for (const [file, source] of Object.entries(uiSources)) {
      expect(source.includes('app-btn-ghost'), file).toBe(false);
    }
  });
});

describe('语义 variant 映射（破坏性动作 danger / 操作行单 primary）', () => {
  test('删除类动作必须 danger variant', () => {
    const deleteButtons = allButtons.filter(button => button.text.startsWith('删除'));
    const offenders = deleteButtons
      .filter(button => !button.classes.includes('app-btn-danger'))
      .map(button => `${button.file}: 「${button.text}」`);
    expect(offenders.join('\n')).toBe('');
    // 三处删除入口都被守卫覆盖（项目卡 / 对白 / 删除确认弹窗）
    expect(deleteButtons.length).toBeGreaterThanOrEqual(3);
  });

  test('关键推进 CTA = primary（故事确认 / 分镜应用 / 系列生成 / 项目创建）', () => {
    // 文案存在性（含模板字面量里的条件文案）
    expect(uiSources['ComicGenerateStage.tsx']).toContain('生成漫画画面');
    expect(uiSources['ComicNewProjectDialog.tsx']).toContain('创建项目');
    // 静态文案按钮直接核验 variant
    for (const [file, text] of [
      ['ComicStoryStage.tsx', '确认这个故事'],
      ['ComicStoryboardStage.tsx', '应用分镜，去生成漫画画面'],
    ] as const) {
      const button = allButtons.find(item => item.file === file && item.text === text);
      expect(button, `${file} 「${text}」`).toBeDefined();
      expect(button!.classes).toContain('app-btn-primary');
    }
  });

  test('每个 comic-actions-row 同时可见的 primary ≤ 1（互斥条件 CTA 不计）', () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(uiSources)) {
      let cursor = 0;
      while (true) {
        const start = source.indexOf('comic-actions-row', cursor);
        if (start < 0) break;
        const divStart = source.lastIndexOf('<div', start);
        // 括号平衡扫描找配对 </div>（操作行内可能有嵌套元素）
        let depth = 0;
        let index = divStart;
        let end = -1;
        while (index < source.length) {
          const open = source.indexOf('<div', index);
          const close = source.indexOf('</div>', index);
          if (close < 0) break;
          if (open >= 0 && open < close) {
            depth += 1;
            index = open + 4;
          } else {
            depth -= 1;
            index = close + 6;
            if (depth === 0) {
              end = index;
              break;
            }
          }
        }
        const block = end > 0 ? source.slice(divStart, end) : '';
        if (block) {
          // 直接渲染的 primary（不在任何 {cond && (…)} / {cond ? (…) : (…)} 段内）必须 ≤ 1；
          // 条件互斥的 CTA（如 生成第一张 vs 确认这个效果）渲染路径上只有其一。
          const spans = conditionalSpans(block);
          const directPrimaries = [...block.matchAll(/app-btn-primary/g)].filter(
            match => !spans.some(([from, to]) => match.index! >= from && match.index! < to),
          ).length;
          if (directPrimaries > 1) {
            offenders.push(`${file}: 操作行含 ${directPrimaries} 个直接渲染 primary`);
          }
        }
        cursor = (end > 0 ? end : start) + 1;
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});

describe('CSS 规范（无按钮皮肤 / 无自建 tab-chip / 键盘焦点）', () => {
  const studioCss = read('../ComicStudio.css');
  const dialogCss = read('../../features/comic/components/ComicDialog.css');
  const appCss = read('../../App.css');

  test('漫画 CSS 不给 .app-btn 上皮肤（布局属性允许，颜色/边框/字体禁止）', () => {
    for (const css of [studioCss, dialogCss]) {
      const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const block of noComments.split('}')) {
        if (!/app-btn/.test(block) || !block.includes('{')) continue;
        const decls = block.slice(block.indexOf('{'));
        for (const skin of ['background', 'color', 'border', 'box-shadow', 'font', 'padding', 'border-radius']) {
          expect(decls.includes(`${skin}:`), `${block.trim()} → ${skin}`).toBe(false);
        }
      }
    }
  });

  test('自建 tab / chip 皮肤 = 0（tab 一律 app-segmented；指针注释除外）', () => {
    for (const css of [studioCss, dialogCss]) {
      const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(noComments.includes('.comic-tab'), 'comic-tab 规则残留').toBe(false);
      expect(noComments.includes('.comic-chip'), 'comic-chip 规则残留').toBe(false);
    }
  });

  test('键盘焦点：App.css 有 .app-btn:focus-visible；白名单控件同规范焦点在 ComicStudio.css', () => {
    expect(appCss).toMatch(/\.app-btn:focus-visible/);
    expect(studioCss).toMatch(/\.comic-step:focus-visible/);
    expect(studioCss).toMatch(/\.comic-project-open:focus-visible/);
    expect(studioCss).toMatch(/\.comic-presentation-card:focus-visible/);
    expect(studioCss).toMatch(/\.comic-form-selector-card:focus-visible/);
    expect(studioCss).toMatch(/\.comic-concept-card:focus-visible/);
    expect(studioCss).toMatch(/\.comic-concept-mini:focus-visible/);
    expect(studioCss).toMatch(/\.comic-text-thumb:focus-visible/);
    expect(studioCss).toMatch(/\.comic-ref-view:focus-visible/); // V4.2.10 参考图点击放大
    expect(studioCss).toMatch(/\.comic-bubble-picker-card:focus-visible/); // V4.2.12 气泡样式卡
    expect(studioCss).toMatch(/\.comic-dialogue-chip:focus-visible/); // V4.2.12 对白列表 chip
    expect(dialogCss).toMatch(/\.comic-dialog-close:focus-visible/);
  });

  test('气泡底色防漂移：ComicStudio.css 的 bubble/narration 底色与 bubbleShape 共享常量同值', () => {
    // V4.2.13 残留修复守卫：导出 canvas 已改读 BUBBLE_SURFACE_COLORS；CSS 若与常量
    // 漂移即 WYSIWYG 破损（编辑器底色 ≠ 导出底色）。CSS 书写带空格 → 两侧去空白比对。
    const compact = studioCss.replace(/\s+/g, '');
    expect(compact).toContain(`fill:${BUBBLE_SURFACE_COLORS.bubble.fill}`.replace(/\s+/g, ''));
    expect(compact).toContain(`stroke:${BUBBLE_SURFACE_COLORS.bubble.stroke}`.replace(/\s+/g, ''));
    expect(compact).toContain(`fill:${BUBBLE_SURFACE_COLORS.narration.fill}`.replace(/\s+/g, ''));
    expect(compact).toContain(`stroke:${BUBBLE_SURFACE_COLORS.narration.stroke}`.replace(/\s+/g, ''));
  });

  test('App.css 共享原语齐全（基类组 + 三 variant + sm + segmented）', () => {
    // 基类是组选择器首行（.app-btn, … 共享 padding/圆角/hover/disabled）
    for (const rule of [
      '.app-btn,',
      '.app-btn-primary {',
      '.app-btn-secondary {',
      '.app-btn-danger {',
      '.app-btn-sm {',
      '.app-segmented {',
      '.app-segmented-btn {',
    ]) {
      expect(appCss.includes(rule), rule).toBe(true);
    }
  });
});
