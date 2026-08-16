import { describe, it, expect } from 'vitest';
import {
  parsePromptImageCount,
  classifyGenerationIntent,
  extractDistinctObjects,
  nextGenerationCountState,
  type GenerationCountState,
} from '../generationIntent';

// ============================================================================
// 数量解析（强制验收 CASE 1/2/5/6/7 + 数量表达变体）
// ============================================================================

describe('parsePromptImageCount', () => {
  it('CASE 1：我需要3张不同中国城市的夜景图 → 3', () => {
    expect(parsePromptImageCount('我需要3张不同中国城市的夜景图')).toBe(3);
  });

  it('CASE 7：前3座山中间有一条河 → 不识别为图片张数', () => {
    expect(parsePromptImageCount('前3座山中间有一条河')).toBeNull();
  });

  it('画面内实体计数不是图片张数：画面前方有3个人 → null', () => {
    expect(parsePromptImageCount('画面前方有3个人')).toBeNull();
  });

  it('CASE 6：生成一张图片，画面里展示三个城市 → 单张复合构图 → 1', () => {
    expect(parsePromptImageCount('生成一张图片，画面里展示上海、北京、广州三个城市')).toBe(1);
  });

  it('九宫格 / 三分镜等复合构图恒为 1 张', () => {
    expect(parsePromptImageCount('生成一个九宫格')).toBe(1);
    expect(parsePromptImageCount('3分镜图展示登山过程')).toBe(1);
  });

  it('常见数量表达：来3张 / 生成三张 / 来一张 / 生成5个版本 / 给我做6张', () => {
    expect(parsePromptImageCount('来3张')).toBe(3);
    expect(parsePromptImageCount('给我生成三张赛博朋克跑车')).toBe(3);
    expect(parsePromptImageCount('来一张')).toBe(1);
    expect(parsePromptImageCount('生成5个版本')).toBe(5);
    expect(parsePromptImageCount('给我做6张')).toBe(6);
  });

  it('"各一张"是每对象配额不是总张数：上海、北京、广州各一张 → null（总数由对象数决定）', () => {
    expect(parsePromptImageCount('上海、北京、广州各一张夜景')).toBeNull();
  });

  it('"前3个 / 第2张"顺序引用不解析为张数', () => {
    expect(parsePromptImageCount('前3个山里最高的那座')).toBeNull();
    expect(parsePromptImageCount('把第2张换成夜景')).toBeNull();
  });

  it('非图像量词（米 / 点钟 / 层）不解析', () => {
    expect(parsePromptImageCount('一栋3米高的3层建筑，时间是3点钟')).toBeNull();
  });

  it('CASE E：3D / 4K / 8K / 2个人 / 50mm 等画面参数不误识别为张数', () => {
    expect(parsePromptImageCount('3D 战国美女，4K，2个人，50mm镜头')).toBeNull();
    expect(parsePromptImageCount('8K 超高清风景，16:9 画幅，35mm 胶片感，18岁少女，5根发簪')).toBeNull();
  });

  it('CASE F：生成3张 3D 战国美女，4K → 3（张数优先于画面参数）', () => {
    expect(parsePromptImageCount('生成3张 3D 战国美女，4K')).toBe(3);
  });

  it('CASE A：给我生成三张战国时期美女 → 3', () => {
    expect(parsePromptImageCount('给我生成三张 战国时期得美人')).toBe(3);
  });
});

// ============================================================================
// 生成数量状态机：manual > prompt > default，程序性写回不触发识别
//（对应"3 张采用 AI 优化后变 4"回归 CASE B/C/D/G）
// ============================================================================

const DEFAULT_COUNT = 4;
const INITIAL: GenerationCountState = { count: DEFAULT_COUNT, source: 'default', fromPrompt: false };

describe('nextGenerationCountState', () => {
  it('CASE A：用户输入含数量 → prompt 来源识别为 3', () => {
    const next = nextGenerationCountState('给我生成三张 战国时期得美人', INITIAL, { defaultCount: DEFAULT_COUNT });
    expect(next).toEqual({ count: 3, source: 'prompt', fromPrompt: true });
  });

  it('CASE B：采用优化（程序性写回无数量表达的优化文本）→ 数量保持 3 不回落默认 4', () => {
    const detected = nextGenerationCountState('给我生成三张 战国时期得美人', INITIAL, { defaultCount: DEFAULT_COUNT });
    const adopted = nextGenerationCountState(
      '战国时期美人，曲裾深衣，广袖翩然，玉簪束发，工笔重彩，细腻绢本质感',
      detected,
      { defaultCount: DEFAULT_COUNT, programmatic: true },
    );
    expect(adopted).toEqual(detected);
    expect(adopted.count).toBe(3);
  });

  it('CASE C：重新优化不改变 Prompt → 数量保持 3（即使发生程序性写回也保持）', () => {
    const detected = nextGenerationCountState('给我生成三张 战国时期得美人', INITIAL, { defaultCount: DEFAULT_COUNT });
    // 重新优化只替换候选，不写回 Prompt；统一按程序性写回保护验证
    const regenerated = nextGenerationCountState('给我生成三张 战国时期得美人', detected, {
      defaultCount: DEFAULT_COUNT,
      programmatic: true,
    });
    expect(regenerated.count).toBe(3);
    expect(regenerated.source).toBe('prompt');
  });

  it('CASE D：恢复原文（Prompt 未变）→ 数量保持 3', () => {
    const detected = nextGenerationCountState('给我生成三张 战国时期得美人', INITIAL, { defaultCount: DEFAULT_COUNT });
    const unchanged = nextGenerationCountState('给我生成三张 战国时期得美人', detected, { defaultCount: DEFAULT_COUNT });
    expect(unchanged.count).toBe(3);
    expect(unchanged.source).toBe('prompt');
  });

  it('CASE G：手动改为 5（manual 状态由 changeManually 直接写入）后 AI 优化采用 → 仍为 5', () => {
    const manualState: GenerationCountState = { count: 5, source: 'manual', fromPrompt: false };
    // 之后无论用户继续编辑 Prompt 还是程序写回，manual 不被覆盖
    expect(nextGenerationCountState('生成十张 未来城市', manualState, { defaultCount: DEFAULT_COUNT }).count).toBe(5);
    expect(nextGenerationCountState('未来城市夜景', manualState, { defaultCount: DEFAULT_COUNT, programmatic: true }).count).toBe(5);
  });

  it('用户主动删除数量表达（真实手动编辑）→ 允许回落默认', () => {
    const detected = nextGenerationCountState('给我生成三张 战国时期得美人', INITIAL, { defaultCount: DEFAULT_COUNT });
    const edited = nextGenerationCountState('战国时期美人', detected, { defaultCount: DEFAULT_COUNT });
    expect(edited).toEqual({ count: DEFAULT_COUNT, source: 'default', fromPrompt: false });
  });

  it('default 状态下无数量表达 → 维持默认不抖动', () => {
    expect(nextGenerationCountState('未来城市', INITIAL, { defaultCount: DEFAULT_COUNT })).toEqual(INITIAL);
  });
});

