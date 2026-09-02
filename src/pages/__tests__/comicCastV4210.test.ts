import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { comicCharactersSummaryState } from '../../features/comic/domain';
import type { ComicProject } from '../../features/comic/types';
import { normalizeComicCharacter, normalizeComicProject, normalizeComicSkill } from '../../features/comic/normalize';

/**
 * V4.2.10 —— 角色演员页（Character Cast Workspace）收口守卫（规格 §3~§25，docs/ai-comic/18 审计）。
 *
 * 锁定的规范（16 项验收场景）：
 *  1  顶部「本期演员阵容」总览：roster + 必选/可选计数 + 还需要完成/演员已就绪；
 *  2  必选演员 / 可选演员分区（不再纵向全宽堆叠）；
 *  3  必选槽位 2 列响应式网格（≤1100px 退化单列）；
 *  4  参考图列 = 角色卡 ~25-30% 宽（148px 网格轨道；删除固定 172px 溢出写法）；
 *  5  [生成参考图] CTA 在 Reference 区域内部（旧「width:100% 紫色横条」规则已删）；
 *  6  统一状态徽标词表：草稿/待生成参考图/参考图生成中/待确认/已锁定/需要重新生成/失败
 *     —— 全部出自 comicCharactersSummaryState 单一事实源，组件不自拼；
 *  7  缺参考图时 [确认并锁定] disabled + 卡内原位可见原因（domain 常量）；
 *  8  锁定后默认 Compact 卡 + [编辑角色] 再展开；draft/generating/缺图锁定异常保持展开；
 *  9  「保存到演员库，方便以后复用」复选项默认勾选（savePrefs ?? true）；
 * 10  锁定去向两态回显：已锁定 · 已保存演员库 / 已锁定 · 仅本项目；
 * 11  默认信息 = 一句话设定 + 特征计数（固定特征 N 项 · 可变特征 M 项）；
 * 12  「查看角色设定详情」原生 details 折叠默认关闭；
 * 13  大白话微调（textarea + 应用调整）保留；
 * 14  点击参考图 → 全局 ImageViewer（openViewer 只传 path；组件不读大图）；
 * 15  Footer = ComicStepFooter 门禁（页面唯一渲染处）；
 * 16  Right Rail = 阵容计数 + 每角色小头像（缺图首字占位）。
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const stage = read('../../features/comic/components/ComicCharacterStage.tsx');
const page = read('../ComicStudio.tsx');
const css = read('../ComicStudio.css');
const domain = read('../../features/comic/domain.ts');

// ---------------------------------------------------------------------------
// 场景 1：本期演员阵容总览
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 1 · 阵容总览（首屏即知 全员 / 进度 / 下一步）', () => {
  test('总览卡：roster 行（头像 + 槽位 + 徽标）+ 计数行', () => {
    expect(stage).toContain('comic-cast-overview');
    expect(stage).toContain('本期演员阵容');
    expect(stage).toContain('comic-cast-roster-row');
    expect(stage).toContain('comic-cast-avatar');
    expect(stage).toContain('必选角色 {slotsSummary.requiredLocked}/{slotsSummary.requiredTotal} 已完成');
    expect(stage).toContain('可选角色 {optionalDone}/{optionalSlots.length}');
    expect(stage).toContain('已锁定 {lockedCount}');
  });

  test('未就绪 = 「还需要完成：」逐条 blockers；就绪 = 「演员已就绪」', () => {
    expect(stage).toContain('还需要完成：');
    expect(stage).toContain('slotsSummary.blockers.map');
    expect(stage).toContain('演员已就绪');
    expect(stage).toContain('slotsSummary.charactersDone');
  });

  test('roster 按技能槽位顺序渲染全部槽（必选 + 可选）', () => {
    expect(stage).toContain('skill.characterSlots.map(renderRosterRow)');
  });
});

// ---------------------------------------------------------------------------
// 场景 2/3：必选 / 可选分区 + 2 列网格
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 2/3 · 分区与网格', () => {
  test('必选 / 可选两个分区（分区标题 + 副文案语义：阻塞 vs 不阻塞）', () => {
    expect(stage).toContain('comic-cast-section-required');
    expect(stage).toContain('comic-cast-section-optional');
    expect(stage).toContain('必选演员');
    expect(stage).toContain('角色必须确认锁定后才能继续');
    expect(stage).toContain('可选演员');
    expect(stage).toContain('不影响下一步，可随时添加');
  });

  test('分区由 slot.required 派生（不是手写槽位清单）', () => {
    expect(stage).toContain("skill.characterSlots.filter(slot => slot.required)");
    expect(stage).toContain("skill.characterSlots.filter(slot => !slot.required)");
  });

  test('CSS：必选 2 列网格 + ≤1100px 单列退化', () => {
    expect(css).toContain('.comic-cast-grid {');
    expect(css).toMatch(/\.comic-cast-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).toMatch(/@media \(max-width: 1100px\)\s*\{\s*\.comic-cast-grid\s*\{\s*grid-template-columns:\s*1fr;/s);
  });

  test('可选未绑定 = Compact Add Card（AI 起草 / 从演员库选择），不再是全宽空卡', () => {
    expect(stage).toContain('comic-cast-add-card');
    expect(stage).toContain('AI 起草');
    expect(stage).toContain('从演员库选择');
  });
});

// ---------------------------------------------------------------------------
// 场景 4/5：参考图 = 视觉中心 + CTA 在 Reference 区域内部
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 4/5 · 参考图视觉层级', () => {
  test('CSS：hero 参考图列 148px（≈半宽卡 30%）；固定 172px 溢出写法已删', () => {
    expect(css).toMatch(/\.comic-character-hero\s*\{[^}]*grid-template-columns:\s*148px\s*minmax\(0,\s*1fr\)/s);
    expect(css).not.toMatch(/\.comic-hero-figure\s*\{[^}]*width:\s*172px/s);
    expect(css).not.toMatch(/\.comic-hero-thumb\s*\{[^}]*width:\s*172px/s);
  });

  test('CSS：旧「参考图按钮拉满整列/整卡」规则已删（紫色横条根因）', () => {
    expect(css).not.toMatch(/\.comic-ref-actions\s+\.app-btn-sm\s*\{[^}]*width:\s*100%/s);
    expect(css).not.toMatch(/\.comic-character-body\s+\.comic-ref-actions\s*\{/s);
  });

  test('[生成参考图] 在 Reference Surface 空态内部（comic-ref-empty），是区域内唯一 Primary', () => {
    // 源码顺序：busy → failed → view → 读取中 → empty → 成图操作 → meta
    const emptyStart = stage.indexOf('comic-ref-empty');
    const emptyBlock = stage.slice(emptyStart, stage.indexOf('comic-ref-meta'));
    expect(emptyStart).toBeGreaterThan(0);
    expect(emptyBlock).toContain('暂无角色参考图');
    expect(emptyBlock).toContain('生成参考图');
    expect(emptyBlock.match(/app-btn-primary/g)?.length).toBe(1);
  });

  test('空态三来源：生成 / 从演员库选择 / 从图库选择 / 上传参考图', () => {
    const emptyBlock = stage.slice(stage.indexOf('comic-ref-empty'), stage.indexOf('comic-ref-meta'));
    expect(emptyBlock).toContain('从演员库选择');
    expect(emptyBlock).toContain('从图库选择');
    expect(emptyBlock).toContain('上传参考图');
  });
});

// ---------------------------------------------------------------------------
// 场景 6：Reference Surface 四态（空 / 生成中 / 失败 / 成图）
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 6 · Reference Surface 四态与统一徽标', () => {
  test('生成中态：真实任务事实文案（不虚构模型名 / 百分比）', () => {
    expect(stage).toContain('comic-ref-busy');
    expect(stage).toContain('正在生成角色参考图');
    expect(stage).toContain('任务已提交，进度见任务队列');
    expect(stage).toContain("refTask?.status === 'queued' || refTask?.status === 'running'");
  });

  test('失败态：原位重试（重新生成参考图）', () => {
    expect(stage).toContain('comic-ref-failed');
    expect(stage).toContain('重新生成参考图');
    expect(stage).toContain("refTask?.status === 'failed' && !character.referenceImage");
  });

  test('成图态：过期横幅 + 重新生成 / 从图库换图（既有锚点保留）', () => {
    expect(stage).toContain('comic-ref-stale-banner');
    expect(stage).toContain('重新生成');
    expect(stage).toContain('从图库换图');
  });

  test('徽标词表统一且出自单一事实源（domain label），组件不自拼状态文字', () => {
    // domain：V4.2.10 §七 词表
    for (const label of ['待生成参考图', '参考图生成中', '待确认', '需要重新生成']) {
      expect(domain).toContain(`'${label}'`);
    }
    // 组件：渲染 slotView.label，不存在第二套状态文字拼接
    expect(stage).toContain('comic-slot-badge');
    expect(stage).toContain('{slotView.label}');
    expect(stage).not.toContain("state === 'ready' ? '参考图就绪");
  });
});

// ---------------------------------------------------------------------------
// 场景 7/9：锁定门禁 + 入库复选项
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 7/9 · 锁定门禁与入库复选项', () => {
  test('缺参考图 = 单一 [确认并锁定] disabled + 原因（domain 常量 + 卡内可见）', () => {
    expect(stage.match(/disabled=\{Boolean\(lockDisabledReason\)\}/g)?.length).toBe(1);
    expect(stage).toContain('comic-lock-reason');
    expect(stage).toContain('lockComicCharacter(character, { requireReference: refsRequired })');
  });

  test('复选项「保存到演员库，方便以后复用」默认勾选，未勾选 = 仅本项目', () => {
    expect(stage).toContain('保存到演员库，方便以后复用');
    expect(stage).toContain('savePrefs[character.id] ?? true');
    expect(stage).toContain('不勾选则仅本项目锁定');
  });

  test('单一 Primary 锁定（旧「仅本项目锁定」并列按钮已删）', () => {
    // 锁定按钮与锁定调用各只有一处（入库与否由复选项决定）
    expect(stage.match(/data-testid=\{`comic-lock-\$\{slot\.slotId\}`\}/g)?.length).toBe(1);
    expect(stage.match(/void tryLock\(character, savePref\)/g)?.length).toBe(1);
    expect(stage).not.toContain('void tryLock(character, true)');
    expect(stage).not.toContain('void tryLock(character, false)');
    // 不存在文案为「仅本项目锁定」的按钮（仅保留 helper / 去向回显语义）
    expect(stage).not.toMatch(/>\s*仅本项目锁定\s*</);
  });
});

// ---------------------------------------------------------------------------
// 场景 8/10：Compact 卡 + 锁定去向回显
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 8/10 · 锁定折叠与去向回显', () => {
  test('锁定默认 Compact（编辑角色再展开）；draft / 生成中 / 缺图保持展开', () => {
    expect(stage).toContain('comic-character-compact');
    expect(stage).toContain('编辑角色');
    expect(stage).toContain("character.status !== 'locked' || expandedSlots[slot.slotId] === true || legacyLockedMissingRef");
  });

  test('解锁 = 回到待确认并保持展开（视图操作）', () => {
    expect(stage).toContain('解锁修改');
    expect(stage).toContain(
      'const unlockAndExpand = (slotId: string, character: ComicCharacter) => {\n'
      + '    setExpandedSlots(prev => ({ ...prev, [slotId]: true }));\n'
      + '    props.onPatch(draft => upsertCharacterSnapshot(draft, unlockComicCharacter(character)));',
    );
  });

  test('去向两态：已锁定 · 已保存演员库 / 已锁定 · 仅本项目（会话事实，不猜历史）', () => {
    expect(stage).toContain('const [lockedSaved, setLockedSaved] = useState<Record<string, boolean>>({})');
    expect(stage).toContain("' · 已保存演员库'");
    expect(stage).toContain("' · 仅本项目'");
  });
});

// ---------------------------------------------------------------------------
// 场景 11/12/13：信息分层 + 微调保留
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 11/12/13 · 信息分层与微调', () => {
  test('默认只有一句话设定 + 特征计数', () => {
    expect(stage).toContain('comic-hero-summary');
    expect(stage).toContain('固定特征 {character.immutableTraits.length} 项');
    expect(stage).toContain('可变特征 ${character.mutableTraits.length} 项');
  });

  test('「查看角色设定详情」原生 details 默认关闭（无 open 属性）', () => {
    const detailsMatch = stage.match(/<details className="comic-advanced-card comic-character-advanced">/);
    expect(detailsMatch).not.toBeNull();
    expect(stage).toContain('查看角色设定详情');
    expect(stage).not.toContain('comic-character-advanced" open');
  });

  test('大白话微调保留（textarea + 应用调整 + inline error）', () => {
    expect(stage).toContain('微调「{character.name}」');
    expect(stage).toContain('placeholder="例：耳朵再圆一点，加一副圆框眼镜"');
    expect(stage).toContain('应用调整');
    expect(stage).toContain('comic-patch-error');
  });
});

// ---------------------------------------------------------------------------
// 场景 14：点击参考图 → 全局 ImageViewer
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 14 · 参考图点击放大（复用全局 ImageViewer）', () => {
  test('comic-ref-view 白名单控件 → openViewer 只传 path / title / fileName', () => {
    expect(stage).toContain('comic-ref-view');
    expect(stage).toContain('useImageViewerStore.getState().openViewer');
    expect(stage).toContain('path: character.referenceImage.path');
  });

  test('组件不读大图（查看器自读；缩略图只走 readThumbnail）', () => {
    expect(stage).not.toContain('readImageData');
    expect(stage).not.toContain('saveChatImage');
    expect(stage).toContain('api.readThumbnail');
  });
});

// ---------------------------------------------------------------------------
// 场景 15：Footer 门禁
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 15 · Footer 门禁（页面唯一渲染处）', () => {
  test('步骤 Footer 由页面渲染（角色组件不自带门禁 CTA）', () => {
    expect(page).toContain('<ComicStepFooter flow={flow} step={step} onGoto={setViewStep} />');
    expect(page).toContain('comic-step-footer');
    expect(stage).not.toContain('ComicStepFooter');
    expect(stage).not.toContain('comic-blockers');
  });
});

// ---------------------------------------------------------------------------
// 场景 16：Right Rail 阵容计数 + 小头像
// ---------------------------------------------------------------------------

describe('V4.2.10 场景 16 · Rail 阵容计数与小头像', () => {
  test('Rail：锁定计数 + 每角色小头像（有图缩略 / 缺图首字占位 / 锁定描边）', () => {
    expect(page).toContain('comic-rail-cast');
    expect(page).toContain('已锁定 {charactersSummary.requiredLocked}/{charactersSummary.requiredTotal}');
    expect(page).toContain('comic-rail-cast-chip');
    expect(page).toContain('comic-rail-cast-initial');
    expect(page).toContain("slot.state === 'locked' ? ' is-locked'");
  });

  test('Rail 角色 summaryLabel 行保留（单一事实源锚点不回退）', () => {
    expect(page).toContain('comic-rail-characters');
    expect(page).toContain('summaryLabel');
  });

  test('CSS：rail 阵容小头像样式存在（26px 圆角 + 锁定态主色描边）', () => {
    expect(css).toContain('.comic-rail-cast-chip {');
    expect(css).toMatch(/\.comic-rail-cast-chip\.is-locked\s*\{[^}]*border-color:\s*var\(--accent-primary\)/s);
  });
});

// ---------------------------------------------------------------------------
// 补充：状态单一事实源行为回归（词表改动不破坏派生）
// ---------------------------------------------------------------------------

describe('V4.2.10 附录 · comicCharactersSummaryState 词表回归', () => {
  function makeProject(characterOverrides: Record<string, unknown>): ComicProject {
    const character = normalizeComicCharacter({
      id: 'char-1', name: '汤圆', role: '主角', status: 'draft',
      immutableTraits: ['奶油黄毛色'], ...characterOverrides,
    });
    if (!character) throw new Error('fixture broken');
    const restored = normalizeComicProject({
      id: 'p1', name: '第一期', stage: 'character_confirmation',
      skillSnapshot: normalizeComicSkill({
        name: '职场吐槽四格', layout: { arrangement: 'grid_4', panelCount: 4 },
        characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
      }),
      characterSnapshots: [character],
      characterBindings: { hero: character.id },
      story: null, panels: [], dialogues: [],
    });
    if (!restored) throw new Error('project fixture broken');
    return restored;
  }

  test('草稿 → 待生成参考图；有图 → 待确认；锁定 → 已锁定；过期 → 需要重新生成', () => {
    expect(comicCharactersSummaryState(makeProject({})).slots[0]!.label).toBe('待生成参考图');
    expect(comicCharactersSummaryState(makeProject({ referenceImage: { path: '/r.png', label: 'r' } })).slots[0]!.label).toBe('待确认');
    expect(comicCharactersSummaryState(makeProject({ status: 'locked', referenceImage: { path: '/r.png', label: 'r' } })).slots[0]!.label).toBe('已锁定');
    expect(comicCharactersSummaryState(makeProject({ referenceImage: { path: '/r.png', label: 'r' }, referenceStale: true })).slots[0]!.label).toBe('需要重新生成');
  });

  test('排队 / 运行统一「参考图生成中」；blocker 保留排队事实', () => {
    const queued = comicCharactersSummaryState(makeProject({}), { 'char-1': { taskId: 't1', status: 'queued' } });
    expect(queued.slots[0]!.label).toBe('参考图生成中');
    expect(queued.slots[0]!.blocker).toContain('参考图排队中');
    const running = comicCharactersSummaryState(makeProject({}), { 'char-1': { taskId: 't1', status: 'running' } });
    expect(running.slots[0]!.label).toBe('参考图生成中');
    expect(running.slots[0]!.blocker).toContain('参考图生成中');
  });
});
