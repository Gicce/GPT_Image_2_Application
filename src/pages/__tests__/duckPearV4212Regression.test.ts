/**
 * 《鸭梨山大 · 第一期》V4.2.12 回归（§81~§86/§111/§118）——**非 Gated**：
 * 项目夹具按 V4.2.11 E2E 的真实落库形状内嵌（4 张 Panel 成图 + Final Page +
 * 5 条对白 + 自定义 promptTemplate），复用既有 Final 资产，绝不调用真实 Image2
 * （禁 V4211_E2E=1、禁重新生图、禁覆盖已成功生成的 4 张 Panel 和 Final Page）。
 *
 * 覆盖的金路径：
 *  A. V4.2.11 旧数据兼容：normalize 后 5 条对白 / panelId 绑定 / imageAsset /
 *     finalPages 全部无损；旧形状缺 tail/size/family → 安全默认（tail=auto）；
 *  B. Text E2E：Panel1 对白(经典) / Panel2 旁白框 / Panel3 无气泡文字 /
 *     Panel4 思考气泡 —— 全部 upsertDialogue，图片资产引用零变化（零 Image2）；
 *  C. Storyboard order E2E：完成顺序 3,1,4,2 回放 → Composer 仍是 1,2,3,4；
 *     手动重排只改 order，资产 / 对白绑定原样；
 *  D. Prompt E2E：4 格重编译有场景段 + 核心事件 + 单格铁律，无页面级形式词，
 *     对白文本永不进图片 Prompt；
 *  E. 持久化往返：bubbleStyle / tail / family / size 存得进、读得回。
 */

import { describe, it, expect } from 'vitest';
import { comicPanelsByOrder, moveProjectPanel, upsertDialogue } from '../../features/comic/domain';
import { applyComicTaskResults } from '../../features/comic/generation';
import { compilePanelPrompt } from '../../features/comic/promptCompiler';
import { computePageLayouts } from '../../features/comic/comicExport';
import { resolveBubbleTail } from '../../features/comic/bubbleShape';
import { visibleDialoguesOfPanel } from '../../features/comic/textLayer';
import { normalizeComicProject } from '../../features/comic/normalize';
import type { ComicProject } from '../../features/comic/types';
import type { ImageRecord, SubTask, Task, TaskBatchItem } from '../../types';

// ---------------------------------------------------------------------------
// 内嵌夹具（真实落库形状的字段子集；id / imageId 为真实值）
// ---------------------------------------------------------------------------

const DUCKLING = 'b26c3f86-7c72-4f17-b635-c21360192f83'; // 小圆鸭
const DUCK_MOM = '5efcb13f-692a-484b-a52e-497df43d6b8a'; // 鸭妈妈
const DUCK_TEACHER = '0009259d-bcf7-4d00-87e5-b66a67406e48'; // 鸭老师

const PANEL_IMAGE_IDS = [
  'c29c94a6-0bcb-4e0a-8ea1-5d7f9651abfa',
  '8752ce43-de18-4a54-afe8-a27b6d7539eb',
  '53d560a2-b276-4c8b-89b8-33cfd41c4984',
  'bdcc909c-f08b-454c-ade5-51c9dd232204',
] as const;

const FINAL_PAGE_IMAGE_ID = 'ca1890dc-0ee8-4ac7-ba58-2a23bec561b1';
const FINAL_PAGE_PATH = 'D:/Image2图库/AI漫画 · 《小鸭变鸭梨》 · 鸭梨山大 · 第一期.png';

