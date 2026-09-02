/**
 * AI 漫画 Phase 1.2-C —— 步骤草稿持久化焦点测试（规格 §30/§31/§32/§33/§85）：
 *  - normalizeComicUiDraft：草稿随项目 JSON round-trip 存活、坏一半只丢一半、空不落键；
 *  - §33 Back/Forward 矩阵：三段旅程（故事草稿 / 形式选择 / 角色锁定）在
 *    「切步骤重挂载 = uiDraft 恢复 + 事实归一化」模型下全部保持；
 *  - comicSession：会话恢复读写 / 白名单校验 / 清除（可注入 storage，node 可测）；
 *  - 源守卫：四个 Stage 挂载恢复 + onDraft 写穿 + 页面 handleDraft / session 接线 +
 *    防抖 Hook 卸载冲刷（「切一下 Step 就丢失」结构性为 0）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';
import { clearComicSession, readComicSession, writeComicSession } from '../comicSession';

/** 「刷新」模型：data_json 落盘 → 重开读取 → normalize 恢复（openProject 同路径）。 */
function roundTrip(project: ComicProject): ComicProject {
  const restored = normalizeComicProject(JSON.parse(JSON.stringify(project)));
  expect(restored).not.toBeNull();
  return restored!;
}

function makeProject(): ComicProject {
  const restored = normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: 'story_ready',
    skillSnapshot: normalizeComicSkill({ name: '职场吐槽四格', layout: { arrangement: 'grid_4', panelCount: 4 } }),
    characterSnapshots: [{
      id: 'char-1', name: '汤圆', status: 'locked', appearance: '奶油黄圆脸猫',
      referenceImage: { path: '/refs/char-1.png', label: '汤圆参考图' },
      immutableTraits: ['奶油黄毛色'], mutableTraits: [], negativeConstraints: [],
      source: 'library', role: '主角', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    characterBindings: { hero: 'char-1' },
    story: {
      title: '周一例会', topic: '例会', summary: '又延期', characterIds: ['char-1'],
      beats: ['a', 'b'], endingType: 'twist', panelCount: 4,
    },
    panels: [],
    dialogues: [],
  });
  expect(restored).not.toBeNull();
  return restored!;
}

// ---------------------------------------------------------------------------
// normalizeComicUiDraft：草稿随项目存活
// ---------------------------------------------------------------------------

