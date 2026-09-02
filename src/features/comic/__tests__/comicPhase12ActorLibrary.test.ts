/**
 * AI 漫画 Phase 1.2-E —— 演员库闭环焦点测试（规格 §17~§27）：
 *  - domain：入库条目剥离过期标记 / 库→项目深拷贝剥离计数 / 引用即计数（§18/§19/§21）；
 *  - normalize：usageCount / lastUsedAt 随文档存活（clamp、不捏造时间戳）；
 *  - 源守卫：§22 三入口、§23 空态、§24 弹窗字段、§26 卡片动作、§27 双锁定选项与 toast、
 *    §25 图片只引用不复制，以及页面 store 接线。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  bumpComicCharacterUsage,
  comicCharacterFromLibrary,
  comicCharacterToLibraryEntry,
} from '../domain';
import { normalizeComicCharacter, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicCharacter, ComicProject } from '../types';

function makeCharacter(overrides: Record<string, unknown> = {}): ComicCharacter {
  const character = normalizeComicCharacter({
    id: 'char-1', name: '汤圆', role: '主角', status: 'confirmed',
    immutableTraits: ['奶油黄毛色'], ...overrides,
  });
  if (!character) throw new Error('test fixture broken');
  return character;
}

function makeProject(): ComicProject {
  const restored = normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: 'story_ready',
    skillSnapshot: normalizeComicSkill({ name: '职场吐槽四格', layout: { arrangement: 'grid_4', panelCount: 4 } }),
    characterSnapshots: [],
    characterBindings: {},
    story: {
      title: '周一例会', topic: '例会', summary: '又延期', characterIds: [],
      beats: ['a'], endingType: 'twist', panelCount: 4,
    },
    panels: [],
    dialogues: [],
  });
  expect(restored).not.toBeNull();
  return restored!;
}

// ---------------------------------------------------------------------------
// domain：入库 / 复用 / 计数（§18/§19/§21）
// ---------------------------------------------------------------------------

describe('§19 入库条目（comicCharacterToLibraryEntry）', () => {
  test('剥离项目会话语义（referenceStale），刷新 updatedAt；其余事实原样', () => {
    const stale = makeCharacter({ referenceStale: true });
    const entry = comicCharacterToLibraryEntry(stale);
    expect(entry.referenceStale).toBeUndefined();
    expect(entry.name).toBe('汤圆');
    expect(entry.immutableTraits).toEqual(['奶油黄毛色']);
    expect(entry.updatedAt >= stale.updatedAt).toBe(true);
  });

  test('入库不回写项目：源对象保持不变（§20 快照规则）', () => {
    const project = makeProject();
    const character = makeCharacter({ referenceStale: true });
    comicCharacterToLibraryEntry(character);
    expect(character.referenceStale).toBe(true);
    expect(project.characterSnapshots).toHaveLength(0);
  });
});

describe('§21 库条目 → 项目快照（comicCharacterFromLibrary）', () => {
  test('深拷贝：事后改库 / 改快照互不影响；库计数不随快照进项目', () => {
    const entry = makeCharacter({ usageCount: 7, lastUsedAt: '2026-08-30T00:00:00.000Z' });
    const snapshot = comicCharacterFromLibrary(entry);
    expect(snapshot.usageCount).toBeUndefined();
    expect(snapshot.lastUsedAt).toBeUndefined();
    expect(snapshot.immutableTraits).toEqual(['奶油黄毛色']);
    snapshot.immutableTraits.push('后来加的');
    expect(entry.immutableTraits).toEqual(['奶油黄毛色']);
    entry.name = '库里改名';
    expect(snapshot.name).toBe('汤圆');
  });
});

describe('§18 引用即计数（bumpComicCharacterUsage）', () => {
  test('0 → 1 → 2；lastUsedAt / updatedAt 刷新为传入时刻', () => {
    const once = bumpComicCharacterUsage(makeCharacter(), '2026-09-01T08:00:00.000Z');
    expect(once.usageCount).toBe(1);
    expect(once.lastUsedAt).toBe('2026-09-01T08:00:00.000Z');
    const twice = bumpComicCharacterUsage(once, '2026-09-01T09:00:00.000Z');
    expect(twice.usageCount).toBe(2);
    expect(twice.lastUsedAt).toBe('2026-09-01T09:00:00.000Z');
  });

  test('封顶 99999（防脏数据溢出）', () => {
    const capped = bumpComicCharacterUsage(makeCharacter({ usageCount: 99999 }));
    expect(capped.usageCount).toBe(99999);
  });
});

// ---------------------------------------------------------------------------
// normalize：库元数据随文档存活（§18；不捏造时间戳）
// ---------------------------------------------------------------------------

describe('normalizeComicCharacter 库元数据', () => {
  test('usageCount / lastUsedAt round-trip 存活并 clamp 负数与小数', () => {
    const restored = makeCharacter({ usageCount: 12, lastUsedAt: '2026-08-31T10:00:00.000Z' });
    expect(restored.usageCount).toBe(12);
    expect(restored.lastUsedAt).toBe('2026-08-31T10:00:00.000Z');
    expect(makeCharacter({ usageCount: -3 }).usageCount).toBeUndefined();
    expect(makeCharacter({ usageCount: 2.7 }).usageCount).toBe(2);
  });

  test('无库元数据的旧文档：不捏造 lastUsedAt（区别于 createdAt 缺省）', () => {
    const legacy = makeCharacter();
    expect(legacy.usageCount).toBeUndefined();
    expect(legacy.lastUsedAt).toBeUndefined();
    expect(legacy.createdAt).not.toBe('');
  });

  test('项目快照携带库元数据 round-trip 不丢（打开项目恢复路径）', () => {
    const project = makeProject();
    project.characterSnapshots = [makeCharacter({ usageCount: 3, lastUsedAt: '2026-08-30T00:00:00.000Z' })];
    const restored = normalizeComicProject(JSON.parse(JSON.stringify(project)))!;
    expect(restored.characterSnapshots[0]!.usageCount).toBe(3);
    expect(restored.characterSnapshots[0]!.lastUsedAt).toBe('2026-08-30T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// 源守卫：Stage / 弹窗 / 页面接线（§22~§27）
// ---------------------------------------------------------------------------

const stage = readFileSync(
  resolve(__dirname, '../components/ComicCharacterStage.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const libraryDialog = readFileSync(
  resolve(__dirname, '../components/ComicActorLibraryDialog.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const draftDialog = readFileSync(
  resolve(__dirname, '../components/ComicActorDraftDialog.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const page = readFileSync(resolve(__dirname, '../../../pages/ComicStudio.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const copy = readFileSync(
  resolve(__dirname, '../../../../.claude/skills/cyimagepro-ui/copy.md'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('§22 演员库三个添加入口', () => {
  test('A. 卡片 [保存到演员库]：参考图存在即出现，走 comicCharacterToLibraryEntry + props.onSaveToLibrary', () => {
    expect(stage).toContain('character.referenceImage && (');
    expect(stage).toContain('保存到演员库');
    expect(stage).toContain('props.onSaveToLibrary(comicCharacterToLibraryEntry(character))');
  });

  test('B/C. [从图库添加演员]（ImageLibraryPicker library-add 意图）+ [上传演员参考图]（selectImageFile → 导入管道 → 草稿弹窗）', () => {
    expect(stage).toContain("title=\"从图库添加演员\"");
    expect(stage).toContain("kind: 'library-add'");
    expect(stage).toContain('api.selectImageFile()');
    expect(stage).toContain('api.importImagesToLibrary([path])');
    expect(stage).toContain("source: 'upload'");
    expect(draftDialog).toContain('保存到演员库');
    expect(draftDialog).toContain('一句话设定（可选）');
  });

  test('§25 图片只引用：库草稿 / 换参考图都带 assetId+path 引用，无二进制复制调用', () => {
    expect(stage).toContain('<ComicActorDraftDialog'); // 草稿弹窗由图片引用构成
    expect(stage).not.toContain('readImageData');
    expect(stage).not.toContain('saveChatImage');
  });
});

describe('§23 空态与 §24 弹窗', () => {
  test('空态文案 + 三个行动入口 + [保存当前〈名〉到演员库]', () => {
    expect(libraryDialog).toContain('还没有保存过演员。你可以：');
    expect(libraryDialog).toContain('AI 创建一个');
    expect(libraryDialog).toContain('从图库添加');
    expect(libraryDialog).toContain('上传参考图');
    expect(libraryDialog).toContain('保存当前{props.savableCharacterName}到演员库');
    expect(stage).toContain("lockedCharacter?.name ?? null");
  });

  test('§24 弹窗字段：搜索 / 分类（全部·AI 创建·上传·图库）/ 缩略图 / 来源 / 最近使用 / 选择', () => {
    expect(libraryDialog).toContain('搜索名称或角色定位');
    expect(libraryDialog).toContain("'全部'");
    expect(libraryDialog).toContain("'AI 创建'");
    expect(libraryDialog).toContain("'上传'");
    expect(libraryDialog).toContain("'图库'");
    expect(libraryDialog).toContain('api.readThumbnail(path)');
    expect(libraryDialog).toContain('来源：{sourceLabel(item.source)}');
    expect(libraryDialog).toContain('用过 ${count} 次');
    expect(libraryDialog).toContain('选择');
    // browse 模式（§27 [查看演员库]）只看不选
    expect(libraryDialog).toContain("props.mode === 'select'");
  });

  test('旧内联列表已移除（§17 反例：空库一行灰字 + 无入口）', () => {
    expect(stage).not.toContain('comic-library-row');
    expect(stage).not.toContain('演员库还是空的');
    expect(stage).not.toContain('setLibrarySlotId');
  });
});

describe('§19/§26/§27 锁定单 Primary + 入库复选项（V4.2.10）与卡片动作', () => {
  test('[确认并锁定] × 复选项「保存到演员库，方便以后复用」（默认勾选）= 入库与否的唯一开关', () => {
    // V4.2.10 §九：锁定调用只读 savePrefs 复选项，不再并列两个 tryLock 按钮
    expect(stage).toContain('void tryLock(character, savePref)');
    expect(stage).toContain('保存到演员库，方便以后复用');
    expect(stage).toContain('const [savePrefs, setSavePrefs] = useState<Record<string, boolean>>({})');
    expect(stage).toContain('savePrefs[character.id] ?? true');
    expect(stage).toContain('不勾选则仅本项目锁定');
    expect(stage).toContain('仅本项目锁定');
  });

  test('入库 toast 带查看演员库；未勾选 toast 仅本项目；锁定去向两态回显', () => {
    expect(stage).toContain('已锁定，并已保存到演员库');
    expect(stage).toContain("'查看演员库'");
    expect(stage).toContain("setLibraryView({ mode: 'browse' })");
    expect(stage).toContain('已锁定，仅用于当前漫画。');
    // §十：已锁定 · 已保存演员库 / 已锁定 · 仅本项目（lockedSaved 会话事实）
    expect(stage).toContain('const [lockedSaved, setLockedSaved] = useState<Record<string, boolean>>({})');
    expect(stage).toContain('· 已保存演员库');
    expect(stage).toContain('· 仅本项目');
  });

  test('§21 选角走 comicCharacterFromLibrary + onRecordUsage（快照隔离 + 引用即计数）', () => {
    expect(stage).toContain('const character = comicCharacterFromLibrary(loaded)');
    expect(stage).toContain('props.onRecordUsage(item.id)');
  });

  test('§16 参考图来源分层：来源标签（AI 生成 / 图库 / 上传 / 本地文件）+ 资产 ID', () => {
    expect(stage).toContain('function refSourceLabel');
    expect(stage).toContain('来源：{refSourceLabel(character.referenceImage)}');
    expect(stage).toContain('资产 ${character.referenceImage.assetId.slice(0, 8)}');
  });
});

describe('页面接线（store 闭环）', () => {
  test('onSaveToLibrary / onRecordUsage 都接线到 store 动作', () => {
    expect(page).toContain('const handleSaveCharacterToLibrary = useCallback(');
    expect(page).toContain('useComicStore.getState().saveCharacter(comicCharacterToLibraryEntry(character))');
    expect(page).toContain('const handleRecordCharacterUsage = useCallback((id: string) => {');
    expect(page).toContain('useComicStore.getState().recordCharacterUsage(id)');
    expect(page).toContain('onSaveToLibrary={handleSaveCharacterToLibrary}');
    expect(page).toContain('onRecordUsage={handleRecordCharacterUsage}');
  });

  test('copy.md：Phase 1.2-E 术语已登记', () => {
    for (const term of ['仅本项目锁定', '保存到演员库', '从图库添加演员', '上传演员参考图', '查看演员库', 'AI 创建一个']) {
      expect(copy).toContain(term);
    }
  });
});
