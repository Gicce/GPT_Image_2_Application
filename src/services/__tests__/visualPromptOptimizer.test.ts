import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAgentRequest: vi.fn(),
  readImageData: vi.fn(),
  recordAiRoleUsage: vi.fn(),
  logAiTransport: vi.fn(),
}));

vi.mock('../api', () => ({ api: { runAgentRequest: mocks.runAgentRequest, readImageData: mocks.readImageData } }));
vi.mock('../../features/aiRouting/resolveModelForRole', () => ({
  resolveModelForRole: vi.fn(() => ({
    ok: true,
    resolved: { providerName: '智谱', displayName: 'GLM-5V-Turbo' },
    connection: {
      baseUrl: 'https://vision.example/v1', token: 'secret', model: 'glm-5v-turbo', billingMode: 'api',
      profileId: 'vision-1', profileName: '智谱', providerType: 'glm_official',
      modelEntity: { display_name: 'GLM-5V-Turbo', capabilities: ['vision', 'text'] },
    },
  })),
  recordAiRoleUsage: mocks.recordAiRoleUsage,
}));
vi.mock('../../features/aiRouting/aiRoutingLog', () => ({ logAiTransport: mocks.logAiTransport }));
vi.mock('../../features/aiProviders/providerError', () => ({
  buildProviderError: vi.fn(() => ({})),
  providerErrorCompact: vi.fn(() => '模型服务请求失败'),
}));

import { optimizeVisualEditPrompt, parseVisualPromptOptimizerReply } from '../visualPromptOptimizer';

const validReply = JSON.stringify({
  scene_summary: '奶油白桌面，双显示器与黑色主机',
  preserve: ['双屏位置', '桌面透视'],
  changes: ['增加雾粉色摆件'],
  uncertainties: ['Logo 文字较小'],
  positive_prompt: '以图片1为主编辑图，保持双屏布局与桌面透视，增加少量雾粉摆件',
  negative_prompt: '改变显示器数量，遮挡键盘，杂乱电线',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readImageData.mockImplementation(async (path: string) => `data:image/png;base64,${path}`);
  mocks.runAgentRequest.mockResolvedValue({ ok: true, reply: validReply });
});

describe('视觉提示词解析', () => {
  it('规范化字符串与列表并保留四类理解结果', () => {
    const parsed = parseVisualPromptOptimizerReply(`\n\`\`\`json\n${validReply}\n\`\`\``);
    expect(parsed?.understanding.summary).toContain('双显示器');
    expect(parsed?.understanding.preserve).toEqual(['双屏位置', '桌面透视']);
    expect(parsed?.understanding.changes).toEqual(['增加雾粉色摆件']);
    expect(parsed?.optimizedPrompt).toContain('图片1');
  });

  it('缺少画面摘要或正向提示词时拒绝半截结果', () => {
    expect(parseVisualPromptOptimizerReply('{"scene_summary":"画面"}')).toBeNull();
    expect(parseVisualPromptOptimizerReply('{"positive_prompt":"编辑"}')).toBeNull();
  });
});

describe('真实多模态请求', () => {
  it('按界面顺序读取全部图片并标记主编辑图和补充参考图', async () => {
    const outcome = await optimizeVisualEditPrompt({
      prompt: '保留结构，增加少女风配件',
      images: [
        { path: 'D:/main.png', name: 'main.png' },
        { path: 'D:/logo.png', name: 'logo.png' },
      ],
    });
    expect(outcome.ok).toBe(true);
    expect(mocks.readImageData.mock.calls.map(call => call[0])).toEqual(['D:/main.png', 'D:/logo.png']);
    const payload = mocks.runAgentRequest.mock.calls[0][0];
    expect(payload.role).toBe('vision_analysis');
    expect(payload.feature).toBe('image-studio-visual-prompt-optimize');
    expect(payload.model).toBe('glm-5v-turbo');
    expect(payload.messages[0].parts.filter((part: any) => part.part_type === 'image_url')).toHaveLength(2);
    const text = payload.messages[0].parts[0].text;
    expect(text).toContain('图片1（主编辑图）：main.png');
    expect(text).toContain('图片2（补充参考图）：logo.png');
  });

  it('任一图片读取失败时不发送不完整视觉请求', async () => {
    mocks.readImageData.mockRejectedValueOnce(new Error('missing'));
    const outcome = await optimizeVisualEditPrompt({ prompt: '修改背景', images: [{ path: 'D:/missing.png', name: 'missing.png' }] });
    expect(outcome).toEqual({ ok: false, error: '无法读取参考图片「missing.png」，请重新选择后再试。' });
    expect(mocks.runAgentRequest).not.toHaveBeenCalled();
  });

  it('首次结构异常时同模型最多修复一次', async () => {
    mocks.runAgentRequest
      .mockResolvedValueOnce({ ok: true, reply: '不是 JSON' })
      .mockResolvedValueOnce({ ok: true, reply: validReply });
    const outcome = await optimizeVisualEditPrompt({ prompt: '修改背景', images: [{ path: 'D:/main.png', name: 'main.png' }] });
    expect(outcome.ok).toBe(true);
    expect(mocks.runAgentRequest).toHaveBeenCalledTimes(2);
    expect(mocks.runAgentRequest.mock.calls[1][0].feature).toBe('image-studio-visual-prompt-repair');
  });
});
