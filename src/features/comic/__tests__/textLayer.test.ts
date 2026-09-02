/**
 * 文字层纯函数测试（Phase 10/11 + V4.2.12）：
 *  - 对白坐标恒归一化 0..1（状态里永不出现像素）；放置/拖动落点统一钳制；
 *  - 画布 Pointer → 归一化换算只在渲染边界（pointerToNormalized）；
 *  - 新建对白默认值来自 Skill textStyle 快照（气泡形态 + dialogueMode）且车道散布、尾巴 auto；
 *  - 说话人候选 = 本格出场角色 + 旁白恒在最后。
 */

import { describe, it, expect } from 'vitest';
import {
  DIALOGUE_BUBBLE_LABELS,
  clampDialoguePosition,
  clampDialogueSize,
  dialogueHasText,
  dialogueSpeakerOptions,
  newDialogueDraft,
  pointerToNormalized,
  visibleDialoguesOfPanel,
} from '../textLayer';
import { normalizeComicCharacter, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicDialogue, ComicDialogueMode, ComicProject } from '../types';

function makeProject(options: { bubbleHint?: string; dialogueMode?: ComicDialogueMode } = {}): ComicProject {
  const skill = normalizeComicSkill({
    name: '吐槽四格',
    comicForm: '四格漫画',
    visualStyle: '简笔粗线',
    textStyle: (options.bubbleHint || options.dialogueMode) ? {
      bubbleStyle: options.bubbleHint ?? '',
      fontHint: '黑体加粗',
      dialogueMode: options.dialogueMode,
    } : undefined,
    characterSlots: [
      { slotId: 'hero', name: '主角', required: true },
      { slotId: 'mate', name: '同事', required: false },
    ],
  });
  const hero = normalizeComicCharacter({ id: 'char-1', name: '汤圆', status: 'confirmed', appearance: '圆脸猫' })!;
  const mate = normalizeComicCharacter({ id: 'char-2', name: '阿蓝', status: 'confirmed', appearance: '高个子同事' })!;
  return normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: 'editing',
    skillSnapshot: skill,
    characterSnapshots: [hero, mate],
    characterBindings: { hero: 'char-1', mate: 'char-2' },
    story: {
      title: 't', topic: 't', summary: 's', characterIds: ['char-1'],
      beats: ['a'], endingType: 'twist', panelCount: 2,
    },
    panels: [
      normalizeComicPanel({
        id: 'panel-0', order: 0, scene: '开场', characterIds: ['char-1', 'char-2'],
        shotType: '全景', camera: '平视', composition: '居中', characterActions: ['a'], background: '工位',
      })!,
      normalizeComicPanel({
        id: 'panel-1', order: 1, scene: '结尾', characterIds: ['char-1'],
        shotType: '近景', camera: '平视', composition: '居中', characterActions: ['b'], background: '茶水间',
      })!,
    ],
    dialogues: [],
  })!;
}

describe('dialogueSpeakerOptions', () => {
  it('候选 = 本格出场角色 + 旁白恒在最后', () => {
    const project = makeProject();
    const options = dialogueSpeakerOptions(project, project.panels[0]!);
    expect(options.map(option => option.id)).toEqual(['char-1', 'char-2', 'narrator']);
    expect(options[0]!.label).toBe('汤圆');
  });

  it('快照里不存在的角色被过滤（不伪造说话人）', () => {
    const project = makeProject();
    const ghost = normalizeComicPanel({
      id: 'panel-x', order: 2, scene: '幽灵格', characterIds: ['char-404'],
      shotType: '全景', camera: '平视', composition: '居中', characterActions: ['a'], background: '虚空',
    })!;
    expect(dialogueSpeakerOptions(project, ghost).map(option => option.id)).toEqual(['narrator']);
  });
});

