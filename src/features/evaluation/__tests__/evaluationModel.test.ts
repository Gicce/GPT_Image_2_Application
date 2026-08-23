import { describe, it, expect } from 'vitest';
import {
  EVALUATION_VERSION,
  aggregateTaskEvaluations,
  buildPreserveChange,
  composeFeedbackInstruction,
  computeOverall,
  evaluationTaskKind,
  feedbackUsableForNextRound,
  matchesFeedbackFilter,
  matchesScoreBucket,
  taskEvaluationSummary,
} from '../evaluationModel';
import type { ImageEvaluation } from '../types';
import type { Task } from '../../../types';

function makeEvaluation(overrides: Partial<ImageEvaluation>): ImageEvaluation {
  return {
    asset_id: 'asset-1',
    asset_path: 'D:/out/a.png',
    task_id: 'task-1',
    task_kind: 'vision_recreation',
    evaluation_version: EVALUATION_VERSION,
    overall_score: null,
    instruction_adherence: null,
    subject_consistency: null,
    reference_preservation: null,
    style_consistency: null,
    composition_quality: null,
    technical_quality: null,
    strengths: [],
    issues: [],
    suggestion: '',
    preserve: [],
    change: [],
    edit_instruction: '',
    evaluated_by: 'glm-5v-turbo',
    evaluated_at: '2026-08-22T10:00:00Z',
    user_rating: null,
    user_issue_tags: [],
    user_comment: '',
    user_feedback_at: '',
    created_at: '2026-08-22T10:00:00Z',
    updated_at: '2026-08-22T10:00:00Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    prompt: '',
    negative_prompt: '',
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    count: 1,
    status: 'completed',
    created_at: '2026-08-22T10:00:00Z',
    output_dir: '',
    success_count: 1,
    failed_count: 0,
    sub_tasks: [],
    task_type: 'generate',
    source_images: [],
    ...overrides,
  } as Task;
}

// ===== null 兼容与 0 分语义 =====

describe('未评价与 0 分语义（null ≠ 0）', () => {
  it('null evaluation 兼容：无评价对象按未处理，绝不抛错', () => {
    expect(matchesScoreBucket(null, 'all')).toBe(true);
    expect(matchesScoreBucket(null, 'unscored')).toBe(true);
    expect(matchesScoreBucket(null, 'gte90')).toBe(false);
    expect(matchesFeedbackFilter(undefined, 'all')).toBe(true);
    expect(matchesFeedbackFilter(undefined, 'unrated')).toBe(true);
  });

  it('0 是合法低分：不落入「未评价」桶', () => {
    const zero = makeEvaluation({ overall_score: 0 });
    expect(matchesScoreBucket(zero, 'unscored')).toBe(false);
    expect(matchesScoreBucket(zero, 'lt70')).toBe(true);
  });

  it('evaluationVersion 持久化：常量版本号存在且写入每条评价', () => {
    expect(EVALUATION_VERSION).toBe('image-eval-v1');
    const e = makeEvaluation({});
    expect(e.evaluation_version).toBe('image-eval-v1');
  });
});

// ===== 评分桶边界 =====

describe('评分桶筛选边界', () => {
  type ScoreBucketAssertion = { gte90: boolean; '80_89': boolean; '70_79': boolean; lt70: boolean };
  const cases: Array<[number, ScoreBucketAssertion]> = [
    [90, { gte90: true, '80_89': false, '70_79': false, lt70: false }],
    [89, { gte90: false, '80_89': true, '70_79': false, lt70: false }],
    [80, { gte90: false, '80_89': true, '70_79': false, lt70: false }],
    [79, { gte90: false, '80_89': false, '70_79': true, lt70: false }],
    [70, { gte90: false, '80_89': false, '70_79': true, lt70: false }],
    [69, { gte90: false, '80_89': false, '70_79': false, lt70: true }],
    [100, { gte90: true, '80_89': false, '70_79': false, lt70: false }],
  ];

  it.each(cases)('分数 %i 落入正确桶', (score, expected) => {
    const e = makeEvaluation({ overall_score: score });
    for (const [bucket, expectedMatch] of Object.entries(expected)) {
      expect(matchesScoreBucket(e, bucket as never)).toBe(expectedMatch);
    }
  });
});

