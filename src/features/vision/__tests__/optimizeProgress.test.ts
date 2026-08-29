/**
 * V6.8 §五 优化真实进度测试：
 *  - 纯函数层：阶段型状态模型（running 判定 / 百分比只随阶段跳变 / 真实计时 / tone）；
 *  - 服务层：onStage 只在真实边界触发（collecting → optimizing → validating），
 *    失败不派发 validating；
 *  - 组件层（源码契约）：进度卡不存 percent、失败隐藏进度条、完成显示 100%。
 * Progress Honesty（Skill §36）：百分比 = 阶段锚点派生，禁止按时间/随机数递增。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OPTIMIZATION_ACTIVE_STAGES,
  OPTIMIZATION_RUNNING_STATUSES,
  OPTIMIZATION_STAGE_LABEL,
  OPTIMIZATION_STAGE_PERCENT,
  deriveOptimizationPercent,
  isOptimizationRunning,
  optimizationElapsedSeconds,
  optimizationProgressTone,
  type PromptOptimizationStatus,
} from '../optimizeProgress';

// ===== Part 1：纯函数（状态模型 / 阶段锚点 / 真实计时）=====

const ALL_STATUSES: PromptOptimizationStatus[] = [
  'idle', 'queued', 'collecting', 'normalizing', 'analyzing', 'optimizing', 'validating', 'completed', 'failed',
];

describe('isOptimizationRunning', () => {
  it('运行中 = queued/collecting/normalizing/analyzing/optimizing/validating；idle/failed/completed 是终态', () => {
    const expectedRunning: Record<PromptOptimizationStatus, boolean> = {
      idle: false, queued: true, collecting: true, normalizing: true,
      analyzing: true, optimizing: true, validating: true, completed: false, failed: false,
    };
    for (const status of ALL_STATUSES) {
      expect(isOptimizationRunning(status), status).toBe(expectedRunning[status]);
    }
  });
});

describe('deriveOptimizationPercent（阶段锚点，唯一百分比来源）', () => {
  it('idle / failed 无百分比（未开始 / 失败绝不显示伪进度）', () => {
    expect(deriveOptimizationPercent('idle')).toBeNull();
    expect(deriveOptimizationPercent('failed')).toBeNull();
  });

  it('完成 = 100；当前链路各阶段锚点单调递增', () => {
    expect(deriveOptimizationPercent('completed')).toBe(100);
    let prev = 0;
    for (const stage of OPTIMIZATION_ACTIVE_STAGES) {
      const percent = deriveOptimizationPercent(stage);
      expect(percent, stage).not.toBeNull();
      expect(percent as number).toBeGreaterThan(prev);
      prev = percent as number;
    }
  });

  it('ACTIVE_STAGES 全部是运行中状态，且都有中文标签（UI 禁止另行拼写）', () => {
    expect(OPTIMIZATION_ACTIVE_STAGES.every(stage => OPTIMIZATION_RUNNING_STATUSES.includes(stage))).toBe(true);
    for (const status of ALL_STATUSES) {
      expect(OPTIMIZATION_STAGE_LABEL[status].length, status).toBeGreaterThan(0);
    }
  });

  it('锚点表覆盖全部九态（新增状态必须显式给锚点或 null，不能静默 undefined）', () => {
    for (const status of ALL_STATUSES) {
      const percent = OPTIMIZATION_STAGE_PERCENT[status];
      expect(percent === null || (typeof percent === 'number' && percent >= 0 && percent <= 100), status).toBe(true);
    }
  });
});

describe('optimizationElapsedSeconds（真实计时，不是进度）', () => {
  it('按毫秒差折秒；时间倒挂 / 未开始时钳为 0', () => {
    const startedAt = 1_700_000_000_000;
    expect(optimizationElapsedSeconds(startedAt, startedAt)).toBe(0);
    expect(optimizationElapsedSeconds(startedAt, startedAt + 999)).toBe(0);
    expect(optimizationElapsedSeconds(startedAt, startedAt + 61_000)).toBe(61);
    expect(optimizationElapsedSeconds(startedAt, startedAt - 5_000)).toBe(0);
  });
});

describe('optimizationProgressTone', () => {
  it('completed→completed / failed→failed / 其余（含 idle）→running 色', () => {
    expect(optimizationProgressTone('completed')).toBe('completed');
    expect(optimizationProgressTone('failed')).toBe('failed');
    expect(optimizationProgressTone('idle')).toBe('running');
    expect(optimizationProgressTone('optimizing')).toBe('running');
  });
});

// ===== Part 2：服务层 onStage（真实边界顺序）=====

vi.mock('../../../services/api', () => ({
  api: {
    runAgentRequest: vi.fn(async () => ({
      ok: true,
      reply: JSON.stringify({
        positive_prompt: '优化后的 Prompt',
        negative_prompt: '低画质',
        summary: '已按调整要求优化',
        changed_dimensions: ['pose'],
        dimension_values: { pose: '双手比心' },
      }),
    })),
  },
}));

import { api } from '../../../services/api';
import { useAIProviderStore } from '../../aiProviders/store';
import { useAiModelRoutingStore } from '../../aiRouting/modelRoutingPolicy';
import { optimizeVisionRecreation } from '../../../services/promptOptimizer';
import type { VisualRecreationPlan } from '../recreationPlan';

const runAgentRequestMock = api.runAgentRequest as ReturnType<typeof vi.fn>;

const plan: VisualRecreationPlan = {
  summary: '一名篮球运动员上篮',
  fields: [
    { key: 'subject', label: '人物 / 主体', value: '篮球运动员', locked: true, lockSource: 'default', originalValue: '篮球运动员' },
    { key: 'pose', label: '动作', value: '上篮', locked: false, originalValue: '上篮' },
  ],
};

describe('optimizeVisionRecreation onStage（阶段只在真实边界触发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 与 visionOptimizerRouting.test.ts 同款最小路由环境：一个可用视觉优化模型
    useAIProviderStore.setState({
      profiles: [
        {
          id: 'vp1',
          name: '智谱 GLM',
          category: 'vision',
          provider_type: 'glm_official',
          base_url: 'https://api.test/v1',
          api_key: 'test-key',
          enabled: true,
          default_model_id: 'glm-5v-turbo',
          vision_model_id: '',
          system_prompt: '',
          context_window: 128000,
          fallback_token: '',
          avatar_data_url: '',
          created_at: '',
          updated_at: '',
          models: [
            {
              id: 'row-glm-5v-turbo',
              model_id: 'glm-5v-turbo',
              display_name: 'GLM-5V-Turbo',
              model_source: 'official_registry',
              enabled: true,
              supports_vision: true,
              capabilities: ['vision', 'text'],
              lifecycle: 'active',
              test_status: 'available',
            },
          ],
        } as never,
      ],
      selections: {},
      defaultProfileId: 'vp1',
      defaultVisionProfileId: 'vp1',
      migrated: true,
      hydrated: true,
    });
    useAiModelRoutingStore.setState({ config: {}, hydrated: true, lastUsed: {} });
  });

  it('成功链路按 collecting → optimizing → validating 顺序各触发一次', async () => {
    const stages: string[] = [];
    const outcome = await optimizeVisionRecreation({
      originalRecreationPrompt: '原始复刻 Prompt',
      structuredRecreationPlan: plan,
      userAdjustmentInstruction: '把动作改成比心',
      onStage: stage => stages.push(stage),
    });
    expect(outcome.ok).toBe(true);
    expect(stages).toEqual(['collecting', 'optimizing', 'validating']);
  });

  it('模型请求失败：只到 optimizing，绝不派发 validating（校验阶段未真实发生）', async () => {
    runAgentRequestMock.mockRejectedValueOnce(new Error('网络中断'));
    const stages: string[] = [];
    const outcome = await optimizeVisionRecreation({
      originalRecreationPrompt: '原始复刻 Prompt',
      structuredRecreationPlan: plan,
      userAdjustmentInstruction: '把动作改成比心',
      onStage: stage => stages.push(stage),
    });
    expect(outcome.ok).toBe(false);
    expect(stages).toEqual(['collecting', 'optimizing']);
  });

  it('空回复：validating 已触发（回复确实收到，校验阶段真实发生），随后失败返回', async () => {
    runAgentRequestMock.mockResolvedValueOnce({ ok: true, reply: '   ' });
    const stages: string[] = [];
    const outcome = await optimizeVisionRecreation({
      originalRecreationPrompt: '原始复刻 Prompt',
      structuredRecreationPlan: plan,
      userAdjustmentInstruction: '把动作改成比心',
      onStage: stage => stages.push(stage),
    });
    expect(outcome.ok).toBe(false);
    expect(stages).toEqual(['collecting', 'optimizing', 'validating']);
  });
});

// ===== Part 3：OptimizeProgressCard 源码契约 =====

const cardSrc = readFileSync(resolve(__dirname, '../OptimizeProgressCard.tsx'), 'utf8');

describe('OptimizeProgressCard（源码契约）', () => {
  it('组件不存 / 不累积 percent：百分比只从 deriveOptimizationPercent 派生', () => {
    expect(cardSrc).toContain('deriveOptimizationPercent(status)');
    expect(cardSrc).not.toContain('percent +=');
    expect(cardSrc).not.toContain('Math.random');
  });

  it('已用时计时只在运行中启动（1 秒真实 tick），卸载即清理', () => {
    expect(cardSrc).toContain('if (!running) return;');
    expect(cardSrc).toContain('window.setInterval(() => setNow(Date.now()), 1000)');
    expect(cardSrc).toContain('return () => window.clearInterval(timer);');
  });

  it('失败态：不渲染进度条（进度已停止）；显示真实错误 + 重新优化按钮', () => {
    expect(cardSrc).toContain("tone !== 'failed' && (");
    expect(cardSrc).toContain('errorText || ');
    expect(cardSrc).toContain('data-testid="vision-optimize-retry"');
    expect(cardSrc).toContain('重新优化');
  });

  it('完成态：✓ 优化完成 + 100%', () => {
    expect(cardSrc).toContain("'✓ 优化完成'");
    expect(cardSrc).toContain("tone === 'completed'");
  });
});