describe('newDialogueDraft', () => {
  it('默认值来自 Skill textStyle 快照：尖/云/方提示映射对应气泡，缺省圆角', () => {
    expect(newDialogueDraft(makeProject({ bubbleHint: '尖角爆炸气泡' }), 'panel-0', 0).bubbleStyle).toBe('spiky');
    expect(newDialogueDraft(makeProject({ bubbleHint: '云朵思考气泡' }), 'panel-0', 0).bubbleStyle).toBe('cloud');
    // Bubble Library V2：方框提示 → 方形对白框 rect（box = 深底旁白框，语义不同）
    expect(newDialogueDraft(makeProject({ bubbleHint: '方框字幕' }), 'panel-0', 0).bubbleStyle).toBe('rect');
    expect(newDialogueDraft(makeProject(), 'panel-0', 0).bubbleStyle).toBe('rounded');
  });

  it('坐标车道散布且恒在 0..1（状态无像素）', () => {
    const project = makeProject();
    for (let seed = 0; seed < 6; seed += 1) {
      const draft = newDialogueDraft(project, 'panel-0', seed);
      expect(draft.position.x).toBeGreaterThan(0);
      expect(draft.position.x).toBeLessThanOrEqual(1);
      expect(draft.position.y).toBeGreaterThan(0);
      expect(draft.position.y).toBeLessThanOrEqual(1);
      expect(draft.panelId).toBe('panel-0');
    }
    // 车道轮转：第 3 条回到第 1 车道、下沉一行
    expect(newDialogueDraft(project, 'panel-0', 0).position.x).toBeCloseTo(0.32);
    expect(newDialogueDraft(project, 'panel-0', 3).position.x).toBeCloseTo(0.32);
    expect(newDialogueDraft(project, 'panel-0', 3).position.y).toBeGreaterThan(
      newDialogueDraft(project, 'panel-0', 0).position.y,
    );
  });

  it('字体默认 16 / 500，说话人默认旁白；尾巴默认 auto（V4.2.12）', () => {
    const draft = newDialogueDraft(makeProject(), 'panel-1', 0);
    expect(draft.fontStyle.size).toBe(16);
    expect(draft.fontStyle.weight).toBe(500);
    expect(draft.speakerId).toBe('narrator');
    expect(draft.text).toBe('');
    expect(draft.tail).toBe('auto');
    expect(draft.size).toBeUndefined();
  });

  it('项目级 dialogueMode 是每条新对白的默认呈现（§69/§71）：narration→旁白框 / none→无气泡 / subtitle→底部', () => {
    // Bubble Library V2 口径：narration → 白底旁白框 box-light；none → 无框纯文字 plain
    expect(newDialogueDraft(makeProject({ dialogueMode: 'narration' }), 'panel-0', 0)).toMatchObject({
      bubbleStyle: 'box-light', type: 'caption',
    });
    expect(newDialogueDraft(makeProject({ dialogueMode: 'none' }), 'panel-0', 0)).toMatchObject({
      bubbleStyle: 'plain', type: 'speech',
    });
    const subtitle = newDialogueDraft(makeProject({ dialogueMode: 'subtitle' }), 'panel-0', 0);
    expect(subtitle.bubbleStyle).toBe('subtitle-bar');
    expect(subtitle.type).toBe('subtitle');
    expect(subtitle.position.y).toBeGreaterThan(0.7);
  });
});

describe('画布放置 / 拖动 / 缩放的落点钳制（V4.2.12）', () => {
  it('clampDialoguePosition：越界点拉回安全范围，界内点原样', () => {
    expect(clampDialoguePosition({ x: -0.4, y: 2 })).toEqual({ x: 0.06, y: 0.94 });
    expect(clampDialoguePosition({ x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it('clampDialogueSize：宽高限制在 0.14..0.92', () => {
    expect(clampDialogueSize({ width: 0.01, height: 3 })).toEqual({ width: 0.14, height: 0.92 });
    expect(clampDialogueSize({ width: 0.5, height: 0.2 })).toEqual({ width: 0.5, height: 0.2 });
  });

  it('pointerToNormalized：client 坐标 → 归一化（0 尺寸画布回落中点不产 NaN）', () => {
    expect(pointerToNormalized({ left: 100, top: 50, width: 400, height: 200 }, 300, 150)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointerToNormalized({ left: 0, top: 0, width: 200, height: 100 }, 50, 25)).toEqual({ x: 0.25, y: 0.25 });
    expect(pointerToNormalized({ left: 0, top: 0, width: 0, height: 0 }, 50, 25)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('对白可见性', () => {
  it('空白对白不算文本、不进可见列表', () => {
    const project = makeProject();
    const dialogues: ComicDialogue[] = [
      { ...newDialogueDraft(project, 'panel-0', 0), text: '有内容' },
      { ...newDialogueDraft(project, 'panel-0', 1), text: '   \n  ' },
      { ...newDialogueDraft(project, 'panel-1', 0), text: '另一格' },
    ];
    const withDialogues = { ...project, dialogues };
    expect(dialogueHasText(dialogues[0]!)).toBe(true);
    expect(dialogueHasText(dialogues[1]!)).toBe(false);
    expect(visibleDialoguesOfPanel(withDialogues, 'panel-0')).toHaveLength(1);
    expect(visibleDialoguesOfPanel(withDialogues, 'panel-1')).toHaveLength(1);
    expect(visibleDialoguesOfPanel(withDialogues, 'panel-404')).toHaveLength(0);
  });
});

describe('标签表完整性', () => {
  it('气泡标签覆盖全部十六类形态 + legacy none 别名（Bubble Library V2，与注册表同源）', () => {
    // 标签表由注册表派生（Object.fromEntries）+ none 别名补齐，逐类对齐防漂移
    expect(Object.keys(DIALOGUE_BUBBLE_LABELS).sort()).toEqual([
      'box', 'box-light', 'cloud', 'cloud-talk', 'hand', 'none', 'plain',
      'rect', 'rounded', 'sharp', 'soft', 'spiky', 'stroke-black',
      'stroke-white', 'subtitle-bar', 'title-bar', 'whisper',
    ]);
    expect(DIALOGUE_BUBBLE_LABELS.none).toBe('黑字白描边'); // legacy none = stroke-black 别名同标签
  });
});
