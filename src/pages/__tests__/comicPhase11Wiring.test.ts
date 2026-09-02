import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * AI 漫画 Phase 1.1 接线源守卫（§三/§五/§六/§十/§十二/§十四/§十六/§二十 + P0-1）。
 *
 * 锁定的规范：
 * - §三 并行角色起草：per-slot Record 状态（角色 A 起草不 disable 角色 B），
 *   组件结构上不存在全局 drafting 布尔；
 * - §五/§八 锁定门禁 UI：缺参考图时按钮 disabled + 原因 title，文案来自 domain 常量；
 * - §六 参考图生成唯一入口：组件只经 onGenerateReference 上抛，页面 buildCharacterReferenceTask
 *   → createSeriesTask（组件不得自带第二提交链路）；
 * - §十二 模型标识：一律 resolveModelForRole 真实 resolved 名，禁止硬编码模型名；
 * - §十四 按钮层级：app-btn 基类 + primary/secondary/danger variant，漫画侧不发明按钮类；
 * - §十六 新建 Modal：6 字段概念卡 + [使用这个方案] + 失败重试；
 * - §二十 Debug 面板 DEV-only（Production 隐藏）。
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const comicStudio = read('../ComicStudio.tsx');
const characterStage = read('../../features/comic/components/ComicCharacterStage.tsx');
const newProjectDialog = read('../../features/comic/components/ComicNewProjectDialog.tsx');
const storyStage = read('../../features/comic/components/ComicStoryStage.tsx');
const planningSurface = read('../../features/comic/components/AIPlanningSurface.tsx');
const history = read('../History.tsx');
const comicCss = read('../ComicStudio.css');

describe('§三 并行角色起草（per-slot 状态，无全局遮罩）', () => {
  test('组件状态 = Record<slotId, SlotDraftState>（结构上无法互相 disable）', () => {
    expect(characterStage).toContain('useState<Record<string, SlotDraftState>>');
    expect(characterStage).not.toMatch(/const\s+\[busy,\s*setBusy\]\s*=\s*useState/);
  });

  test('起草进度按 slotId 写入；失败原位保留 errorText + 重试回调', () => {
    expect(characterStage).toContain('const setDraft = (slotId: string, patch: Partial<SlotDraftState>)');
    expect(characterStage).toContain("setDraft(slotId, { status: 'failed', errorText:");
    expect(characterStage).toContain('onRetry');
  });
});

describe('§五/§八 锁定门禁 UI（缺参考图 = disabled + 原因）', () => {
  test('锁定拦截文案来自 domain 常量（单一来源，不复制字符串）', () => {
    expect(characterStage).toContain('COMIC_CHARACTER_LOCK_MISSING_REFERENCE');
    expect(characterStage).toContain('lockComicCharacter(character, { requireReference: refsRequired })');
  });

  test('锁定按钮 disabled 由 lockDisabledReason 驱动并把原因挂到 title', () => {
    // V4.2.10 §八/§九：单一 Primary [确认并锁定] + 复选项「保存到演员库，方便以后复用」
    //（默认勾选）——不再并列两个语义只差「是否入库」的按钮；拦截文案 = domain 常量
    expect(characterStage.match(/disabled=\{Boolean\(lockDisabledReason\)\}/g)?.length).toBe(1);
    expect(characterStage).toContain("title={lockDisabledReason ?? (savePref ?");
    expect(characterStage).toContain('只锁定当前漫画，不进演员库');
    // 缺参考图 = disabled + 卡内原位可见原因（comic-lock-reason），不只有 title
    expect(characterStage).toContain('comic-lock-reason');
  });
});

describe('§六/§七 参考图生成唯一入口（复用 Image2 链路，零平行系统）', () => {
  test('角色组件只上抛 onGenerateReference，不 import 任务构建 / 生图 API', () => {
    expect(characterStage).toContain('onGenerateReference: (character: ComicCharacter) => void');
    // 结构隔离：不 import 任务构建器 / 任务商店 / 计费（提交只能在页面层发生）
    for (const forbiddenImport of [
      "from '../comicTask'",
      "from '../../../store/useTaskStore'",
      "from '../../../services/billingService'",
      'comicCharacterImageClient',
    ]) {
      expect(characterStage.includes(forbiddenImport)).toBe(false);
    }
  });

  test('页面：buildCharacterReferenceTask → createSeriesTask（与锚点/系列同链路）', () => {
    expect(comicStudio).toContain('buildCharacterReferenceTask');
    expect(comicStudio).toContain('createSeriesTask');
    expect(comicStudio).toContain("kind === 'character_ref'");
  });

  test('在途参考图状态由任务事实派生（referenceTaskStatusOf + Record），不进角色持久状态', () => {
    expect(comicStudio).toContain('referenceTaskStatusOf');
    expect(comicStudio).toContain('referenceTasks');
  });
});

