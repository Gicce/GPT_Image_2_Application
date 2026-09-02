import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * AI 漫画生成阶段 UI 接线源守卫（Phase 1.2 §41~§48 + V4.2.11 §F 编排重构）。
 *
 * 锁定的规范：
 * - §D/§F（P0-6）：默认流程没有「第一张效果」用户卡——一个主 CTA「生成漫画画面（N 格）」
 *   一次性提交全部分镜；内部锚点（anchor）/系列（series）机制不构成用户语言；
 * - §F 高级「生成第一格后暂停确认」（默认关）开启时：生成视觉基准卡恢复
 *   （字段：使用角色 / 视觉风格 / 画面内容 / 参考图 / 任务状态；[生成视觉基准] /
 *   [确认这个效果] / [重新生成]），UI 节奏 = 生成视觉基准 → 生成剩余 → 组合漫画页面；
 * - §F 渐进填充：comic-panel-grid 是紧凑预览卡网格（桌面 2 列 / 窄屏 1 列、主图限高），
 *   与最终页排版几何解耦（V4.2.13 残留修复：竖版形式 columns=1 不再把预览卡撑成
 *   全宽巨型方块）；最终页几何由 ComicFinalPreview / 导出呈现；
 *   逐格 排队中 / 生成中 / 已生成 / 失败；
 * - §44 一格图内不得再出现四宫格：R1 三面堵（标题去 comicForm、模板 comicForm 恒空、
 *   negative 多格拼图防线 + 单格画面强制指令）；
 * - §45 单格卡：状态 / thumbnail / 一句画面摘要 / [重试] / [重新生成] / 失败原因(lastError)；
 *   §46 Partial Failure：只重试失败格（已成功格不进重试批量）；
 * - §47/§48/§F 最终页：本地合成（零 Image2）；整页合成只在「导出整页 PNG」显式
 *   触发（V4.2.13 残留修复：删除对白编辑自动组合 effect——编辑阶段零自动导出 /
 *   零入图库 / 零自动 toast）。
 */