const RAW_PROJECT = {
  id: '2761e3d3-9643-4537-bddf-99602d5c6d50',
  name: '鸭梨山大 · 第一期',
  stage: 'editing',
  skillSnapshot: {
    name: '萌鸭四格',
    visualStyle: '萌系简笔：圆润粗线条，干净留白',
    comicForm: '四格漫画',
    // 鸭梨山大快照事实：promptTemplate 自定义（非默认模板）
    promptTemplate: '萌系简笔单格画面：{{panel.scene}}；动作：{{panel.characterActions}}；镜头：{{panel.shotType}}',
    layout: { panelCount: 4, arrangement: 'grid_4' },
    textStyle: { bubbleStyle: '圆润对话气泡', fontHint: '黑体加粗', dialogueMode: 'bubble' },
    generationRules: { negativeConstraints: ['乱码文字', '水印'], environmentTextAllowed: false },
    exportDefaults: { canvasRatio: '1:1', background: '#ffffff' },
    characterSlots: [
      { slotId: 'duckling', name: '小圆鸭', characterKey: 'main_duck', required: true },
      { slotId: 'duckMom', name: '鸭妈妈', characterKey: 'duck_mom', required: false },
      { slotId: 'duckTeacher', name: '鸭老师', characterKey: 'duck_teacher', required: false },
    ],
  },
  characterSnapshots: [
    {
      id: DUCKLING, name: '小圆鸭', role: '主角', status: 'locked',
      appearance: '黄色小圆鸭，肚子微凸', immutableTraits: ['黄色绒毛', '圆脸', '橙色小嘴'],
      referenceImage: { path: 'D:/Image2图库/小圆鸭-参考.png', label: '小圆鸭 · 角色参考' },
    },
    {
      id: DUCK_MOM, name: '鸭妈妈', role: '母亲', status: 'locked',
      appearance: '白色大鸭，戴围裙', immutableTraits: ['白色羽毛', '围裙'],
      referenceImage: { path: 'D:/Image2图库/鸭妈妈-参考.png', label: '鸭妈妈 · 角色参考' },
    },
    {
      id: DUCK_TEACHER, name: '鸭老师', role: '老师', status: 'locked',
      appearance: '灰鸭，戴眼镜', immutableTraits: ['灰羽', '圆眼镜'],
      referenceImage: { path: 'D:/Image2图库/鸭老师-参考.png', label: '鸭老师 · 角色参考' },
    },
  ],
  characterBindings: { duckling: DUCKLING, duckMom: DUCK_MOM, duckTeacher: DUCK_TEACHER },
  story: {
    title: '小鸭变鸭梨',
    topic: '课业压力',
    summary: '小圆鸭功课太多越愁越圆，最后发现自己长成了一颗鸭梨。',
    characterIds: [DUCKLING],
    beats: [
      '开学第一天：鸭妈妈送小圆鸭上学',
      '课程排满：课表排得满满当当',
      '越愁越圆：趴在课桌前发愁',
      '镜前鸭梨：发现自己长得像颗梨',
    ],
    endingType: 'punchline',
    panelCount: 4,
  },
  panels: [
    {
      id: 'panel-0', order: 0,
      scene: '开学第一天：鸭妈妈送小圆鸭上学，小圆鸭背着几乎和自己一样大的书包',
      characterIds: [DUCKLING, DUCK_MOM],
      shotType: '中景', camera: '平视', composition: '居中', background: '',
      characterActions: [], characterExpressions: [],
      generationStatus: 'completed', compiledPrompt: 'frozen-panel-0',
      imageAsset: { path: 'D:/Image2图库/panel-0.png', imageId: PANEL_IMAGE_IDS[0], taskId: 'task-panels-4211' },
    },
    {
      id: 'panel-1', order: 1,
      scene: '课程排满：鸭老师把排满课程的课表递给小圆鸭',
      characterIds: [DUCKLING, DUCK_TEACHER],
      shotType: '中景', camera: '平视', composition: '居中', background: '',
      characterActions: [], characterExpressions: [],
      generationStatus: 'completed', compiledPrompt: 'frozen-panel-1',
      imageAsset: { path: 'D:/Image2图库/panel-1.png', imageId: PANEL_IMAGE_IDS[1], taskId: 'task-panels-4211' },
    },
    {
      id: 'panel-2', order: 2,
      scene: '越愁越圆：小圆鸭趴在书桌前发愁，肚子一天比一天圆',
      characterIds: [DUCKLING],
      shotType: '中景', camera: '平视', composition: '居中', background: '',
      characterActions: [], characterExpressions: [],
      generationStatus: 'completed', compiledPrompt: 'frozen-panel-2',
      imageAsset: { path: 'D:/Image2图库/panel-2.png', imageId: PANEL_IMAGE_IDS[2], taskId: 'task-panels-4211' },
    },
    {
      id: 'panel-3', order: 3,
      scene: '镜前鸭梨：小圆鸭站在穿衣镜前，发现自己长得像颗梨',
      characterIds: [DUCKLING, DUCK_MOM],
      shotType: '中景', camera: '平视', composition: '居中', background: '',
      characterActions: [], characterExpressions: [],
      generationStatus: 'completed', compiledPrompt: 'frozen-panel-3',
      imageAsset: { path: 'D:/Image2图库/panel-3.png', imageId: PANEL_IMAGE_IDS[3], taskId: 'task-panels-4211' },
    },
  ],
  // V4.2.11 形状：无 tail / size / family（e2e-dlg-1 带旧 fontStyle size/weight）
  dialogues: [
    {
      id: 'e2e-dlg-1', panelId: 'panel-0', speakerId: DUCK_MOM, type: 'speech',
      text: '妈妈，功课好多呀……（终稿）', position: { x: 0.36, y: 0.14 }, alignment: 'center',
      fontStyle: { size: 22, weight: 500 }, bubbleStyle: 'none',
    },
    {
      id: 'e2e-dlg-2', panelId: 'panel-1', speakerId: DUCK_TEACHER, type: 'speech',
      text: '鸭老师，今天的课表又满啦？', position: { x: 1, y: 0 }, alignment: 'center',
      fontStyle: { size: 16, weight: 500 }, bubbleStyle: 'rounded',
    },
    {
      id: 'e2e-dlg-3', panelId: 'panel-2', speakerId: DUCKLING, type: 'speech',
      text: '肚子怎么越来越圆了……', position: { x: 1, y: 1 }, alignment: 'center',
      fontStyle: { size: 16, weight: 500 }, bubbleStyle: 'rounded',
    },
    {
      id: 'e2e-dlg-4', panelId: 'panel-3', speakerId: DUCK_MOM, type: 'speech',
      text: '妈妈，我怎么长得像颗梨？', position: { x: 1, y: 0 }, alignment: 'center',
      fontStyle: { size: 16, weight: 500 }, bubbleStyle: 'rounded',
    },
    {
      id: 'e2e-dlg-caption', panelId: 'panel-3', speakerId: 'narrator', type: 'thought',
      text: '这叫鸭梨，谁长大都得背上一点。', position: { x: 0, y: 0 }, alignment: 'center',
      fontStyle: { size: 14, weight: 500 }, bubbleStyle: 'box',
    },
  ],
  finalPages: [
    {
      page: 0, path: FINAL_PAGE_PATH, imageId: FINAL_PAGE_IMAGE_ID,
      panelIds: ['panel-0', 'panel-1', 'panel-2', 'panel-3'],
      composedAt: '2026-08-30T12:00:00Z',
    },
  ],
};

