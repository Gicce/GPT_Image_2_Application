import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ImageRecord, Task } from '../../../types';
import { useEvaluationStore } from '../../../store/useEvaluationStore';
import type { ImageEvaluation } from '../types';

// ===== 依赖 mock（服务层编排逻辑的单测锚点） =====

vi.mock('../../../services/api', () => ({
  api: {
    evaluateImage: vi.fn(),
    evaluateAnimeCharacterConsistency: vi.fn(),
    getAnimeConsistencyEvaluations: vi.fn(),
    getImages: vi.fn(),
  },
}));

vi.mock('../../aiProviders/store', () => ({
  resolveByokVisionConfig: vi.fn(() => ({
    ok: true,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    token: 'test-token',
    model: 'glm-5v-turbo',
    profileId: 'p1',
    profileName: '智谱',
    modelEntity: { model_id: 'glm-5v-turbo', display_name: 'GLM-5V-Turbo' },
  })),
  useAIProviderStore: {
    getState: () => ({
      profiles: [],
      resolveForUse: () => null,
    }),
  },
  resolveConversationAgent: vi.fn(() => null),
}));

vi.mock('../../vision/session', () => ({
  listVisionSessions: vi.fn(() => []),
}));

vi.mock('../../../store/useVisionWorkspaceStore', () => ({
  useVisionWorkspaceStore: {
    getState: () => ({
      visionTaskId: '',
      analysis: null,
      recreation: null,
      sourcePath: '',
    }),
  },
}));

const refreshHooks = new Set<(taskId: string) => void>();
vi.mock('../../../store/useTaskStore', () => ({
  registerTaskRefreshHook: (hook: (taskId: string) => void) => {
    refreshHooks.add(hook);
    return () => refreshHooks.delete(hook);
  },
  useTaskStore: {
    getState: () => ({
      tasks: [] as Task[],
    }),
  },
}));

import { api } from '../../../services/api';
import {
  ensureEvaluationWatcher,
  evaluateAnimeConsistencyAsset,
  evaluateTaskImages,
  loadAnimeConsistencyEvaluation,
  resolveAnimeConsistencyContext,
  resolveEvaluationContext,
} from '../evaluationService';
import { readEvaluationSettings, writeEvaluationSettings } from '../evaluationSettings';

const evaluateImageMock = api.evaluateImage as ReturnType<typeof vi.fn>;
const getImagesMock = api.getImages as ReturnType<typeof vi.fn>;
const evaluateAnimeMock = api.evaluateAnimeCharacterConsistency as ReturnType<typeof vi.fn>;
const getAnimeEvaluationsMock = api.getAnimeConsistencyEvaluations as ReturnType<typeof vi.fn>;