const generateStage = readFileSync(
  resolve(__dirname, '../../features/comic/components/ComicGenerateStage.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const studioPage = readFileSync(
  resolve(__dirname, '../ComicStudio.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const finalPreview = readFileSync(
  resolve(__dirname, '../../features/comic/components/ComicFinalPreview.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const compiler = readFileSync(
  resolve(__dirname, '../../features/comic/promptCompiler.ts'), 'utf-8',
).replace(/\r\n/g, '\n');
const comicExport = readFileSync(
  resolve(__dirname, '../../features/comic/comicExport.ts'), 'utf-8',
).replace(/\r\n/g, '\n');
const studioCss = readFileSync(
  resolve(__dirname, '../ComicStudio.css'), 'utf-8',
).replace(/\r\n/g, '\n');
const copy = readFileSync(
  resolve(__dirname, '../../../.claude/skills/cyimagepro-ui/copy.md'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('V4.2.11 §F 默认编排（P0-6 硬验收）', () => {
  test('默认卡 = 生成漫画画面 / 生成漫画页面；一次性提交全部格', () => {
    expect(generateStage).toContain(`{multiPage ? '生成漫画页面' : '生成漫画画面'}`);
    expect(generateStage).toContain('一次性按分镜生成全部');
    expect(generateStage).toContain('data-testid="comic-generate-submit"');
  });

  test('页面层：默认 skipAnchor 一次性提交；高级暂停模式才走锚点链路', () => {
    expect(studioPage).toContain("const skipAnchor = project.skillSnapshot.referenceStrategy.pauseAfterFirstPanel !== true;");
    expect(studioPage).toContain('buildPanelSeriesTask(project, generationContext, { skipAnchor })');
  });

  test('锚点用户语言全部退场（第一张效果 / 生成第一张 / 首格锚点）', () => {
    for (const forbidden of ['第一张效果', '生成第一张', '首格锚点', '生成首格锚点']) {
      expect(generateStage.includes(forbidden)).toBe(false);
    }
    expect(generateStage).toContain('project.consistency?.anchor');
  });

  test('高级开关：生成第一格后暂停确认（默认关，读写 pauseAfterFirstPanel）', () => {
    expect(generateStage).toContain('pauseAfterFirstPanel: boolean');
    expect(generateStage).toContain('生成第一格后暂停确认');
    expect(generateStage).toContain('props.onTogglePauseAfterFirstPanel(e.target.checked)');
    expect(studioPage).toContain('pauseAfterFirstPanel={active.skillSnapshot.referenceStrategy.pauseAfterFirstPanel === true}');
    expect(studioPage).toContain('handleTogglePauseAfterFirstPanel');
  });
});

describe('§F 高级模式（生成视觉基准 → 生成剩余 → 组合页面）', () => {
  test('基准卡字段：使用角色 / 视觉风格 / 画面内容 / 参考图 / 任务状态', () => {
    expect(generateStage).toContain('<h4 className="comic-card-title">生成视觉基准</h4>');
    for (const label of ['使用角色', '视觉风格', '画面内容', '参考图', '任务状态']) {
      expect(generateStage).toContain(`<dt>${label}</dt>`);
    }
    expect(generateStage).toContain("character.referenceImage ? ' · 参考图已备' : ' · 无参考图'");
  });

  test('动作按钮：生成视觉基准 / 确认这个效果 / 重新生成', () => {
    expect(generateStage).toContain('生成视觉基准');
    expect(generateStage).toContain('确认这个效果');
    expect(generateStage).toContain('重新生成');
    expect(generateStage).not.toContain('审定通过，锁定锚点');
  });
});

describe('§F 渐进填充 + §45/§46 单格卡', () => {
  test('预览卡网格与最终页几何解耦：列数走 CSS 响应式（桌面 2 列 / 窄屏 1 列），不再内联 presentation.columns', () => {
    expect(generateStage).toContain('data-testid="comic-generate-grid"');
    // V4.2.13 残留修复：竖版形式（上下双格 columns=1）经内联样式把预览卡撑成
    // 全宽巨型方块、页面被撑爆——列数必须交给 CSS，不随最终页排版几何走。
    expect(generateStage).not.toContain('gridTemplateColumns');
    expect(studioCss).toMatch(/\.comic-panel-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(studioCss).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.comic-panel-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });

  test('主图限高 + 描述限行：卡片不再被巨型方块图与长文案撑爆', () => {
    expect(studioCss).toMatch(/\.comic-panel-figure\s*\{[^}]*max-height:\s*220px/s);
    expect(studioCss).toMatch(/\.comic-panel-scene\s*\{[^}]*-webkit-line-clamp:\s*3/s);
  });

  test('§44 单元格标签随展示形式：多页=第 N 页，单页=第 N 格', () => {
    expect(generateStage).toContain("multiPage ? `第 ${order + 1} 页` : `第 ${order + 1} 格`");
  });

  test('§45 卡片要素：状态 / 缩略 / 一句画面摘要 / 重试 / 重新生成 / 失败原因', () => {
    expect(generateStage).toContain('comic-panel-scene">{panel.scene}');
    expect(generateStage).toContain(`panel.generationStatus === 'failed' ? '重试' : '重新生成'`);
    expect(generateStage).toContain('失败原因：{panel.lastError ||');
    expect(generateStage).toContain('props.onRegeneratePanel(panel.id)');
  });

  test('§46 Partial Failure：进度行明示只重试失败格；全部完成只说画面已齐（不再宣称已组合）', () => {
    expect(generateStage).toContain('已生成 {completedCount} / {panels.length}');
    expect(generateStage).toContain('只重试失败的那几格');
    expect(generateStage).toContain('画面已齐，可进入「对白与字幕」');
    expect(generateStage).not.toContain('已组合最终页面');
  });

  test('单格重试不依赖锚点（V4.2.11 §F：默认流程无锚档案）', () => {
    expect(generateStage).not.toContain("title={!anchor ?");
    expect(generateStage).not.toContain('先确认第一张效果');
  });
});

describe('R1 单格画面铁律（§44：一格图内不得再画四宫格）', () => {
  test('编译器三面堵：标题去 comicForm / 模板 comicForm 恒空 / negative 多格防线 + 单格强制指令', () => {
    expect(compiler).toContain("case 'comicForm': return ''");
    expect(compiler).toContain('SINGLE_FRAME_DIRECTIVE');
    expect(compiler).toContain('MULTI_PANEL_NEGATIVE_GUARDS');
    expect(compiler).toContain('`【${skill.name}】`');
    // 标题不再拼接 comicForm
    expect(compiler).not.toContain('【${skill.comicForm}');
    for (const guard of ['多格拼图', '分格画面', 'comic sheet', 'four-panel layout']) {
      expect(compiler).toContain(`'${guard}'`);
    }
  });

  test('缺省模板只描述单格画面', () => {
    expect(compiler).toContain("'漫画单格画面（整幅图只画这一格）'");
    expect(compiler).not.toContain('漫画分镜（第');
  });
});

describe('§47/§48/§F 最终页面（Composition Renderer + 自动组合落库）', () => {
  test('生成阶段挂载 ComicFinalPreview（系列完成后展示）', () => {
    expect(generateStage).toContain('<ComicFinalPreview project={project} />');
  });

  test('客户端合成：renderComicSheets + api.readImageData，零 Image2 / 零任务提交依赖', () => {
    expect(finalPreview).toContain('renderComicSheets');
    expect(finalPreview).toContain('api.readImageData');
    for (const forbidden of ['createSeriesTask', 'authorizeImage2', 'requestQuote', 'buildAnchorTask']) {
      expect(finalPreview.includes(forbidden)).toBe(false);
    }
  });

  test('§F 组合能力：persistComicFinalPages 本地合成 → 落图库 → 索引归因，零 Image2', () => {
    expect(comicExport).toContain('export async function persistComicFinalPages');
    expect(comicExport).toContain('api.saveComicPageToLibrary(dataUrl, fileName)');
    expect(comicExport).toContain('api.importImagesToLibrary([path])');
    expect(comicExport).toContain('comic-final-page');
    expect(comicExport).toContain('export async function attributeComicPanelImages');
    expect(comicExport).toContain(`第 \${panel.order + 1} 格`);
    for (const forbidden of ['createSeriesTask', 'authorizeImageTask', 'requestQuote']) {
      expect(comicExport.includes(forbidden)).toBe(false);
    }
  });

  test('§F 页面层接线：整页合成收敛在 handleExport 显式导出（导出整页 PNG 唯一入口）', () => {
    expect(studioPage).toContain('const assets = await persistComicFinalPages(active)');
    expect(studioPage).toContain('applyComicFinalPages(draft, assets)');
    expect(studioPage).toContain('attributeComicPanelImages');
    expect(studioPage).toContain('最终页已存入图库');
  });

  test('V4.2.13 残留修复回归：对白编辑零自动组合 / 零入图库 / 零自动 toast', () => {
    // 此前的 composeKey 自动 effect：对白/成图指纹变化 2.5s 后自动合成整页 + 入图库
    // + toast「漫画整页已组合并保存到图库」——编辑对白即触发导出，违反编辑态铁律。
    expect(studioPage).not.toContain('COMPOSE_DEBOUNCE_MS');
    expect(studioPage).not.toContain('composedKeyRef');
    expect(studioPage).not.toContain('漫画整页已组合并保存到图库');
    expect(studioPage).not.toContain('自动组合');
    // 显式导出仍带防抖冲刷（画布所见 = 导出所得）
    expect(studioPage).toContain('flushPersist()');
  });

  test('布局与预览同源（§89）：comicExport 用 resolveComicPresentation 分页，不再自带 arrangementGrid', () => {
    expect(comicExport).toContain('computePageLayouts');
    expect(comicExport).toContain('resolveComicPresentation(skill, { totalPanels: panels.length })');
    expect(comicExport.includes('function arrangementGrid')).toBe(false);
  });

  test('多页 carousel：上一页 / 下一页 / 第 N / M 页', () => {
    expect(finalPreview).toContain('上一页');
    expect(finalPreview).toContain('下一页');
    expect(finalPreview).toContain('第 {current + 1} / {pages.length} 页');
  });

  test('只对成图与文字层变化重合成（不读 project.uiDraft）', () => {
    expect(finalPreview).toContain('signature');
    expect(finalPreview).not.toContain('project.uiDraft');
  });
});

describe('copy.md 术语登记', () => {
  test('V4.2.11 新文案已登记', () => {
    for (const term of ['生成视觉基准', '生成第一格后暂停确认', '确认这个效果', '最终页面预览', '生成漫画画面']) {
      expect(copy.includes(term)).toBe(true);
    }
  });
});