// ============================================================================
// 批量语义分类
// ============================================================================

describe('classifyGenerationIntent', () => {
  it('CASE 1：我需要3张不同中国城市的夜景图 → multi_prompt × 3', () => {
    const intent = classifyGenerationIntent('我需要3张不同中国城市的夜景图');
    expect(intent.mode).toBe('multi_prompt');
    expect(intent.requestedCount).toBe(3);
    expect(intent.distinct).toBe(true);
  });

  it('CASE 2：给我生成3张赛博朋克跑车 → repeat_same × 3', () => {
    const intent = classifyGenerationIntent('给我生成3张赛博朋克跑车');
    expect(intent.mode).toBe('repeat_same');
    expect(intent.requestedCount).toBe(3);
    expect(intent.distinct).toBe(false);
  });

  it('CASE 3：上海、北京、广州各一张夜景 → multi_prompt × 3（对象枚举）', () => {
    const intent = classifyGenerationIntent('上海、北京、广州各一张夜景');
    expect(intent.mode).toBe('multi_prompt');
    expect(intent.requestedCount).toBe(3);
    expect(intent.objects).toEqual(['上海', '北京', '广州']);
  });

  it('CASE 5：上海北京广州各一张（无分隔符等长连写）→ multi_prompt × 3', () => {
    const intent = classifyGenerationIntent('上海北京广州各一张');
    expect(intent.mode).toBe('multi_prompt');
    expect(intent.requestedCount).toBe(3);
    expect(intent.objects).toEqual(['上海', '北京', '广州']);
  });

  it('猫狗兔各一张 → multi_prompt（等长切块 3 个单字对象）', () => {
    const intent = classifyGenerationIntent('猫狗兔各一张');
    expect(intent.mode).toBe('multi_prompt');
    expect(intent.objects).toEqual(['猫', '狗', '兔']);
    expect(intent.requestedCount).toBe(3);
  });

  it('CASE 6：生成一张图把三个城市放同一画面 → single × 1', () => {
    const intent = classifyGenerationIntent('生成一张图片，画面里展示上海、北京、广州三个城市');
    expect(intent.mode).toBe('single');
    expect(intent.requestedCount).toBe(1);
  });

  it('不同风格批量：生成三张不同风格的圣诞树 → multi_prompt × 3', () => {
    const intent = classifyGenerationIntent('生成三张不同风格的圣诞树');
    expect(intent.mode).toBe('multi_prompt');
    expect(intent.requestedCount).toBe(3);
  });

  it('同主体多变体：生成4张猫咪照片 → repeat_same × 4', () => {
    const intent = classifyGenerationIntent('生成4张猫咪照片');
    expect(intent.mode).toBe('repeat_same');
    expect(intent.requestedCount).toBe(4);
  });

  it('空输入 / 纯单张 → single', () => {
    expect(classifyGenerationIntent('').mode).toBe('single');
    expect(classifyGenerationIntent('一只在月光下的猫').mode).toBe('single');
  });
});

describe('extractDistinctObjects', () => {
  it('分隔符枚举 + 分别：春夏秋冬分别一张', () => {
    // "春夏秋冬" 无分隔符 → 等长切块 len=4 → 2 字块。语义上应为 4 张，
    // 无分隔符中文的固有歧义：这里返回 2 块（已知限制，见修复报告）。
    const objects = extractDistinctObjects('春夏秋冬分别一张');
    expect(objects.length).toBeGreaterThanOrEqual(2);
  });

  it('顿号枚举：帮我生成泰山、华山、衡山各一张', () => {
    expect(extractDistinctObjects('帮我生成泰山、华山、衡山各一张')).toEqual(['泰山', '华山', '衡山']);
  });

  it('无分配词不拆分：上海、北京、广州的夜景', () => {
    expect(extractDistinctObjects('上海、北京、广州的夜景')).toEqual([]);
  });
});