describe('uiDraft 归一化（§30/§85 草稿落 data_json）', () => {
  test('四类草稿全部随项目 JSON round-trip 存活（刷新后可恢复）', () => {
    const project = makeProject();
    project.uiDraft = {
      story: {
        requirement: '不要励志，改成搞笑一点',
        storyDraft: {
          title: '新故事', topic: '例会', summary: '改了', characterIds: ['char-1'],
          beats: ['x'], endingType: 'punchline', panelCount: 4,
        },
        phase: 'review',
      },
      skill: { instruction: '画风再简单一点' },
      character: { patchTexts: { 'char-1': '耳朵再圆一点' } },
      storyboard: {
        storyDraft: {
          title: '周一例会', topic: '例会', summary: '又延期', characterIds: ['char-1'],
          beats: ['a', 'b'], endingType: 'twist', panelCount: 4,
        },
        panels: [{ id: 'panel-0', order: 0, scene: '开场', characterIds: ['char-1'] } as ComicProject['panels'][number]],
        dialogues: [],
        repairs: ['补齐缺失分镜'],
      },
    };
    const restored = roundTrip(project);
    expect(restored.uiDraft?.story?.requirement).toBe('不要励志，改成搞笑一点');
    expect(restored.uiDraft?.story?.storyDraft?.title).toBe('新故事');
    expect(restored.uiDraft?.story?.phase).toBe('review');
    expect(restored.uiDraft?.skill?.instruction).toBe('画风再简单一点');
    expect(restored.uiDraft?.character?.patchTexts?.['char-1']).toBe('耳朵再圆一点');
    expect(restored.uiDraft?.storyboard?.panels).toHaveLength(1);
    expect(restored.uiDraft?.storyboard?.repairs).toEqual(['补齐缺失分镜']);
  });

  test('坏一半只丢一半：storyboard.panels 混入无 scene 项被过滤，storyDraft 保留', () => {
    const project = makeProject();
    project.uiDraft = {
      storyboard: {
        storyDraft: {
          title: 'T', topic: '', summary: '', characterIds: [], beats: ['b'], endingType: 'twist', panelCount: 4,
        },
        panels: [
          { id: 'bad', order: 0 } as ComicProject['panels'][number],
          { id: 'ok', order: 1, scene: '有效' } as ComicProject['panels'][number],
        ],
      },
    };
    const restored = roundTrip(project);
    expect(restored.uiDraft?.storyboard?.storyDraft?.title).toBe('T');
    expect(restored.uiDraft?.storyboard?.panels?.map(panel => panel.id)).toEqual(['ok']);
  });

  test('空输入不落键：requirement 空串 / patchTexts 空值 → 键剥离；全空 → uiDraft=undefined', () => {
    const project = makeProject();
    project.uiDraft = {
      story: { requirement: '  ' },
      character: { patchTexts: { 'char-1': '', 'char-2': '保留' } },
    };
    const restored = roundTrip(project);
    expect(restored.uiDraft?.story).toBeUndefined();
    expect(restored.uiDraft?.character?.patchTexts).toEqual({ 'char-2': '保留' });

    project.uiDraft = { skill: { instruction: '' } };
    expect(roundTrip(project).uiDraft).toBeUndefined();
  });

  test('phase=review 没有审定草稿时丢弃（review 只在带草稿时有意义）', () => {
    const project = makeProject();
    project.uiDraft = { story: { phase: 'review', requirement: '输入中' } };
    const restored = roundTrip(project);
    expect(restored.uiDraft?.story?.phase).toBeUndefined();
    expect(restored.uiDraft?.story?.requirement).toBe('输入中');
  });

  test('V4.2.5 老项目（无 uiDraft 字段）不报错不落空对象', () => {
    const restored = roundTrip(makeProject());
    expect(restored.uiDraft).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §33 Back/Forward 矩阵（域级：重挂载 = uiDraft 恢复 + 事实归一化）
// ---------------------------------------------------------------------------

describe('§33 Back/Forward：切步骤 / 返回，输入与事实保持', () => {
  test('旅程 1：Step 1 改故事输入一半 → Step 2/3 → 返回 Step 1，需求与审定草稿都在', () => {
    const project = makeProject();
    project.uiDraft = {
      story: {
        requirement: '结尾再反转一点',
        storyDraft: {
          title: '半成品', topic: 't', summary: 's', characterIds: [], beats: ['x'], endingType: 'twist', panelCount: 4,
        },
        phase: 'review',
      },
    };
    // 切步骤 ×2 再回来 = 组件重挂载，初值从 round-trip 后的 uiDraft 取
    const back = roundTrip(roundTrip(project));
    expect(back.uiDraft?.story?.requirement).toBe('结尾再反转一点');
    expect(back.uiDraft?.story?.storyDraft?.title).toBe('半成品');
    expect(back.uiDraft?.story?.phase).toBe('review');
    // 已确认的 story 事实不受草稿影响
    expect(back.story?.title).toBe('周一例会');
  });

  test('旅程 2：选好展示形式 → 去角色演员 → 返回，选择仍在（skill 事实）', () => {
    const project = makeProject();
    // 选形式 = skill 快照事实（presentationPatchFor），不是草稿
    const restored = roundTrip(project);
    expect(restored.skillSnapshot.layout.arrangement).toBe('grid_4');
    expect(restored.skillSnapshot.layout.panelCount).toBe(4);
    expect(restored.story?.title).toBe('周一例会');
  });

  test('旅程 3：角色锁定 → 去故事 → 返回角色，locked / 参考图 / 绑定都保持', () => {
    const project = makeProject();
    project.consistency = {
      characterReferences: [{ characterId: 'char-1', path: '/refs/char-1.png', label: '汤圆参考图' }],
      generationParams: { size: '1024x1024', quality: 'auto', format: 'png' },
    };
    const back = roundTrip(roundTrip(project));
    expect(back.characterSnapshots[0]!.status).toBe('locked');
    expect(back.characterSnapshots[0]!.referenceImage?.path).toBe('/refs/char-1.png');
    expect(back.characterBindings.hero).toBe('char-1');
    expect(back.consistency?.characterReferences).toHaveLength(1);
  });

  test('旅程 4：分镜草稿未应用就切走 → 回来草稿仍可审（repairs 不静默丢失）', () => {
    const project = makeProject();
    project.uiDraft = {
      storyboard: {
        storyDraft: project.story,
        panels: [
          { id: 'panel-0', order: 0, scene: '第一格', characterIds: ['char-1'] } as ComicProject['panels'][number],
          { id: 'panel-1', order: 1, scene: '第二格', characterIds: ['char-1'] } as ComicProject['panels'][number],
        ],
        repairs: ['按四格补齐了缺失分镜'],
      },
    };
    const back = roundTrip(project);
    expect(back.uiDraft?.storyboard?.panels).toHaveLength(2);
    expect(back.uiDraft?.storyboard?.repairs).toEqual(['按四格补齐了缺失分镜']);
    // 未应用前项目事实 panels 不变
    expect(back.panels).toHaveLength(0);
  });

  test('旅程 5：对白与技能微调输入切步骤不丢（dialogues 是事实 / instruction 是草稿）', () => {
    const project = makeProject();
    project.dialogues = [{
      id: 'dlg-1', panelId: 'panel-0', speakerId: 'narrator', type: 'caption',
      text: '周一早晨', position: { x: 0.5, y: 0.1 }, alignment: 'center',
      fontStyle: { size: 16, weight: 500 }, bubbleStyle: 'box',
    }];
    project.uiDraft = { skill: { instruction: '槽位改成只在最后两格出场' } };
    const back = roundTrip(roundTrip(project));
    expect(back.dialogues).toHaveLength(1);
    expect(back.dialogues[0]!.text).toBe('周一早晨');
    expect(back.uiDraft?.skill?.instruction).toBe('槽位改成只在最后两格出场');
  });
});

// ---------------------------------------------------------------------------
// comicSession：会话恢复（§85 刷新回到上次项目 + 步骤）
// ---------------------------------------------------------------------------

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

describe('comicSession（会话级恢复）', () => {
  test('写入 → 读取 round-trip（projectId + viewStep 白名单值）', () => {
    const storage = new MemoryStorage();
    writeComicSession({ projectId: 'p1', viewStep: 'storyboard' }, storage);
    const restored = readComicSession(storage);
    expect(restored?.projectId).toBe('p1');
    expect(restored?.viewStep).toBe('storyboard');
    expect(typeof restored?.savedAt).toBe('string');
  });

  test('非法载荷不炸不恢复：坏 JSON / 未知步骤 / 缺 projectId → null', () => {
    const storage = new MemoryStorage();
    storage.setItem('cyimagepro.comic.session', '{not-json');
    expect(readComicSession(storage)).toBeNull();
    storage.setItem('cyimagepro.comic.session', JSON.stringify({ projectId: 'p1', viewStep: 'nonsense' }));
    expect(readComicSession(storage)).toBeNull();
    storage.setItem('cyimagepro.comic.session', JSON.stringify({ viewStep: 'story' }));
    expect(readComicSession(storage)).toBeNull();
  });

  test('清除后读取为 null；无 storage（node / 隐私模式）读取为 null', () => {
    const storage = new MemoryStorage();
    writeComicSession({ projectId: 'p1', viewStep: 'text' }, storage);
    clearComicSession(storage);
    expect(readComicSession(storage)).toBeNull();
    expect(readComicSession(null)).toBeNull();
    expect(readComicSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 源守卫：挂载恢复 + 写穿接线 + 卸载冲刷（§30/§32/§85 结构保证）
// ---------------------------------------------------------------------------

const page = readFileSync(resolve(__dirname, '../../../pages/ComicStudio.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const storyStage = readFileSync(resolve(__dirname, '../components/ComicStoryStage.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const storyboardStage = readFileSync(resolve(__dirname, '../components/ComicStoryboardStage.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const skillStage = readFileSync(resolve(__dirname, '../components/ComicSkillStage.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const characterStage = readFileSync(resolve(__dirname, '../components/ComicCharacterStage.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const draftHook = readFileSync(resolve(__dirname, '../useComicUiDraft.ts'), 'utf-8').replace(/\r\n/g, '\n');

describe('源守卫：草稿写穿与挂载恢复接线', () => {
  test('页面：handleDraft 只写 uiDraft（不走 deriveComicStage），四个 Stage 都收到 onDraft', () => {
    expect(page).toContain('const handleDraft = useCallback((mutate: (uiDraft: ComicUiDraft) => ComicUiDraft) => {');
    expect(page).toContain('uiDraft: mutate(draft.uiDraft ?? {})');
    expect(page.match(/onDraft=\{handleDraft\}/g)?.length).toBe(4);
  });

  test('页面：会话恢复三件套（读 openProject / 写 session / 关项目清除）+ 刷新前冲刷', () => {
    expect(page).toContain('readComicSession()');
    expect(page).toContain('openProject(restore.projectId)');
    expect(page).toContain('writeComicSession({ projectId: activeProjectId, viewStep })');
    expect(page).toContain('clearComicSession()');
    expect(page).toContain("window.addEventListener('beforeunload', flush)");
    // 恢复中的步骤要过 enterable 校验（事实推进后不可进入的旧步骤回落 currentStep）
    expect(page).toContain('restoredEnterable');
  });

  test('四个 Stage：挂载初值都从 project.uiDraft 恢复，且草稿只经 props.onDraft 写穿', () => {
    expect(storyStage).toContain('project.uiDraft?.story?.requirement');
    expect(storyStage).toContain('project.uiDraft?.story?.phase');
    expect(storyStage).toContain('project.uiDraft?.story?.storyDraft');
    expect(storyStage).toContain('props.onDraft(draft => {');
    expect(storyboardStage).toContain('project.uiDraft?.storyboard');
    expect(storyboardStage).toContain('props.onDraft(draftState => {');
    expect(skillStage).toContain('project.uiDraft?.skill?.instruction');
    expect(skillStage).toContain('props.onDraft(draft => {');
    expect(characterStage).toContain('project.uiDraft?.character?.patchTexts');
    expect(characterStage).toContain('props.onDraft(draft => {');
    // 文字层对白是事实（applyProject 即时持久化），不需要草稿通道
    expect(page).not.toContain('ComicTextStage project={active} onDraft');
  });

  test('防抖 Hook：停顿写穿 + 卸载冲刷（未到期的最后一段输入不丢）', () => {
    expect(draftHook).toContain('COMIC_UI_DRAFT_DELAY_MS = 400');
    expect(draftHook).toContain('卸载冲刷');
    expect(draftHook).toContain('commitRef.current(pending.current)');
  });

  test('§32 Stage Mount 不重置：四个 Stage 的用户输入初值都是 lazy initializer（不做 mount 后 useEffect 覆写）', () => {
    for (const source of [storyStage, storyboardStage, skillStage, characterStage]) {
      // useEffect(() => set<用户输入>('')) 形态的 mount 重置被禁止（thumbnails 等派生缓存不在此列）
      expect(source).not.toMatch(/useEffect\(\(\) => \{\s*set(?:Requirement|Instruction|PatchText|Draft)\(/);
    }
  });
});