function loadProject(): ComicProject {
  const project = normalizeComicProject(RAW_PROJECT);
  expect(project).not.toBeNull();
  return project!;
}

/** 生成时间线回放用：去掉成图状态（模拟分镜刚规划完的瞬间，绝不碰真实资产）。 */
function pristineCopy(project: ComicProject): ComicProject {
  return normalizeComicProject({
    ...project,
    panels: project.panels.map(panel => ({ ...panel, generationStatus: 'pending', imageAsset: undefined })),
  })!;
}

function imageRecordsFor(project: ComicProject): ImageRecord[] {
  return project.panels.map(panel => ({
    id: panel.imageAsset!.imageId,
    task_id: 'task-panels-4211',
    local_path: panel.imageAsset!.path,
    file_name: `${panel.id}.png`,
    created_at: '2026-08-30T11:00:00Z',
    status: 'saved',
    source_kind: 'output' as const,
  }));
}

describe('A. V4.2.11 旧数据兼容（§79/§80）', () => {
  it('5 条对白全部存活：panelId 绑定 / 说话人 / 文本 / 位置原样', () => {
    const project = loadProject();
    expect(project.dialogues).toHaveLength(5);
    expect(project.dialogues.map(dialogue => dialogue.panelId)).toEqual([
      'panel-0', 'panel-1', 'panel-2', 'panel-3', 'panel-3',
    ]);
    expect(project.dialogues.find(dialogue => dialogue.id === 'e2e-dlg-1')!.text).toContain('（终稿）');
    expect(project.dialogues.find(dialogue => dialogue.id === 'e2e-dlg-caption')!.speakerId).toBe('narrator');
  });

  it('旧形状缺 tail → 安全默认 auto；size / family 保持 undefined（内容自适应 + 默认栈）', () => {
    const project = loadProject();
    for (const dialogue of project.dialogues) {
      expect(dialogue.tail).toBe('auto');
      expect(dialogue.size).toBeUndefined();
      expect(dialogue.fontStyle.family).toBeUndefined();
    }
    // 旧 fontStyle 数值保留
    expect(project.dialogues[0]!.fontStyle.size).toBe(22);
  });

  it('4 张 Panel 成图 + Final Page 无损（禁止覆盖的既有资产）', () => {
    const project = loadProject();
    expect(comicPanelsByOrder(project).map(panel => panel.imageAsset!.imageId)).toEqual([...PANEL_IMAGE_IDS]);
    expect(project.finalPages).toHaveLength(1);
    expect(project.finalPages![0]).toMatchObject({
      imageId: FINAL_PAGE_IMAGE_ID, path: FINAL_PAGE_PATH,
      panelIds: ['panel-0', 'panel-1', 'panel-2', 'panel-3'],
    });
    expect(project.panels.every(panel => panel.compiledPrompt === `frozen-${panel.id}`)).toBe(true);
  });
});

