import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * AI 漫画 Phase 12 接线源守卫（验收 P：任务与图片可溯源到项目 / 技能 / 故事）。
 *
 * 锁定的规范：
 * - History / TaskQueue 任务来源统一「AI 漫画」（copy.md §8b 任务来源表）；
 * - History 任务概览带「漫画溯源」行，全部来自 execution_snapshot.comic 快照，
 *   缺快照不出现该行（禁止伪造溯源）；
 * - 图库详情「来源 / 用途」两概念两行（copy.md §9）：来源 = AI 漫画 · ××，
 *   用途 = 首格锚点 / 系列分镜 / 单格重绘（真实 comic.kind 才有）；
 * - 来源归类唯一 resolver imageSource.ts（禁止页面散落归类）。
 */

const history = readFileSync(resolve(__dirname, '../History.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const taskQueue = readFileSync(resolve(__dirname, '../TaskQueue.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const imageSource = readFileSync(resolve(__dirname, '../../utils/imageSource.ts'), 'utf-8').replace(/\r\n/g, '\n');
const imageDetailMetadata = readFileSync(
  resolve(__dirname, '../../features/gallery/imageDetailMetadata.ts'), 'utf-8',
).replace(/\r\n/g, '\n');
const copy = readFileSync(
  resolve(__dirname, '../../../.claude/skills/cyimagepro-ui/copy.md'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('任务来源标签（History / TaskQueue 同口径）', () => {
  test('两个页面的 getSourceLabel 都有 comic → AI 漫画分支', () => {
    expect(history).toContain("if (task.task_source === 'comic') return 'AI 漫画';");
    expect(taskQueue).toContain("if (task.task_source === 'comic') return 'AI 漫画';");
  });
});

describe('History 漫画溯源行（快照真实值，禁止伪造）', () => {
  test('溯源行只在 execution_snapshot.comic 存在时渲染', () => {
    expect(history).toContain('{task.execution_snapshot?.comic && (');
    expect(history).toContain('<span>漫画溯源</span>');
  });

  test('溯源四要素 = 种类 · 项目 · 技能 · 故事（全部读快照字段）', () => {
    expect(history).toContain('COMIC_KIND_LABELS[task.execution_snapshot.comic.kind]');
    expect(history).toContain('task.execution_snapshot.comic.projectName');
    expect(history).toContain('task.execution_snapshot.comic.skillName');
    expect(history).toContain('task.execution_snapshot.comic.storyTitle');
  });

  test('种类词与 copy.md 2a 术语表一致', () => {
    expect(history).toContain("anchor: '首格锚点'");
    expect(history).toContain("panels: '系列分镜'");
    expect(history).toContain("panel_regen: '单格重绘'");
  });
});

describe('图库来源唯一 resolver（禁止页面散落归类）', () => {
  test('imageSource.ts：ai_comic 先于批量细分，筛 comic 桶', () => {
    expect(imageSource).toContain("ai_comic: 'AI 漫画'");
    expect(imageSource).toContain("if (linked.task_source === 'comic') return aiComicInfo(linked);");
    expect(imageSource).toContain("ai_comic: 'comic'");
    expect(imageSource).toContain("{ key: 'comic', label: 'AI 漫画' }");
  });

  test('History / TaskQueue 页面内不自行判定 ai_comic 来源（不出现散落归类）', () => {
    expect(history.includes("'ai_comic'")).toBe(false);
    expect(taskQueue.includes("'ai_comic'")).toBe(false);
  });
});

describe('图库详情：来源与用途两概念两行', () => {
  test('用途按 comic.kind 细分，缺快照不补用途', () => {
    expect(imageDetailMetadata).toContain("source.kind === 'ai_comic' && comicKind");
    // V4.2.13：烘焙文字整页合成入用途表（多行嵌套三元，逐用途词断言）
    for (const usage of ['首格锚点', '单格重绘', '烘焙文字', '系列分镜']) {
      expect(imageDetailMetadata).toContain(`'${usage}'`);
    }
    expect(imageDetailMetadata).toContain('task?.execution_snapshot?.comic?.kind');
  });
});

describe('copy.md 术语登记', () => {
  test('§8b 任务来源行与 §9 来源表都登记 AI 漫画', () => {
    expect(copy).toContain('| 任务来源：AI 漫画 |');
    expect(copy).toContain('| ai_comic（AI 漫画任务） |');
  });
});