function makeEvaluation(assetId: string, overrides: Partial<ImageEvaluation> = {}): ImageEvaluation {
  return {
    asset_id: assetId,
    asset_path: '',
    task_id: 'task-1',
    task_kind: 'i2i',
    evaluation_version: 'image-eval-v1',
    overall_score: 88,
    instruction_adherence: 90,
    subject_consistency: null,
    reference_preservation: 86,
    style_consistency: 84,
    composition_quality: 88,
    technical_quality: 92,
    strengths: [],
    issues: [],
    suggestion: '',
    preserve: [],
    change: [],
    edit_instruction: '',
    evaluated_by: 'glm-5v-turbo',
    evaluated_at: '',
    user_rating: null,
    user_issue_tags: [],
    user_comment: '',
    user_feedback_at: '',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeImage(id: string, path: string): ImageRecord {
  return {
    id,
    task_id: 'task-1',
    local_path: path,
    file_name: `${id}.png`,
    created_at: '2026-08-22T10:00:00Z',
    status: 'saved',
    source_kind: 'output',
  };
}

describe('evaluateTaskImages：per-image 独立评价（Phase 13）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEvaluationStore.setState({ evaluations: {}, pending: {}, failed: {} });
  });

  it('批量任务 4 张图 → 每张图独立调用评价（绝不给整批一个总分）', async () => {
    const task = {
      id: 'task-1',
      task_type: 'generate',
      status: 'completed',
      source_images: [],
      user_prompt_raw: '画一只猫',
      sub_tasks: [
        { index: 0, status: 'completed', image_id: 'img-1' },
        { index: 1, status: 'completed', image_id: 'img-2' },
        { index: 2, status: 'completed', image_id: 'img-3' },
        { index: 3, status: 'completed', image_id: 'img-4' },
      ],
    } as unknown as Task;
    const imageById = new Map([
      ['img-1', makeImage('img-1', 'D:/a.png')],
      ['img-2', makeImage('img-2', 'D:/b.png')],
      ['img-3', makeImage('img-3', 'D:/c.png')],
      ['img-4', makeImage('img-4', 'D:/d.png')],
    ]);
    evaluateImageMock.mockImplementation(async (req: { asset_id: string }) => ({
      ok: true,
      evaluation: makeEvaluation(req.asset_id, { overall_score: 80 + Number(req.asset_id.slice(-1)) }),
    }));

    const outcome = await evaluateTaskImages(task, imageById);
    expect(evaluateImageMock).toHaveBeenCalledTimes(4);
    expect(outcome.evaluated).toBe(4);
    const state = useEvaluationStore.getState();
    // 每张 Asset 各自的分数持久化在 store（asset 维度，非任务维度）
    expect(state.evaluations['img-1'].overall_score).toBe(81);
    expect(state.evaluations['img-2'].overall_score).toBe(82);
    expect(state.evaluations['img-3'].overall_score).toBe(83);
    expect(state.evaluations['img-4'].overall_score).toBe(84);
  });

  it('只评价成功子任务；失败 / 缺图槽位跳过', async () => {
    const task = {
      id: 'task-1',
      task_type: 'generate',
      status: 'completed',
      source_images: [],
      sub_tasks: [
        { index: 0, status: 'completed', image_id: 'img-a' },
        { index: 1, status: 'failed', image_id: undefined },
        { index: 2, status: 'completed', image_id: 'img-missing-record' },
      ],
    } as unknown as Task;
    const imageById = new Map([['img-a', makeImage('img-a', 'D:/a.png')]]);
    evaluateImageMock.mockResolvedValue({ ok: true, evaluation: makeEvaluation('img-a') });

    const outcome = await evaluateTaskImages(task, imageById);
    expect(evaluateImageMock).toHaveBeenCalledTimes(1);
    expect(outcome.evaluated).toBe(1);
  });

  it('评价失败不影响其余图片，也不抛错（绝不影响生成任务）', async () => {
    const task = {
      id: 'task-1',
      task_type: 'generate',
      status: 'completed',
      source_images: [],
      sub_tasks: [
        { index: 0, status: 'completed', image_id: 'img-a' },
        { index: 1, status: 'completed', image_id: 'img-b' },
      ],
    } as unknown as Task;
    const imageById = new Map([
      ['img-a', makeImage('img-a', 'D:/a.png')],
      ['img-b', makeImage('img-b', 'D:/b.png')],
    ]);
    evaluateImageMock.mockImplementation(async (req: { asset_id: string }) => {
      if (req.asset_id === 'img-a') {
        return { ok: false, evaluation: null, error_kind: 'rate_limited', error_message: '视觉模型服务限流', status: 429 };
      }
      return { ok: true, evaluation: makeEvaluation('img-b') };
    });

    const outcome = await evaluateTaskImages(task, imageById);
    expect(outcome.evaluated).toBe(1);
    expect(outcome.failed).toBe(1);
    const state = useEvaluationStore.getState();
    expect(state.evaluations['img-b'].overall_score).toBe(88);
    expect(state.failed['img-a']).toContain('限流');
  });

  it('已有评价的资产默认跳过（force=false），重新评价才覆盖', async () => {
    const task = {
      id: 'task-1',
      task_type: 'generate',
      status: 'completed',
      source_images: [],
      sub_tasks: [{ index: 0, status: 'completed', image_id: 'img-a' }],
    } as unknown as Task;
    const imageById = new Map([['img-a', makeImage('img-a', 'D:/a.png')]]);
    useEvaluationStore.getState().upsert(makeEvaluation('img-a'));
    evaluateImageMock.mockResolvedValue({ ok: true, evaluation: makeEvaluation('img-a', { overall_score: 99 }) });

    const skipped = await evaluateTaskImages(task, imageById);
    expect(skipped.skipped).toBe(1);
    expect(evaluateImageMock).not.toHaveBeenCalled();
    expect(useEvaluationStore.getState().evaluations['img-a'].overall_score).toBe(88);

    await evaluateTaskImages(task, imageById, { force: true });
    expect(evaluateImageMock).toHaveBeenCalledTimes(1);
    expect(useEvaluationStore.getState().evaluations['img-a'].overall_score).toBe(99);
  });
});