describe('B. Text E2E（§81/§82）：四种气泡形态 · 零 Image2', () => {
  it('Panel1 经典对白 / Panel2 旁白框 / Panel3 无气泡文字 / Panel4 思考气泡（upsert 全链）', () => {
    const project = loadProject();
    const byId = (id: string) => project.dialogues.find(dialogue => dialogue.id === id)!;

    let next = upsertDialogue(project, { ...byId('e2e-dlg-1'), bubbleStyle: 'rounded', tail: 'bottom-left' });
    next = upsertDialogue(next, { ...byId('e2e-dlg-2'), type: 'caption', bubbleStyle: 'box' });
    next = upsertDialogue(next, { ...byId('e2e-dlg-3'), bubbleStyle: 'none' });
    next = upsertDialogue(next, { ...byId('e2e-dlg-4'), type: 'thought', bubbleStyle: 'cloud', tail: 'auto' });

    const styleOf = (id: string) => next.dialogues.find(dialogue => dialogue.id === id)!.bubbleStyle;
    expect(styleOf('e2e-dlg-1')).toBe('rounded');
    expect(styleOf('e2e-dlg-2')).toBe('box');
    expect(styleOf('e2e-dlg-3')).toBe('none');
    expect(styleOf('e2e-dlg-4')).toBe('cloud');

    // 尾巴语义：思考气泡有尾（auto 按位置解析）；无气泡文字 / 旁白框无尾
    const thought = next.dialogues.find(dialogue => dialogue.id === 'e2e-dlg-4')!;
    expect(resolveBubbleTail(thought)).not.toBeNull();
    expect(resolveBubbleTail(next.dialogues.find(dialogue => dialogue.id === 'e2e-dlg-3')!)).toBeNull();
    expect(resolveBubbleTail(next.dialogues.find(dialogue => dialogue.id === 'e2e-dlg-2')!)).toBeNull();

    // 每格可见对白仍各就各位
    expect(visibleDialoguesOfPanel(next, 'panel-0')).toHaveLength(1);
    expect(visibleDialoguesOfPanel(next, 'panel-3')).toHaveLength(2);
  });

  it('零 Image2：对白编辑结构上不碰图片层（panels 引用不变 + 资产原样）', () => {
    const project = loadProject();
    const target = project.dialogues[0]!;
    const next = upsertDialogue(project, { ...target, text: '妈妈，功课好多呀……（V4.2.12 终稿）' });
    expect(next.panels).toBe(project.panels); // 同一引用：图片层零触碰
    expect(next.finalPages).toBe(project.finalPages);
    expect(comicPanelsByOrder(next).every(panel => panel.imageAsset!.imageId !== '')).toBe(true);
  });
});

describe('C. Storyboard order E2E（§84/§85）', () => {
  it('完成顺序 3,1,4,2 回放 → Composer 阅读序仍是 1,2,3,4，各格拿自己的图', () => {
    const project = loadProject();
    const pristine = pristineCopy(project);
    const images = imageRecordsFor(project);
    // batch_items / sub_tasks 按完成顺序排列：第3格、第1格、第4格、第2格先完成
    const completionOrder = ['panel-2', 'panel-0', 'panel-3', 'panel-1'];
    const task: Task = {
      id: 'task-panels-4211',
      prompt: 'p', negative_prompt: '',
      size: '1024x1024', quality: 'auto', output_format: 'png', count: 4,
      status: 'completed', created_at: '2026-08-30T10:00:00Z', output_dir: 'D:/Image2图库',
      success_count: 4, failed_count: 0,
      task_type: 'edit', source_images: [],
      sub_tasks: completionOrder.map((panelId, index) => ({
        index,
        status: 'completed',
        image_id: project.panels.find(panel => panel.id === panelId)!.imageAsset!.imageId,
        error: null,
      })) as SubTask[],
      batch_items: completionOrder.map((panelId, index) => ({
        id: `item-${index}`, label: `第 ${index + 1} 槽`, prompt_delta: '',
        variables: { panelId },
      })) as TaskBatchItem[],
      execution_snapshot: {
        prompt_deltas: [], batch_items: [],
        comic: { projectId: project.id, kind: 'panels' },
      } as unknown as Task['execution_snapshot'],
    };

    const applied = applyComicTaskResults(pristine, task, images);
    expect(applied.imagesApplied).toBe(4);
    const slots = computePageLayouts(applied.project)[0]!.slots;
    expect(slots.map(slot => slot.panelId)).toEqual(['panel-0', 'panel-1', 'panel-2', 'panel-3']);
    for (const panel of comicPanelsByOrder(applied.project)) {
      expect(panel.imageAsset!.imageId).toBe(PANEL_IMAGE_IDS[panel.order]);
    }
  });

  it('手动重排（第4格上移两次到第2位）→ 布局跟随，资产 / 冻结 Prompt / 对白绑定原样', () => {
    const project = loadProject();
    const reordered = moveProjectPanel(moveProjectPanel(project, 'panel-3', 'up'), 'panel-3', 'up');
    expect(comicPanelsByOrder(reordered).map(panel => panel.id)).toEqual(['panel-0', 'panel-3', 'panel-1', 'panel-2']);
    expect(computePageLayouts(reordered)[0]!.slots.map(slot => slot.panelId))
      .toEqual(['panel-0', 'panel-3', 'panel-1', 'panel-2']);
    // 只改 order：资产 / 冻结 Prompt / stale 全不动，对白绑定不换位
    for (const panel of reordered.panels) {
      const origin = project.panels.find(item => item.id === panel.id)!;
      expect(panel.imageAsset).toBe(origin.imageAsset);
      expect(panel.compiledPrompt).toBe(origin.compiledPrompt);
    }
    expect(reordered.dialogues).toBe(project.dialogues);
    expect(reordered.finalPages).toBe(project.finalPages); // 旧 Final Page 记录保留（重排后重组合才更新）
  });
});