// ===== 反馈筛选 =====

describe('用户反馈筛选（liked / disliked / unrated）', () => {
  it('liked / disliked / 未反馈正确分流', () => {
    const liked = makeEvaluation({ user_rating: 'liked' });
    const disliked = makeEvaluation({ user_rating: 'disliked' });
    const unrated = makeEvaluation({ user_rating: null });
    expect(matchesFeedbackFilter(liked, 'liked')).toBe(true);
    expect(matchesFeedbackFilter(liked, 'disliked')).toBe(false);
    expect(matchesFeedbackFilter(disliked, 'disliked')).toBe(true);
    expect(matchesFeedbackFilter(unrated, 'unrated')).toBe(true);
    expect(matchesFeedbackFilter(null, 'unrated')).toBe(true);
  });
});

// ===== 批量任务聚合（per-image，绝不允许整批一个分） =====

describe('批量任务聚合', () => {
  it('每张图独立评分 → 任务层 best / average 聚合', () => {
    const evals = [
      makeEvaluation({ asset_id: 'a', overall_score: 91 }),
      makeEvaluation({ asset_id: 'b', overall_score: 86 }),
      makeEvaluation({ asset_id: 'c', overall_score: 74 }),
      makeEvaluation({ asset_id: 'd', overall_score: 93 }),
    ];
    const aggregate = aggregateTaskEvaluations(evals);
    expect(aggregate.count).toBe(4);
    expect(aggregate.bestScore).toBe(93);
    expect(aggregate.averageScore).toBe(86);
  });

  it('未评价资产不计入聚合；全未评价返回 null（禁止 0 分冒充）', () => {
    expect(aggregateTaskEvaluations([makeEvaluation({ overall_score: null })])).toEqual({
      count: 0,
      bestScore: null,
      averageScore: null,
    });
    expect(aggregateTaskEvaluations([]).bestScore).toBeNull();
  });

  it('任务行轻量文案：多张图显示最高分，单张图显示综合分', () => {
    expect(taskEvaluationSummary({ count: 4, bestScore: 93, averageScore: 86 }, 4)).toBe('4 张 · 最高 93');
    expect(taskEvaluationSummary({ count: 1, bestScore: 91, averageScore: 91 }, 1)).toBe('综合 91');
    expect(taskEvaluationSummary({ count: 0, bestScore: null, averageScore: null }, 3)).toBe('');
  });
});

// ===== 任务类型判定与 overall 权重 =====

describe('任务类型判定与动态权重', () => {
  it('source_task_kind=vision_understanding → vision_recreation', () => {
    expect(evaluationTaskKind(makeTask({
      task_type: 'edit',
      source_task_kind: 'vision_understanding',
      source_task_id: 'vt-1',
      source_images: ['ref.png'],
    }))).toBe('vision_recreation');
  });

  it('edit / 有参考图 → i2i；纯文生图 → t2i', () => {
    expect(evaluationTaskKind(makeTask({ task_type: 'edit', source_images: ['a.png'] }))).toBe('i2i');
    expect(evaluationTaskKind(makeTask({ task_type: 'generate', source_images: ['a.png'] }))).toBe('i2i');
    expect(evaluationTaskKind(makeTask({ task_type: 'generate', source_images: [] }))).toBe('t2i');
  });

  it('不适用维度用 null：null 退出加权并重新归一，全 null → overall null', () => {
    // t2i：subject/reference 天然 null
    const overall = computeOverall({
      task_kind: 't2i',
      instruction_adherence: 80,
      subject_consistency: null,
      reference_preservation: null,
      style_consistency: 80,
      composition_quality: 80,
      technical_quality: 80,
    });
    expect(overall).toBe(80);
    expect(computeOverall({ task_kind: 't2i' })).toBeNull();
  });

  it('视觉复刻权重：指令完成度权重最高（.25 与主体一致）', () => {
    // 全 100 时 overall=100；指令 0、其余 100 → 100 - 25 = 75
    const base = {
      task_kind: 'vision_recreation' as const,
      instruction_adherence: 100,
      subject_consistency: 100,
      reference_preservation: 100,
      style_consistency: 100,
      composition_quality: 100,
      technical_quality: 100,
    };
    expect(computeOverall(base)).toBe(100);
    expect(computeOverall({ ...base, instruction_adherence: 0 })).toBe(75);
  });
});