describe('§十二 真实模型标识（禁止硬编码模型名）', () => {
  const uiSources = [comicStudio, characterStage, newProjectDialog, storyStage];

  test('模型显示一律经 resolveModelForRole（只读预显）', () => {
    for (const source of [characterStage, newProjectDialog, storyStage]) {
      expect(source).toContain("resolveModelForRole('comic_planner')");
      expect(source).not.toContain('OPENAI');
      expect(source).not.toContain('apiKey');
      expect(source).not.toContain('baseURL');
    }
  });

  test('漫画 UI 不硬编码任何模型名（显示值只能来自运行时解析）', () => {
    for (const source of uiSources) {
      expect(source).not.toMatch(/gpt-image|glm-|claude|gemini|doubao|qwen/i);
    }
  });

  test('Planning Surface 显示 modelLabel（服务 outcome 回填 outcome.modelName）', () => {
    expect(characterStage).toContain('modelLabel: outcome.modelName');
    expect(planningSurface).toContain('modelLabel');
  });
});

describe('§十四 按钮层级（app-btn 基类 + variant，无第二套按钮体系）', () => {
  const buttonSources = [characterStage, newProjectDialog, storyStage];

  test('所有按钮 = app-btn 基类 + 恰一个真实 variant（primary/secondary/danger；ghost 不存在）', () => {
    // V4.2.7 修正：旧正则曾把「缺 app-btn 基类 + 不存在的 app-btn-ghost」锁成规范，
    // 导致整个模块按钮退化成 UA 默认样式。新守卫要求：
    //  1) 类名首 token 必须是 app-btn（尺寸档 app-btn-sm 跟随其后）；
    //  2) variant 恰好一个且只允许 primary / secondary / danger；
    //  3) 显式禁止 app-btn-ghost（App.css 从未定义过该类）。
    for (const source of buttonSources) {
      const classNames = [...source.matchAll(/className=\{?["`]([^"`]+)["`]/g)].map(match => match[1]!);
      const buttonish = classNames.filter(name => name.includes('app-btn'));
      expect(buttonish.length).toBeGreaterThan(0);
      for (const name of buttonish) {
        const classes = name.trim().split(/\s+/);
        expect(classes[0], `${name} → 缺 app-btn 基类`).toBe('app-btn');
        const variants = classes.filter(token => /^app-btn-(primary|secondary|danger)$/.test(token));
        expect(variants, `${name} → variant 必须恰一个`).toHaveLength(1);
        expect(classes, `${name} → app-btn-ghost 不存在`).not.toContain('app-btn-ghost');
      }
    }
  });

  test('漫画侧不发明按钮类（CSS 无 .comic-*btn 定义）', () => {
    expect(comicCss).not.toMatch(/\.comic-[a-z-]*btn/);
    expect(comicCss).not.toMatch(/\.comic-btn/);
  });
});

describe('§十六 新建 Modal：Story-first 概念卡 + 阶段 Progress + 失败重试', () => {
  test('推荐卡 = 完整故事 + 布局可视化 + 节拍（V4.2.7：先讲完故事再谈形式）', () => {
    for (const marker of ['storyTitle', 'oneLineStory', 'fullStory', 'punchline', 'storyboardBeats']) {
      expect(newProjectDialog).toContain(marker);
    }
    expect(newProjectDialog).toContain('使用这个故事');
    expect(newProjectDialog).toContain('comic-concept-card');
    // 布局可视化复用 ComicStoryPreview（V4.2.9 形式小卡走 ComicFormPreviewMini；
    // 均纯 CSS，§九：推荐阶段零 Image API）
    expect(newProjectDialog).toContain('<ComicStoryPreview');
    expect(newProjectDialog).toContain('<ComicFormPreviewMini');
    expect(newProjectDialog).toContain('resolveConceptPresentation');
    // 方案切换（单方案大 Preview + tab，§十四 B 方案）
    expect(newProjectDialog).toContain('comic-concept-switcher');
    expect(newProjectDialog).toContain('role="tab"');
  });

  test('高级规划信息默认折叠：视觉方向 / 剧情结构 / 适用场景 只出现在「查看创作详情」内', () => {
    // 每个高级标签只允许出现一次，且必须位于 advancedOpen 条件渲染块内
    for (const label of ['视觉方向', '剧情结构', '适用场景']) {
      expect(newProjectDialog.match(new RegExp(label, 'g'))?.length).toBe(1);
    }
    expect(newProjectDialog).toContain('查看创作详情');
    expect(newProjectDialog).toContain('comic-concept-advanced');
    expect(newProjectDialog).toContain('aria-expanded={advancedOpen}');
    const advancedStart = newProjectDialog.indexOf('comic-concept-advanced');
    const advancedEnd = newProjectDialog.indexOf('</dl>', advancedStart);
    const advancedBlock = newProjectDialog.slice(advancedStart, advancedEnd);
    for (const label of ['视觉方向', '剧情结构', '适用场景']) {
      expect(advancedBlock).toContain(label);
    }
  });

  test('推荐 / 起草两段 Planning Surface + 失败重试（输入保留：失败不重置 phase / requirement）', () => {
    // V4.2.9：两段都进居中 AIPlanningSurface（内容区中央，不再沉底）
    expect(newProjectDialog).toContain('AI 正在规划漫画');
    expect(newProjectDialog).toContain('comic-recommend-planning-stage');
    expect(newProjectDialog).toContain('重新推荐');
    expect(newProjectDialog).toContain('正在起草漫画技能');
    expect(newProjectDialog).toContain('重新起草');
    // 失败只 patch run，不清 phase —— 需求与已选方案全部保留；
    // 输入重置只发生在弹窗重新打开的 useEffect（用户主动重来，不是失败副作用）
    expect(newProjectDialog).toContain("patchRun('recommend', { status: 'failed', errorText:");
    expect(newProjectDialog).toContain("patchRun('skill', { status: 'failed', errorText:");
    expect(newProjectDialog.match(/setRequirement\(''\)/g)?.length).toBe(1);
  });

  test('模型预显进 helper 文案（规划模型：…）', () => {
    expect(newProjectDialog).toContain('规划模型：');
  });
});

describe('§十 Step Footer + 门禁导航', () => {
  test('Footer：blockers 逐条列出 + [← 上一步] secondary + [继续：…] primary disabled 同源', () => {
    expect(comicStudio).toContain('comic-step-footer');
    expect(comicStudio).toContain('comic-step-footer-blockers');
    expect(comicStudio).toContain('comic-footer-next-');
    expect(comicStudio).toContain('继续之前需完成：');
  });

  test('被锁步骤点击给出原因（toast 第一条 blockedReason），不做无反应点击', () => {
    expect(comicStudio).toContain('blockedReason');
    expect(comicStudio).toContain('toastError');
  });

  test('Rail 角色行 = summaryLabel 单一事实源', () => {
    expect(comicStudio).toContain('comic-rail-characters');
    expect(comicStudio).toContain('summaryLabel');
  });
});

describe('§二十 DEV-only Debug 面板', () => {
  test('import.meta.env.DEV 门禁 + comic-debug-card 锚点', () => {
    expect(comicStudio).toContain('import.meta.env.DEV &&');
    expect(comicStudio).toContain('comic-debug-card');
  });
});

describe('§十五 漫画 CSS 不建第二套设计系统', () => {
  test('Phase 1.1 新增块只用既有令牌（无硬编码色值 / 无新字体族）', () => {
    // V4.2.9：进度卡演进为 comic-planning-surface，锚点同步
    const phase11Block = comicCss.slice(comicCss.indexOf('comic-planning-stage-wrap'));
    expect(phase11Block.length).toBeGreaterThan(0);
    expect(phase11Block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(phase11Block).not.toContain('font-family');
    expect(phase11Block).toContain('var(--accent-primary)');
    expect(phase11Block).toContain('var(--accent-danger)');
  });
});

describe('历史溯源：character_ref 任务可读（§七）', () => {
  test('History 术语表登记角色参考图 + 角色名明细行', () => {
    expect(history).toContain("character_ref: '角色参考图'");
    expect(history).toContain("characterName ? ` · 角色「${task.execution_snapshot.comic.characterName}」`");
  });
});