describe('D. Prompt E2E（§86）：场景段进 Prompt · 单格铁律不破', () => {
  it('4 格重编译：核心事件 + 场景兜底 + 单格强制，无页面级形式词', () => {
    const project = loadProject();
    for (const panel of comicPanelsByOrder(project)) {
      const compiled = compilePanelPrompt({ project, panel, mode: 'panel_regen' });
      expect(compiled.positive).toContain(panel.scene.slice(0, 8));
      // background 为空 → 兜底推导明确场景（修「背景接近空白」）
      expect(compiled.positive).toContain('场景与环境（强制）：依据画面事件布置明确的故事场景背景');
      expect(compiled.positive).toContain('单格画面（强制）');
      for (const word of ['四宫格', '2×2', 'comic sheet', '宫格拼图']) {
        expect(compiled.positive).not.toContain(word);
      }
      // negative：多格防线 + 背景防线（standard 档）
      expect(compiled.negative).toContain('四宫格');
      expect(compiled.negative).toContain('纯色背景');
      expect(compiled.negative).toContain('背景额外新增主要角色');
      // 对白文本永不进图片 Prompt（文字层独立）
      for (const dialogue of project.dialogues) {
        expect(compiled.positive).not.toContain(dialogue.text);
      }
    }
  });

  it('重编译是纯函数：不回写 panel（冻结 Prompt 与真实资产不受触碰）', () => {
    const project = loadProject();
    compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'panel_regen' });
    expect(project.panels[0]!.compiledPrompt).toBe('frozen-panel-0');
    expect(project.panels[0]!.imageAsset!.imageId).toBe(PANEL_IMAGE_IDS[0]);
  });
});

describe('E. 持久化往返（§79）：气泡 / 尾巴 / 字体 / 尺寸存得进、读得回', () => {
  it('编辑后 JSON 往返 normalize，四个属性 + panelId / 位置全保留', () => {
    const project = loadProject();
    const edited = upsertDialogue(project, {
      ...project.dialogues[0]!,
      bubbleStyle: 'cloud',
      tail: 'top-right',
      fontStyle: { ...project.dialogues[0]!.fontStyle, family: 'KaiTi' },
      size: { width: 0.4, height: 0.2 },
      position: { x: 0.42, y: 0.3 },
    });
    const roundTrip = normalizeComicProject(JSON.parse(JSON.stringify(edited)))!;
    const persisted = roundTrip.dialogues.find(dialogue => dialogue.id === 'e2e-dlg-1')!;
    expect(persisted).toMatchObject({
      panelId: 'panel-0',
      bubbleStyle: 'cloud',
      tail: 'top-right',
      size: { width: 0.4, height: 0.2 },
      position: { x: 0.42, y: 0.3 },
    });
    expect(persisted.fontStyle.family).toBe('KaiTi');
    // 其余对白与图片资产不受影响
    expect(roundTrip.dialogues).toHaveLength(5);
    expect(roundTrip.finalPages).toHaveLength(1);
  });
});