describe('resolveEvaluationContext（任务感知评价上下文）', () => {
  it('视觉复刻任务：修改要求 = 调整要求原文，reference = 参考图', () => {
    const task = {
      id: 'task-9',
      task_type: 'edit',
      source_task_kind: 'vision_understanding',
      source_task_id: 'vt-1',
      source_images: ['D:/ref.png'],
      user_prompt_raw: '编译后的最终 Prompt…',
    } as unknown as Task;
    const context = resolveEvaluationContext(task);
    expect(context.referencePath).toBe('D:/ref.png');
    // 指令 = 用户原话（此处无 session → 回落 user_prompt_raw）
    expect(context.editInstruction).toBe('编译后的最终 Prompt…');
  });

  it('普通图生图：reference = source_images[0]，指令 = 用户原始需求', () => {
    const task = {
      id: 'task-2',
      task_type: 'edit',
      source_images: ['D:/src.png'],
      user_prompt_raw: '把背景换成雪山',
    } as unknown as Task;
    const context = resolveEvaluationContext(task);
    expect(context.referencePath).toBe('D:/src.png');
    expect(context.editInstruction).toBe('把背景换成雪山');
  });

  it('文生图：无参考图（reference 为 null，评价器对相关维度返回 null）', () => {
    const task = {
      id: 'task-3',
      task_type: 'generate',
      source_images: [],
      user_prompt_raw: '一只戴眼镜的猫',
    } as unknown as Task;
    const context = resolveEvaluationContext(task);
    expect(context.referencePath).toBeNull();
    expect(context.editInstruction).toBe('一只戴眼镜的猫');
    expect(context.change).toEqual(['一只戴眼镜的猫']);
  });
});

describe('自动评价 watcher（生成完成后异步触发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const memory = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
      setItem: (key: string, value: string) => { memory.set(key, String(value)); },
      removeItem: (key: string) => { memory.delete(key); },
      clear: () => memory.clear(),
    });
    useEvaluationStore.setState({ evaluations: {}, pending: {}, failed: {} });
    writeEvaluationSettings({ autoEvaluate: true });
  });

  it('watcher 注册一次（重复调用不重复挂）', () => {
    ensureEvaluationWatcher();
    const count = refreshHooks.size;
    ensureEvaluationWatcher();
    expect(refreshHooks.size).toBe(count);
  });

  it('关闭「生成后自动评价」后设置读取为 false', () => {
    writeEvaluationSettings({ autoEvaluate: false });
    expect(readEvaluationSettings().autoEvaluate).toBe(false);
  });
});

describe('动漫角色一致性评价基础链路', () => {
  const animeTask = {
    id: 'task-anime',
    provenance: {
      schemaVersion: 1,
      feature: 'vision_recreation',
      imageRoles: [{ path: 'D:/character.png', label: '动漫角色参考', role: 'anime_character_reference' }],
      animeCharacterSnapshot: {
        id: 'canonical-anime-character',
        sourceSubjectLabel: '动漫角色',
        identitySource: { kind: 'person_reference', label: '人物参考' },
        designSource: 'derived_from_person_reference',
        hair: '黑色及肩微卷发',
        face: '鹅蛋脸',
        eyes: '杏眼、棕色瞳孔',
        clothing: '蓝色夹克',
        hairFacts: { baseColor: '黑色', length: 'shoulder' },
      },
    },
  } as unknown as Task;

  beforeEach(() => vi.clearAllMocks());

  it('旧任务缺角色快照或角色参考图时不创建评价上下文、不发明分数', () => {
    expect(resolveAnimeConsistencyContext({ id: 'old', provenance: null } as unknown as Task)).toBeNull();
    expect(resolveAnimeConsistencyContext({
      ...animeTask,
      provenance: { ...animeTask.provenance!, imageRoles: [] },
    })).toBeNull();
  });

  it('评价请求使用生成时冻结的角色参考与事实；失败结果不抛出', async () => {
    const image = makeImage('img-anime', 'D:/result.png');
    evaluateAnimeMock.mockResolvedValue({
      ok: false,
      evaluation: null,
      error_kind: 'rate_limit',
      error_message: '评价繁忙，请稍后重试。',
      status: 429,
    });
    const result = await evaluateAnimeConsistencyAsset(animeTask, image);
    expect(result.ok).toBe(false);
    expect(evaluateAnimeMock).toHaveBeenCalledWith(expect.objectContaining({
      character_reference_path: 'D:/character.png',
      asset_path: 'D:/result.png',
    }));
    expect(JSON.parse(evaluateAnimeMock.mock.calls[0][0].character_facts).hair).toEqual({ baseColor: '黑色', length: 'shoulder' });
  });

  it('只读取持久化记录；无记录返回 null', async () => {
    getAnimeEvaluationsMock.mockResolvedValue([]);
    await expect(loadAnimeConsistencyEvaluation('img-old')).resolves.toBeNull();
    expect(getAnimeEvaluationsMock).toHaveBeenCalledWith(['img-old']);
  });
});
