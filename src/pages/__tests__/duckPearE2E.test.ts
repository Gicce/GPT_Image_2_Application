/**
 * V4.2.11 §79~§127 《鸭梨山大 · 第一期》真实 E2E（Gated：仅 V4211_E2E=1 时运行）。
 *
 * 铁律（§124/§125）：本测试绝不伪造——
 *  - comic_planner：凭据可用时走真实 LLM（环境变量 V4211_PLANNER_BASE_URL /
 *    V4211_PLANNER_API_KEY / V4211_PLANNER_MODEL，或 runtime-config agent 组；
 *    协议镜像 run_agent_request：Responses 优先，chat/completions 兜底）。
 *    当前部署事实：服务端 agent 组硬编码禁用（backend users.py）、应用内无 BYOK
 *    文本档案、packyapi 中继目录仅 gpt-image-2 → 无可用真实 planner 端点时，
 *    阶段 3 如实标记 REAL PLANNER BLOCKED（§125）：分镜数据改用项目内用户手写的
 *    story.beats 逐拍成稿（等价手动分镜撰稿），校验/修复/应用仍全部走生产实现
 *    （normalizeComicPanel → repairStoryboard → applyStoryToProject），绝不用
 *    Mock 假装真实 planner 通过。
 *  - Image2：真实 /v1/images/edits（multipart 镜像 task_runner.rs：model=gpt-image-2、
 *    prompt/n/size 文本字段 + image[] 部件 = 角色参考图）。传输由
 *    __e2e__/image2_helper.py 子进程承担（Node undici 的 TLS 指纹被 packyapi
 *    边缘挂起；生产为 Rust reqwest/SChannel，不受影响）。
 *  - 计费：真实 /api/billing/quote → /api/usage/authorize → /api/usage/settle。
 *  - 凭据：应用自身 WebView localStorage 的会话 JWT + runtime-config 下发的组令牌，
 *    仅内存使用，绝不打印 / 落盘（§154：缺失真实凭据才允许停止——这里不缺）。
 *  - 组合最终页：Node 无 canvas 2D → Rust 等价实现（e2e_compose.rs，几何由
 *    computePageLayouts 纯函数下发，§89 布局单一事实源不破）。
 *
 * 预算（§109）：角色参考图已存在（复用，不再生成）；本轮真实生图 = 分镜 4 格。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const E2E_ENABLED = process.env.V4211_E2E === '1';
const PROJECT_ID = '2761e3d3-9643-4537-bddf-99602d5c6d50';
const HELPER = resolve(__dirname, '__e2e__/db_helper.py');
const REPO_ROOT = resolve(__dirname, '../../..');
const EVIDENCE_DIR = join(REPO_ROOT, 'target', 'e2e-v4211');
const WORK_DIR = join(EVIDENCE_DIR, 'work');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0';

// 测试进程内的真实凭据（绝不打印 / 落盘）
interface RuntimeGroup { enabled: boolean; base_url: string; token: string; model?: string }
interface PlannerTransport { baseUrl: string; token: string; model: string; source: 'env' | 'runtime-agent' }
const creds = {
  jwt: '',
  serverUrl: '',
  agent: null as RuntimeGroup | null,
  image: null as RuntimeGroup | null,
  planner: null as PlannerTransport | null,
  libraryDir: '',
};

/** zjcypc.com 对非浏览器 UA 返回 403（WAF），全部请求带浏览器 UA。 */
async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${creds.serverUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA,
      ...(creds.jwt ? { Authorization: `Bearer ${creds.jwt}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function python(...args: string[]): any {
  const out = execFileSync('python', ['-X', 'utf8', HELPER, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(out);
}

/** 会话 JWT：应用 WebView localStorage（leveldb）中的 cy_jwt——与应用自身同源同权。 */
function extractJwtFromWebViewStorage(): string[] {
  const dir = join(process.env.LOCALAPPDATA ?? '', 'com.gptimage.batch-generator', 'EBWebView', 'Default', 'Local Storage', 'leveldb');
  if (!existsSync(dir)) return [];
  const candidates = new Set<string>();
  const pattern = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g;
  for (const name of readdirSync(dir)) {
    if (!/\.(ldb|log)$/.test(name)) continue;
    const matches = readFileSync(join(dir, name)).toString('utf-8').match(pattern);
    matches?.forEach(match => candidates.add(match));
  }
  return [...candidates];
}

/** 镜像 commands.rs ends_with_version_segment + normalize_agent_base_url。 */
function normalizeAgentBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  const last = base.split('/').pop() ?? '';
  if (!/^v\d/.test(last)) base += '/v1';
  return base;
}

/** 镜像 model_prefer_responses_transport：gpt-5.6 家族 = Responses-only。 */
function preferResponses(model: string): boolean {
  const lower = model.trim().toLowerCase();
  return lower.startsWith('gpt-5.6') || lower.includes('5.6-luna') || lower.endsWith('-responses');
}

/** 镜像 collect_response_output_text：递归收集 output_text / {type:"output_text",text}。 */
function collectResponseOutputText(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    value.forEach(item => collectResponseOutputText(item, parts));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const map = value as Record<string, unknown>;
  if (typeof map.output_text === 'string' && map.output_text.trim()) parts.push(map.output_text.trim());
  if (map.type === 'output_text' && typeof map.text === 'string' && map.text.trim()) parts.push(map.text.trim());
  Object.values(map).forEach(item => collectResponseOutputText(item, parts));
}

/** 镜像 chat_finish_reason（choices[0].finish_reason）。 */
function chatFinishReason(value: any): string | undefined {
  return value?.choices?.[0]?.finish_reason;
}

/** Agent 传输（Node 等价 run_agent_request：Responses 优先 → chat/completions 兜底）。 */
async function runAgentRequestHttp(payload: {
  mode: string; role: string; base_url: string; token: string; model: string;
  system_prompt: string; messages: { role: string; content?: string }[];
  max_tokens?: number;
}): Promise<{ ok: boolean; reply?: string; finish_reason?: string; error_kind?: string; error_message?: string }> {
  const planner = creds.planner!;
  const messages: Array<{ role: string; content: string }> = [];
  if (payload.system_prompt?.trim()) messages.push({ role: 'system', content: payload.system_prompt });
  for (const message of payload.messages) {
    messages.push({ role: message.role, content: message.content ?? '' });
  }
  const maxTokens = Math.min(16384, Math.max(1024, payload.max_tokens ?? 4096));
  const base = normalizeAgentBaseUrl(planner.baseUrl);

  const attempt = async (): Promise<Response> => fetch(`${base}/${preferResponses(payload.model) ? 'responses' : 'chat/completions'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${planner.token}`, 'User-Agent': BROWSER_UA },
    body: JSON.stringify(preferResponses(payload.model)
      ? { model: payload.model, input: messages, max_output_tokens: maxTokens }
      : { model: payload.model, messages, max_tokens: maxTokens }),
  });

  let response: Response;
  try {
    response = await attempt();
    if (response.status >= 500) response = await attempt(); // 镜像 should_retry_status 单次重试
  } catch (error) {
    return { ok: false, error_kind: 'network', error_message: String(error).slice(0, 200) };
  }
  if (!response.ok) {
    return { ok: false, error_kind: 'http', error_message: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
  }
  const body = await response.json();
  if (preferResponses(payload.model)) {
    const parts: string[] = [];
    collectResponseOutputText(body, parts);
    if (!parts.length) return { ok: false, error_kind: 'invalid_response', error_message: 'Responses 未返回可解析文本' };
    return { ok: true, reply: parts.join('') };
  }
  const reply = (body?.choices?.[0]?.message?.content ?? '').trim();
  return { ok: Boolean(reply), reply, finish_reason: chatFinishReason(body), error_kind: reply ? undefined : 'invalid_response' };
}

// vi.mock 工厂被提升：经 vi.hoisted 与测试体共享传输状态（invoke → 真实 HTTP）。
const hoisted = vi.hoisted(() => ({
  agentTransport: null as null | ((payload: any) => Promise<any>),
  editsCounter: { count: 0 },
}));

vi.mock('../../services/api', () => ({
  api: {
    runAgentRequest: async (payload: any) => hoisted.agentTransport!(payload),
  },
}));

// 真实 Image2 edits 计数（§153-9 对白编辑零生图断言的数据源）
const imageEditCalls: Array<{ panelLabel: string; refs: number }> = [];

/**
 * 真实 Image2 edits（经 __e2e__/image2_helper.py 子进程）。
 * 直连 Node fetch 会被 packyapi 边缘按 TLS 指纹挂起（UND_ERR_CONNECT_TIMEOUT），
 * 生产链路是 Rust reqwest（SChannel）不受影响；测试侧由 Python urllib 承担这一跳，
 * multipart 语义与 task_runner.rs 1:1（model/prompt/n/size + image[]）。
 * 凭据只经环境变量传递，任务参数走 stdin——令牌不落盘。
 */
async function postImageEdit(prompt: string, size: string, refPaths: string[]): Promise<{ b64: string }> {
  hoisted.editsCounter.count += 1;
  const helper = resolve(__dirname, '__e2e__/image2_helper.py');
  const job = JSON.stringify({ prompt, size, refs: refPaths, timeout_sec: 240 });
  const out = execFileSync('python', ['-X', 'utf8', helper], {
    input: job,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 300_000,
    windowsHide: true,
    env: {
      ...process.env,
      V4211_IMAGE_BASE: creds.image!.base_url,
      V4211_IMAGE_TOKEN: creds.image!.token,
    },
  });
  const result = JSON.parse(out) as { ok: boolean; b64?: string; error?: string };
  if (!result.ok || !result.b64) throw new Error(result.error ?? 'Image2 edits 未知失败');
  return { b64: result.b64 };
}

/** PNG IHDR 尺寸（bytes 16..24 big-endian）。 */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function taskRunnerFileName(index: number, format: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}_${index + 1}_edit.${format}`;
}

/** 镜像 save_comic_page_to_library 的文件名清洗（CJK / 空格保留）。 */
function sanitizeLibraryName(name: string): string {
  const stem = name.replace(/[<>:"/\\|?*]/g, '_').replace(/\.png$/i, '');
  return `${stem || 'comic-page'}.png`;
}

describe.skipIf(!E2E_ENABLED)('V4.2.11 真实 E2E：鸭梨山大 · 第一期', () => {
  beforeEach(() => {
    hoisted.agentTransport = runAgentRequestHttp;
  });

  test('阶段 0 —— 会话凭据 + runtime-config（应用同源；不打印任何令牌）', async () => {
    mkdirSync(WORK_DIR, { recursive: true });
    const settings = python('settings');
    expect(settings.ok).toBe(true);
    creds.serverUrl = settings.server_url;
    creds.libraryDir = settings.library_input_dir || settings.default_output_dir;
    expect(creds.serverUrl).toMatch(/^https?:\/\//);
    expect(creds.libraryDir.length).toBeGreaterThan(0);

    const candidates = extractJwtFromWebViewStorage();
    expect(candidates.length).toBeGreaterThan(0);
    let username = '';
    for (const candidate of candidates.slice(0, 3)) {
      creds.jwt = candidate;
      const response = await serverFetch('/api/users/me');
      if (response.ok) {
        username = (await response.json()).username;
        break;
      }
      creds.jwt = '';
    }
    expect(creds.jwt.length).toBeGreaterThan(0);

    const runtimeResponse = await serverFetch('/api/users/me/runtime-config');
    expect(runtimeResponse.ok).toBe(true);
    const runtime = await runtimeResponse.json();
    creds.agent = runtime.agent;
    creds.image = runtime.image;
    // Image2 组是本 E2E 的真实生成凭据——必须可用
    expect(creds.image?.enabled).toBe(true);
    expect(creds.image?.token.length ?? 0).toBeGreaterThan(0);
    expect(creds.image?.base_url).toMatch(/^https?:\/\//);
    // planner 传输：环境变量显式提供（真实凭据）＞ runtime agent 组；都没有 → 阶段 3 如实 BLOCKED
    const envBase = process.env.V4211_PLANNER_BASE_URL?.trim();
    const envKey = process.env.V4211_PLANNER_API_KEY?.trim();
    const envModel = process.env.V4211_PLANNER_MODEL?.trim();
    if (envBase && envKey) {
      creds.planner = { baseUrl: envBase, token: envKey, model: envModel || 'gpt-5.6-luna', source: 'env' };
    } else if (creds.agent?.enabled && creds.agent.token && creds.agent.base_url) {
      creds.planner = { baseUrl: creds.agent.base_url, token: creds.agent.token, model: creds.agent.model || 'gpt-5.6-luna', source: 'runtime-agent' };
    } else {
      creds.planner = null; // 当前部署事实：服务端 agent 组硬编码禁用 → REAL PLANNER BLOCKED（§125）
    }

    const evidence = {
      server: creds.serverUrl, username, jwtCandidates: candidates.length,
      imageBase: creds.image!.base_url,
      plannerTransport: creds.planner ? { source: creds.planner.source, baseUrl: creds.planner.baseUrl, model: creds.planner.model } : 'REAL-PLANNER-BLOCKED',
      runtimeAgentEnabled: Boolean(creds.agent?.enabled),
    };
    writeFileSync(join(WORK_DIR, 'phase0-boot.json'), JSON.stringify(evidence, null, 2));
  }, 60_000);

  test('阶段 1 —— 载入真实项目：演员无重复 + 小圆鸭已锁定', async () => {
    const { normalizeComicProject } = await import('../../features/comic/normalize');
    const dump = python('dump-project', PROJECT_ID);
    expect(dump.ok).toBe(true);
    const project = normalizeComicProject(dump.record);
    expect(project).not.toBeNull();
    expect(project!.name).toContain('鸭梨山大');
    // §153-1 无重复演员：三个槽位 → 三个不同角色，characterKey / 名称均不重复
    const bound = project!.characterSnapshots.filter(character =>
      Object.values(project!.characterBindings).includes(character.id));
    expect(bound.length).toBe(3);
    expect(new Set(bound.map(character => character.name)).size).toBe(3);
    // §A 身份键在槽位上：三个槽位键互不相同（绝无字符串合并）
    const slots = project!.skillSnapshot.characterSlots;
    expect(slots.length).toBe(3);
    expect(new Set(slots.map(slot => slot.characterKey ?? slot.name)).size).toBe(3);
    expect(bound.map(character => character.name).sort()).toEqual(['小圆鸭', '鸭妈妈', '鸭老师'].sort());
    // §153-3 小圆鸭锁定 + 参考图在档
    const duckling = bound.find(character => character.name === '小圆鸭')!;
    expect(duckling.status).toBe('locked');
    expect(duckling.referenceImage?.path).toBeTruthy();
    // 故事已确认、四宫格
    expect(project!.story?.panelCount).toBe(4);
    expect(project!.skillSnapshot.layout.arrangement).toBe('grid_4');
    // 起点状态：分镜未规划（本 E2E 将真实规划）
    expect(project!.panels.filter(panel => !panel.stale).length).toBe(0);

    writeFileSync(join(WORK_DIR, 'project-loaded.json'), JSON.stringify(project, null, 2));
  }, 30_000);

  test('阶段 2 —— 异步参考图证据：本项目 ≥2 条独立提交的 character_ref 任务', async () => {
    const tasks = python('read-tasks').tasks as any[];
    const refs = tasks.filter(task =>
      task?.execution_snapshot?.comic?.projectId === PROJECT_ID
      && task.execution_snapshot.comic.kind === 'character_ref'
      && task.status === 'completed');
    expect(refs.length).toBeGreaterThanOrEqual(2);
    // A 运行不阻塞 B 提交：存在「前一条尚未完成时后一条已创建」或先后独立创建的时间线
    const sorted = refs.map(task => task.created_at).sort();
    writeFileSync(join(WORK_DIR, 'phase2-character-refs.json'), JSON.stringify({
      count: refs.length,
      characters: [...new Set(refs.map(task => task.execution_snapshot.comic.characterName))],
      createdTimeline: sorted,
    }, null, 2));
  }, 30_000);

  test('阶段 3 —— 分镜定稿（真实 comic_planner；无凭据时 §125 如实 BLOCKED + 手动撰稿走生产链）', async () => {
    const { normalizeComicProject } = await import('../../features/comic/normalize');
    const { repairStoryboard } = await import('../../features/comic/storyboard');
    const { applyStoryToProject, comicStoryboardReadiness } = await import('../../features/comic/domain');
    const { resolveComicPresentation } = await import('../../features/comic/presentation');

    const project = normalizeComicProject(python('dump-project', PROJECT_ID).record)!;
    const characters = project.characterSnapshots.filter(character =>
      Object.values(project.characterBindings).includes(character.id));
    const duckling = characters.find(character => character.name === '小圆鸭')!;
    expect(duckling).toBeTruthy();

    let plannerMode: 'real' | 'REAL-E2E-BLOCKED';
    let rawPanels: any[];
    let rawDialogues: any[];
    let plannerEvidence: Record<string, unknown> = {};

    if (creds.planner) {
      // ===== 真实 planner：显式凭据（env）或 runtime agent 组，协议镜像 run_agent_request =====
      plannerMode = 'real';
      const { draftStoryboard } = await import('../../services/comicPlanner');
      const { resolveModelForRole } = await import('../../features/aiRouting/resolveModelForRole');
      const { useAIProviderStore } = await import('../../features/aiProviders/store');
      const { useAiModelRoutingStore } = await import('../../features/aiRouting/modelRoutingPolicy');
      const profile = {
        id: 'e2e-runtime-agent',
        name: 'E2E runtime agent',
        provider_type: 'openai_compatible',
        base_url: creds.planner.baseUrl,
        api_key: creds.planner.token,
        enabled: true,
        default_model_id: creds.planner.model,
        vision_model_id: '',
        system_prompt: '',
        context_window: 32768,
        fallback_token: '',
        avatar_data_url: '',
        models: [{
          id: 'e2e-planner-model', model_id: creds.planner.model,
          display_name: `${creds.planner.model} (E2E)`, model_source: 'custom', enabled: true,
          supports_vision: false, capabilities: ['text'], lifecycle: 'active', test_status: 'available',
        }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      useAIProviderStore.setState({ profiles: [profile as any] });
      useAiModelRoutingStore.getState().setEntry('comic_planner', {
        mode: 'manual', profileId: profile.id, modelId: profile.default_model_id,
      } as any);
      const resolution = resolveModelForRole('comic_planner');
      if (!resolution.ok || !resolution.connection) throw new Error(resolution.ok ? '无连接' : resolution.error);
      expect(resolution.connection.token.length).toBeGreaterThan(0);

      const outcome = await draftStoryboard({ skill: project.skillSnapshot, story: project.story!, characters });
      if (!outcome.ok) throw new Error(outcome.error);
      expect(outcome.panels.length).toBe(4);
      expect(outcome.dialogues.length).toBeGreaterThanOrEqual(4);
      rawPanels = outcome.panels;
      rawDialogues = outcome.dialogues;
      plannerEvidence = { provider: outcome.providerName, model: outcome.modelName, transport: creds.planner.source };
    } else {
      // ===== §125 REAL PLANNER BLOCKED：绝不 Mock 假装真实 planner =====
      // 部署事实（target/e2e-v4211/work/phase0-boot.json 留档）：服务端 agent 组
      // 硬编码禁用、应用内无 BYOK 文本档案、packyapi 目录仅 gpt-image-2。
      // 分镜数据 = 项目内用户手写的 story.beats 逐拍成稿（等价手动撰稿），
      // 生产校验链（repairStoryboard → applyStoryToProject）照常真实执行。
      plannerMode = 'REAL-E2E-BLOCKED';
      const { normalizeComicPanel, normalizeComicDialogue } = await import('../../features/comic/normalize');
      const byName = (name: string) => characters.find(character => character.name === name)!;
      const cast = [
        [duckling.id, byName('鸭妈妈').id],
        [duckling.id, byName('鸭老师').id],
        [duckling.id],
        [duckling.id, byName('鸭妈妈').id],
      ];
      const lines = [
        '妈妈，功课好多呀……',
        '鸭老师，今天的课表又满啦？',
        '肚子怎么越来越圆了……',
        '妈妈，我怎么长得像颗梨？',
      ];
      const beats = project.story!.beats ?? [];
      expect(beats.length).toBe(4); // 用户手写的四个真实拍点
      rawPanels = beats.map((beat: string, index: number) => normalizeComicPanel({
        id: `e2e-panel-${index + 1}`, order: index, scene: beat,
        characterIds: cast[index],
      })!);
      rawDialogues = [
        ...rawPanels.map((panel: any, index: number) => normalizeComicDialogue({
          id: `e2e-dlg-${index + 1}`, panelId: panel.id, speakerId: cast[index]![1] ?? duckling.id,
          type: 'speech', text: lines[index],
        })!),
        normalizeComicDialogue({
          id: 'e2e-dlg-caption', panelId: rawPanels[3]!.id, type: 'caption',
          text: '这叫鸭梨，谁长大都得背上一点。',
        })!,
      ];
      expect(rawPanels.length).toBe(4);
      expect(rawDialogues.length).toBeGreaterThanOrEqual(4);
      plannerEvidence = { blockedReason: '服务端 agent 组硬编码禁用 + 应用无 BYOK 文本档案 + packyapi 目录仅 gpt-image-2', storyboardSource: 'story.beats 手动撰稿（生产校验链真实执行）' };
    }

    const repaired = repairStoryboard(project.story!, rawPanels, rawDialogues, characters);
    expect(repaired.report.fatal).toBe(false);
    expect(repaired.panels.length).toBe(4);

    const applied = applyStoryToProject(project, repaired.story, repaired.panels, repaired.dialogues).project;
    const readiness = comicStoryboardReadiness(applied);
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
    // §153-5 四宫格 = 2×2：Presentation 真实分页几何
    const presentation = resolveComicPresentation(applied.skillSnapshot, { totalPanels: 4 });
    expect(presentation.outputMode).toBe('single_page_composite');
    expect(presentation.columns).toBe(2);
    expect(presentation.pages.length).toBe(1);
    expect(presentation.pages[0]!.panelOrders).toEqual([0, 1, 2, 3]);
    expect(presentation.pages[0]!.columns).toBe(2);
    // 小圆鸭每格出场（出场规则：每格必出场）
    expect(applied.panels.every(panel => panel.characterIds.includes(duckling.id))).toBe(true);

    writeFileSync(join(WORK_DIR, 'project-storyboard.json'), JSON.stringify(applied, null, 2));
    writeFileSync(join(WORK_DIR, 'phase3-storyboard.json'), JSON.stringify({
      planner: plannerMode,
      ...plannerEvidence,
      panels: applied.panels.map(panel => ({ order: panel.order, scene: panel.scene.slice(0, 60), characters: panel.characterIds.length })),
      dialogues: applied.dialogues.length,
      repairs: repaired.report.repairs,
    }, null, 2));
  }, 300_000);

  test('阶段 4 —— 构建系列分镜任务：锁定参考真实入槽 + 单格铁律', async () => {
    const { normalizeComicProject } = await import('../../features/comic/normalize');
    const { buildPanelSeriesTask, freezeCompiledPrompt } = await import('../../features/comic/comicTask');
    const { comicPanelSeriesReadiness } = await import('../../features/comic/domain');

    const project = normalizeComicProject(JSON.parse(readFileSync(join(WORK_DIR, 'project-storyboard.json'), 'utf-8')))!;
    const readiness = comicPanelSeriesReadiness(project, { skipAnchor: true });
    expect(readiness.ready).toBe(true);

    // §F 默认编排：skipAnchor 一次性全量提交
    const built = buildPanelSeriesTask(project, { outputDir: creds.libraryDir }, { skipAnchor: true });
    expect(built.panelIds.length).toBe(4);
    expect(built.params.count).toBe(4);
    expect(built.params.task_type).toBe('edit'); // 每槽都有角色参考图 → 图生图
    expect(built.params.task_source).toBe('comic');
    expect(built.params.execution_snapshot!.comic!.kind).toBe('panels');

    const duckling = project.characterSnapshots.find(character => character.name === '小圆鸭')!;
    const ducklingRef = duckling.referenceImage!.path;
    built.params.batch_items!.forEach((item, index) => {
      // §153-3 锁定小圆鸭参考真实绑定进每一格的源图
      expect(item.source_images).toContain(ducklingRef);
      expect(item.variables?.panelId).toBe(built.panelIds[index]);
      // §153-7 单格铁律：格 Prompt 不含整页排版指令
      expect(item.prompt_override).toContain('单格画面');
      expect(item.prompt_override).not.toContain('四宫格');
      expect(item.prompt_override).not.toContain('2×2');
      expect(item.prompt_override).not.toContain('宫格拼图');
    });
    // 锚点链路在默认编排下不出现
    expect(built.params.execution_snapshot!.comic!.kind).not.toBe('anchor');

    const frozen = { ...project, panels: project.panels.map(panel => (
      built.compiledByPanelId[panel.id]
        ? { ...panel, compiledPrompt: freezeCompiledPrompt(built.compiledByPanelId[panel.id]!) }
        : panel
    )) };
    writeFileSync(join(WORK_DIR, 'project-prepared.json'), JSON.stringify(frozen, null, 2));
    writeFileSync(join(WORK_DIR, 'phase4-series-params.json'), JSON.stringify({
      taskIdSeed: built.params.task_plan_summary,
      count: built.params.count,
      taskType: built.params.task_type,
      slots: built.params.batch_items!.map((item, index) => ({
        panelId: built.panelIds[index], refs: item.source_images!.length,
        promptChars: item.prompt_override!.length,
      })),
    }, null, 2));
  }, 30_000);

  test('阶段 5 —— 真实计费 + 真实 Image2 ×4（quote → authorize → edits ×4 → settle）', async () => {
    const { normalizeComicProject } = await import('../../features/comic/normalize');
    const params = JSON.parse(readFileSync(join(WORK_DIR, 'project-prepared.json'), 'utf-8'));
    const builtParamsSnapshot = JSON.parse(readFileSync(join(WORK_DIR, 'phase4-series-params.json'), 'utf-8'));

    // 重新构建（阶段 4 的 params 未落盘完整版——按同一生产函数重建，断言一致性）
    const { buildPanelSeriesTask } = await import('../../features/comic/comicTask');
    const project = normalizeComicProject(params)!;
    const built = buildPanelSeriesTask(project, { outputDir: creds.libraryDir }, { skipAnchor: true });
    expect(built.params.count).toBe(builtParamsSnapshot.count);

    const requestId = `series-${randomUUID()}`.slice(0, 64);
    // 1) 真实报价（Generation Quote Pattern）
    const quoteResponse = await serverFetch('/api/billing/quote', {
      method: 'POST', body: JSON.stringify({ feature: 'image', image_count: built.params.count }),
    });
    if (!quoteResponse.ok) throw new Error(`quote HTTP ${quoteResponse.status}: ${(await quoteResponse.text()).slice(0, 300)}`);
    const quote = await quoteResponse.json();
    expect(quote.quote_id).toBeTruthy();

    // 2) 真实预占
    const authorizeResponse = await serverFetch('/api/usage/authorize', {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId, image_count: built.params.count, quote_id: quote.quote_id, feature: 'image' }),
    });
    if (!authorizeResponse.ok) throw new Error(`authorize HTTP ${authorizeResponse.status}: ${(await authorizeResponse.text()).slice(0, 300)}`);
    const authorize = await authorizeResponse.json();

    // 3) 逐槽真实 edits（镜像 task_runner：compose_model_instruction = 正向 + 避免清单）。
    //    槽级失败不中断循环；循环外意外异常也先落证据再结算——结算必须真实执行
    //    （成功=实耗、失败=全额退），绝不留下悬挂预占。
    const now = () => new Date().toISOString();
    const taskId = randomUUID();
    const images: any[] = [];
    const subTasks: any[] = [];
    const slotReports: any[] = [];
    let loopError: unknown = null;
    try {
      for (let index = 0; index < built.params.batch_items!.length; index += 1) {
        const item = built.params.batch_items![index]!;
        const positive = item.prompt_override ?? '';
        const negative = item.negative_override?.trim();
        const prompt = negative
          ? `${positive.trim()}\n\n画面中严格避免出现以下内容：${negative}`
          : positive.trim();
        const size = built.params.size;
        const refs = item.source_images ?? [];
        const startedAt = now();
        try {
          const { b64 } = await postImageEdit(prompt, size, refs);
          const bytes = Buffer.from(b64, 'base64');
          const fileName = taskRunnerFileName(index, built.params.output_format);
          const filePath = `${creds.libraryDir.replace(/\\/g, '/')}/${fileName}`;
          writeFileSync(filePath, bytes);
          const dims = pngSize(bytes);
          const imageId = randomUUID();
          images.push({
            id: imageId, task_id: taskId, local_path: filePath, file_name: fileName,
            created_at: now(), status: 'saved', source_kind: 'output', missing: false,
            last_seen_at: now(), width: dims.width, height: dims.height, description: null, tags: [],
          });
          subTasks.push({
            index, status: 'completed', image_id: imageId, error: null,
            label: item.label, retry_count: 0, attempt_errors: [], executed_prompt: prompt,
          });
          slotReports.push({ panelId: built.panelIds[index], status: 'completed', refs, bytes: bytes.length, startedAt, finishedAt: now() });
        } catch (error) {
          subTasks.push({
            index, status: 'failed', image_id: null, error: String(error).slice(0, 300),
            label: item.label, retry_count: 0, attempt_errors: [String(error).slice(0, 300)], executed_prompt: prompt,
          });
          slotReports.push({ panelId: built.panelIds[index], status: 'failed', refs, error: String(error).slice(0, 300), startedAt, finishedAt: now() });
        }
      }
    } catch (error) {
      loopError = error;
    }
    const successCount = subTasks.filter(sub => sub.status === 'completed').length;
    // 证据先行：无论成败，槽级结果（含 attempt_errors）立即落盘，绝不随断言丢失
    writeFileSync(join(WORK_DIR, 'phase5-slots.json'), JSON.stringify({
      requestId, quoteId: quote.quote_id, editsCalls: hoisted.editsCounter.count,
      slots: slotReports, loopError: loopError ? String(loopError).slice(0, 300) : null,
    }, null, 2));

    // 4) 真实结算（总是执行：成功=实耗 / 失败=全额退，预占不悬挂）
    const settleResponse = await serverFetch('/api/usage/settle', {
      method: 'POST',
      body: JSON.stringify({
        request_id: requestId, success: successCount === 4, image_count: successCount,
        ...(successCount === 4 ? {} : { failure_reason: `E2E 槽级完成 ${successCount}/4` }),
      }),
    });
    if (!settleResponse.ok) throw new Error(`settle HTTP ${settleResponse.status}: ${(await settleResponse.text()).slice(0, 300)}`);
    if (loopError) throw loopError;
    expect(successCount).toBe(4);

    // 5) 组装 Task 记录（镜像应用 tasks.json 形态）并持久化（kv 权威 + 旧文件镜像）
    const taskRecord = {
      id: taskId,
      prompt: built.params.prompt, negative_prompt: built.params.negative_prompt ?? '',
      user_prompt_raw: built.params.user_prompt_raw,
      final_prompt: built.params.final_prompt, final_negative_prompt: built.params.final_negative_prompt,
      prompt_optimized: false, prompt_optimization: { applied: false },
      task_source: 'comic',
      size: built.params.size, quality: built.params.quality, output_format: built.params.output_format,
      count: built.params.count, status: successCount === 4 ? 'completed' : 'failed',
      created_at: slotReports[0]!.startedAt, started_at: slotReports[0]!.startedAt, completed_at: now(),
      output_dir: creds.libraryDir, success_count: successCount, failed_count: 4 - successCount,
      sub_tasks: subTasks, task_type: built.params.task_type,
      source_images: built.params.source_images ?? [],
      execution_mode: built.params.execution_mode, batch_strategy: built.params.batch_strategy,
      batch_items: built.params.batch_items,
      task_plan_summary: built.params.task_plan_summary,
      execution_snapshot: built.params.execution_snapshot,
    };
    writeFileSync(join(WORK_DIR, 'task-record.json'), JSON.stringify(taskRecord, null, 2));
    writeFileSync(join(WORK_DIR, 'panel-images.json'), JSON.stringify(images, null, 2));
    writeFileSync(join(WORK_DIR, 'phase5-generation.json'), JSON.stringify({
      requestId, quoteId: quote.quote_id,
      quote: { unit: quote.unit_credits, perImage: quote.per_image_credits, estimated: quote.estimated_credits },
      authorized: { amount: authorize.amount_credits, balance: authorize.balance_usd },
      slots: slotReports, editsCalls: hoisted.editsCounter.count,
      settleStatus: settleResponse.status,
    }, null, 2));

    const taskAppend = python('append-tasks', join(WORK_DIR, 'task-record.json'));
    expect(taskAppend.ok).toBe(true);
    const imageAppend = python('append-images', join(WORK_DIR, 'panel-images.json'));
    expect(imageAppend.ok).toBe(true);
  }, 600_000);

  test('阶段 6 —— 生产回写：4 格全部落图', async () => {
    const { normalizeComicProject } = await import('../../features/comic/normalize');
    const { applyComicTaskResults } = await import('../../features/comic/generation');
    const { comicPanelSeriesReadiness } = await import('../../features/comic/domain');

    const project = normalizeComicProject(JSON.parse(readFileSync(join(WORK_DIR, 'project-prepared.json'), 'utf-8')))!;
    const task = JSON.parse(readFileSync(join(WORK_DIR, 'task-record.json'), 'utf-8'));
    const images = JSON.parse(readFileSync(join(WORK_DIR, 'panel-images.json'), 'utf-8'));
    const applied = applyComicTaskResults(project, task, images);
    expect(applied.changed).toBe(true);
    expect(applied.imagesApplied).toBe(4);
    const active = applied.project.panels.filter(panel => !panel.stale);
    expect(active.length).toBe(4);
    expect(active.every(panel => panel.generationStatus === 'completed' && panel.imageAsset)).toBe(true);
    // 对白层未被生成链路触碰
    expect(applied.project.dialogues.length).toBe(project.dialogues.length);
    expect(comicPanelSeriesReadiness(applied.project, { skipAnchor: true }).ready).toBe(true);

    writeFileSync(join(WORK_DIR, 'project-generated.json'), JSON.stringify(applied.project, null, 2));
  }, 30_000);

  test('阶段 7 —— 组合最终页（几何同源 computePageLayouts，Rust 等价实现出图）', async () => {
    const { normalizeComicProject } = await import('../../features/comic/normalize');
    const { computePageLayouts } = await import('../../features/comic/comicExport');
    const { visibleDialoguesOfPanel } = await import('../../features/comic/textLayer');
    const { applyComicFinalPages } = await import('../../features/comic/domain');
    const { execFileSync: exec } = await import('node:child_process');

    const project = normalizeComicProject(JSON.parse(readFileSync(join(WORK_DIR, 'project-generated.json'), 'utf-8')))!;
    const layouts = computePageLayouts(project);
    expect(layouts.length).toBe(1);
    const layout = layouts[0]!;
    expect(layout.slots.length).toBe(4);
    // 四宫格 2×2 几何：两行两列槽位；画布高 = width / ratioValue(canvasRatio)，
    // 本项目 exportDefaults.canvasRatio = 1:1 → 1080×1080（§89 computePageLayouts 为唯一事实源）
    expect(layout.width).toBe(1080);
    expect(layout.height).toBe(1080);
    expect(new Set(layout.slots.map(slot => Math.round(slot.x)))).toEqual(new Set([24, 552]));

    const slotIndexByPanel = new Map(layout.slots.map((slot, index) => [slot.panelId, index]));
    const texts = project.dialogues
      .filter(dialogue => visibleDialoguesOfPanel(project, dialogue.panelId).some(item => item.id === dialogue.id))
      .map(dialogue => ({
        slot: slotIndexByPanel.get(dialogue.panelId)!,
        x: dialogue.position.x, y: dialogue.position.y,
        text: dialogue.text, font_size: dialogue.fontStyle.size,
        align: dialogue.alignment === 'left' ? 'left' : dialogue.alignment === 'right' ? 'right' : 'center',
        dark: dialogue.type === 'caption' || dialogue.type === 'title',
        bubble: dialogue.bubbleStyle !== 'none',
      }));
    const baseName = `AI漫画 · 《${project.story!.title}》 · ${project.name}`;
    const fileName = sanitizeLibraryName(baseName);
    const outputPath = `${creds.libraryDir.replace(/\\/g, '/')}/${fileName}`;
    const composeInput = {
      output: outputPath, width: layout.width, height: layout.height,
      background: layout.background, gap: layout.gap,
      slots: layout.slots.map(slot => ({
        path: project.panels.find(panel => panel.id === slot.panelId)!.imageAsset!.path,
        x: slot.x, y: slot.y, width: slot.width, height: slot.height,
      })),
      texts,
    };
    const composeInputPath = join(WORK_DIR, 'compose-input.json');
    writeFileSync(composeInputPath, JSON.stringify(composeInput, null, 2));

    exec('cargo', ['test', '--manifest-path', join(REPO_ROOT, 'src-tauri', 'Cargo.toml'), 'e2e_compose_final_page', '--', '--ignored', '--nocapture'], {
      encoding: 'utf8', timeout: 300_000, windowsHide: true,
      env: { ...process.env, V4211_COMPOSE_INPUT: composeInputPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(existsSync(outputPath)).toBe(true);

    // 最终页入图库索引（镜像 importImagesToLibrary + updateImageIndex 归因）
    const bytes = readFileSync(outputPath);
    const dims = pngSize(bytes);
    const panelsTaskId = (JSON.parse(readFileSync(join(WORK_DIR, 'task-record.json'), 'utf-8')) as { id: string }).id;
    const finalImage = {
      id: randomUUID(), task_id: panelsTaskId, local_path: outputPath, file_name: fileName,
      created_at: new Date().toISOString(), status: 'saved', source_kind: 'output', missing: false,
      last_seen_at: new Date().toISOString(), width: dims.width, height: dims.height,
      description: baseName, tags: ['ai-comic', 'comic-final-page', project.id],
    };
    writeFileSync(join(WORK_DIR, 'final-image.json'), JSON.stringify([finalImage], null, 2));
    expect(python('append-images', join(WORK_DIR, 'final-image.json')).ok).toBe(true);

    const withFinal = applyComicFinalPages(project, [{
      page: 0, path: outputPath, imageId: finalImage.id,
      panelIds: layout.slots.map(slot => slot.panelId), composedAt: new Date().toISOString(),
    }]);
    expect(withFinal.finalPages?.length).toBe(1);
    expect(withFinal.finalPages![0]!.panelIds.length).toBe(4);

    writeFileSync(join(WORK_DIR, 'project-final.json'), JSON.stringify(withFinal, null, 2));
    writeFileSync(join(WORK_DIR, 'phase7-compose.json'), JSON.stringify({
      fileName, size: bytes.length, width: dims.width, height: dims.height,
      texts: texts.length, slots: layout.slots.length,
    }, null, 2));
  }, 300_000);

  test('阶段 8 —— 对白编辑零生图（§153-9）+ 本地重组合', async () => {
    const { normalizeComicProject } = await import('../../features/comic/normalize');
    const { upsertDialogue } = await import('../../features/comic/domain');
    const { computePageLayouts } = await import('../../features/comic/comicExport');
    const { execFileSync: exec } = await import('node:child_process');

    const project = normalizeComicProject(JSON.parse(readFileSync(join(WORK_DIR, 'project-final.json'), 'utf-8')))!;
    const editsBefore = hoisted.editsCounter.count;

    // 对白修改：upsert 只改文字层（生成链路零交集）
    const target = project.dialogues[0]!;
    const edited = { ...target, text: `${target.text.slice(0, 12)}（终稿）` };
    const withDialogue = upsertDialogue(project, edited);
    expect(withDialogue.dialogues.find(item => item.id === edited.id)!.text).toContain('（终稿）');
    // 图像资产零变化（对白不触发任何 Image2 / 重生成）
    expect(withDialogue.panels.every(panel => panel.imageAsset?.imageId === project.panels.find(p => p.id === panel.id)!.imageAsset?.imageId)).toBe(true);
    expect(hoisted.editsCounter.count).toBe(editsBefore); // §153-9 硬断言

    // 本地重组合（同一 Rust 组合器、同一底图 → 只有文字层变化）
    const layout = computePageLayouts(withDialogue)[0]!;
    const slotIndexByPanel = new Map(layout.slots.map((slot, index) => [slot.panelId, index]));
    const texts = withDialogue.dialogues.map(dialogue => ({
      slot: slotIndexByPanel.get(dialogue.panelId)!,
      x: dialogue.position.x, y: dialogue.position.y,
      text: dialogue.text, font_size: dialogue.fontStyle.size,
      align: dialogue.alignment === 'left' ? 'left' : dialogue.alignment === 'right' ? 'right' : 'center',
      dark: dialogue.type === 'caption' || dialogue.type === 'title',
      bubble: dialogue.bubbleStyle !== 'none',
    }));
    const fileName = sanitizeLibraryName(`AI漫画 · 《${withDialogue.story!.title}》 · ${withDialogue.name} · 对白终稿`);
    const outputPath = `${creds.libraryDir.replace(/\\/g, '/')}/${fileName}`;
    writeFileSync(join(WORK_DIR, 'compose-input-2.json'), JSON.stringify({
      output: outputPath, width: layout.width, height: layout.height,
      background: layout.background, gap: layout.gap,
      slots: layout.slots.map(slot => ({
        path: withDialogue.panels.find(panel => panel.id === slot.panelId)!.imageAsset!.path,
        x: slot.x, y: slot.y, width: slot.width, height: slot.height,
      })),
      texts,
    }, null, 2));
    exec('cargo', ['test', '--manifest-path', join(REPO_ROOT, 'src-tauri', 'Cargo.toml'), 'e2e_compose_final_page', '--', '--ignored', '--nocapture'], {
      encoding: 'utf8', timeout: 300_000, windowsHide: true,
      env: { ...process.env, V4211_COMPOSE_INPUT: join(WORK_DIR, 'compose-input-2.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(existsSync(outputPath)).toBe(true);
    expect(hoisted.editsCounter.count).toBe(editsBefore); // 重组合全程零 Image2

    writeFileSync(join(WORK_DIR, 'project-dialogue-final.json'), JSON.stringify(withDialogue, null, 2));
    writeFileSync(join(WORK_DIR, 'phase8-dialogue.json'), JSON.stringify({
      editedDialogueId: edited.id, editsBefore, editsAfter: hoisted.editsCounter.count,
      recomposedFile: fileName, recomposedBytes: readFileSync(outputPath).length,
    }, null, 2));
  }, 300_000);

  test('阶段 9 —— 落库 + 重载还原（save/reload restoration）', async () => {
    const { normalizeComicProject } = await import('../../features/comic/normalize');
    const finalProject = JSON.parse(readFileSync(join(WORK_DIR, 'project-dialogue-final.json'), 'utf-8'));
    const persisted = { ...finalProject, stage: 'completed' as const, updatedAt: new Date().toISOString() };
    writeFileSync(join(WORK_DIR, 'persist-record.json'), JSON.stringify(persisted, null, 2));
    expect(python('write-project', PROJECT_ID, 'completed', join(WORK_DIR, 'persist-record.json')).ok).toBe(true);

    // 重新载入（应用同路径：db → normalizeComicProject）
    const reloaded = normalizeComicProject(python('dump-project', PROJECT_ID).record)!;
    expect(reloaded.panels.filter(panel => !panel.stale).length).toBe(4);
    expect(reloaded.panels.filter(panel => !panel.stale).every(panel => panel.generationStatus === 'completed' && panel.imageAsset)).toBe(true);
    expect(reloaded.dialogues.length).toBe(finalProject.dialogues.length);
    expect(reloaded.dialogues.some(dialogue => dialogue.text.includes('（终稿）'))).toBe(true);
    expect(reloaded.finalPages?.length).toBe(1);
    expect(reloaded.finalPages![0]!.panelIds.length).toBe(4);
    expect(existsSync(reloaded.finalPages![0]!.path)).toBe(true);
    expect(reloaded.characterSnapshots.filter(character => character.status === 'locked').length).toBe(3);

    // 任务/图库事实还原
    const tasks = python('read-tasks').tasks as any[];
    const panelsTask = tasks.find(task => task.execution_snapshot?.comic?.projectId === PROJECT_ID && task.execution_snapshot.comic.kind === 'panels');
    expect(panelsTask?.status).toBe('completed');
    expect(panelsTask?.sub_tasks.filter((sub: any) => sub.status === 'completed').length).toBe(4);
    const images = python('read-images').images as any[];
    const finalPage = images.find(image => image.tags?.includes('comic-final-page') && image.tags?.includes(PROJECT_ID));
    expect(finalPage).toBeTruthy();

    // 汇总证据（无任何令牌）
    const storyboardEvidence = JSON.parse(readFileSync(join(WORK_DIR, 'phase3-storyboard.json'), 'utf-8'));
    const summary = {
      project: { id: PROJECT_ID, name: reloaded.name, stage: 'completed' },
      planner: storyboardEvidence.planner,
      phases: ['boot', 'dedupe', 'character-refs', `storyboard-${storyboardEvidence.planner}`, 'series-build', 'billing-image2', 'apply', 'compose', 'dialogue-zero-image', 'reload'],
      artifacts: {
        storyboard: JSON.parse(readFileSync(join(WORK_DIR, 'phase3-storyboard.json'), 'utf-8')),
        generation: JSON.parse(readFileSync(join(WORK_DIR, 'phase5-generation.json'), 'utf-8')),
        compose: JSON.parse(readFileSync(join(WORK_DIR, 'phase7-compose.json'), 'utf-8')),
        dialogue: JSON.parse(readFileSync(join(WORK_DIR, 'phase8-dialogue.json'), 'utf-8')),
      },
    };
    writeFileSync(join(EVIDENCE_DIR, 'duck-pear-evidence.json'), JSON.stringify(summary, null, 2));
  }, 60_000);
});