// ===== preserve / change 语义（Similarity ≠ Completion 核心契约） =====

describe('preserve / change 语义（意图感知契约）', () => {
  it('用户要求修改动作时：动作属于 change，不在 preserve —— 评价不得因动作与原图不同扣参考保持分', () => {
    const semantics = buildPreserveChange({
      planFields: [
        { key: 'subject', label: '人物 / 主体', locked: true },
        { key: 'pose', label: '动作', locked: false },
        { key: 'scene', label: '背景 / 场景', locked: true },
      ],
      adjustInstruction: '把动作改成双手抱胸，人物和背景不要变化',
    });
    expect(semantics.preserve).toContain('人物 / 主体');
    expect(semantics.preserve).toContain('背景 / 场景');
    expect(semantics.preserve).not.toContain('动作');
    expect(semantics.change).toContain('动作');
    expect(semantics.change).toContain('把动作改成双手抱胸，人物和背景不要变化');
  });

  it('锁定字段 → preserve；可修改字段 → change', () => {
    const semantics = buildPreserveChange({
      planFields: [
        { key: 'style', label: '风格', locked: true },
        { key: 'color', label: '色彩', locked: false },
      ],
      adjustInstruction: '',
    });
    expect(semantics.preserve).toEqual(['风格']);
    expect(semantics.change).toEqual(['色彩']);
  });

  it('无结构化方案（普通任务）：change = 用户需求原文', () => {
    const semantics = buildPreserveChange({ adjustInstruction: '把背景换成雪山' });
    expect(semantics.preserve).toEqual([]);
    expect(semantics.change).toEqual(['把背景换成雪山']);
  });
});

// ===== 用户反馈 → 下一轮指令 =====

describe('反馈闭环指令组装', () => {
  it('dislike 标签 + 补充说明 + AI 建议 + 保持优点 全部进入下一轮指令', () => {
    const instruction = composeFeedbackInstruction(makeEvaluation({
      user_rating: 'disliked',
      user_issue_tags: ['人物不像', '背景变化太大'],
      user_comment: '脸再接近原图一点，其他地方保持不变',
      suggestion: '加强人物脸部与原图的一致性约束，同时锁定背景构图',
      strengths: ['服装与配色保持较好'],
    }));
    expect(instruction).toContain('人物身份 / 五官要更接近原图');
    expect(instruction).toContain('背景要保持与原图一致');
    expect(instruction).toContain('脸再接近原图一点');
    expect(instruction).toContain('加强人物脸部与原图的一致性约束');
    expect(instruction).toContain('服装与配色保持较好');
  });

  it('无任何反馈内容时返回空串（不制造空洞指令）', () => {
    expect(composeFeedbackInstruction(makeEvaluation({}))).toBe('');
  });

  it('feedbackUsableForNextRound：liked 直接可用；dislike 需要标签或说明', () => {
    expect(feedbackUsableForNextRound('liked', [], '')).toBe(true);
    expect(feedbackUsableForNextRound('disliked', [], '')).toBe(false);
    expect(feedbackUsableForNextRound('disliked', ['风格跑了'], '')).toBe(true);
    expect(feedbackUsableForNextRound('disliked', [], '脸再像一点')).toBe(true);
    expect(feedbackUsableForNextRound(null, [], '')).toBe(false);
  });
});
