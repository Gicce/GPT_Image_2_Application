/**
 * Canonical Anime Character Asset Service（V5 Strict Visual Reference）--
 * 动漫角色参考图的创建、任务标记与完成回绑。
 *
 * 铁律：
 *  - 角色参考图是内部中间产物（UI 口径 = 「动漫角色参考图」），
 *    由人物参考图 + 角色卡确定性派生生成一次，按指纹缓存复用；
 *  - 创建必须先过统一计费授权（报价确认 + 预留，绝不自动扣费）；
 *  - 完成回绑走任务事件桥（registerTaskRefreshHook）：
 *    provenance.animeCharacterAssetRequest 是唯一绑定线索；
 *  - 绑定时复核指纹（生成期间用户可能换了人物参考 = 放弃本次绑定）。
 */

import { api } from '../../../services/api';
import {
  authorizeImageTask,
  createRequestId,
  registerTaskAuthorization,
  settleImageTask,
} from '../../../services/billingService';
import { useAuthStore } from '../../../store/useAuthStore';
import { registerTaskRefreshHook } from '../../../store/useTaskStore';
import type {
  CreateTaskParams,
  GenerationImageReference,
  GenerationProvenanceSnapshot,
  Task,
} from '../../../types';
import {
  CANONICAL_ANIME_CHARACTER_ID,
  characterAssetFingerprint,
  describeFaceFacts,
  describeHairFacts,
  isCharacterAssetReusable,
  resolveAnimeCharacter,
} from './animeCharacter';
import type { AnimeCharacterSnapshot, CanonicalAnimeCharacterAsset, VisualProject } from './types';

/**
 * 角色参考页生成 Prompt（确定性编译；V5 §19）：
 * 清晰动漫角色参考页 = 主要头像 + 上半身/全身参考，发型/刘海/脸型/眼型/瞳色/服装
 * 清楚可见，无复杂背景。事实来源 = 角色卡 resolved facts（有则事实驱动，无则来源指示）。
 */
export function buildCharacterReferencePrompt(character: AnimeCharacterSnapshot): string {
  const facts = character.hair.facts;
  const hairLine = facts
    ? `发型设计（唯一事实）：${describeHairFacts(facts)}。`
    : `发型设计：${character.hair.description}。`;
  const faceFacts = character.face.facts;
  const faceLine = faceFacts
    ? `脸型与五官：${describeFaceFacts(faceFacts)}。`
    : `脸型与五官：${character.face.description}。`;
  return [
    '【动漫角色参考图（强制执行）】依据人物参考图与以下角色设计事实，生成一张清晰的动漫角色参考页（character reference sheet）：',
    `- 媒介：动漫插画（${character.rendering.styleDescription || '干净角色设定稿风格'}）。`,
    `- 画幅结构：左侧正面头像特写 + 右侧上半身（或全身）站姿参考；浅色纯色背景（禁止复杂背景、禁止场景、禁止文字标注）。`,
    hairLine,
    faceLine,
    `- 眼睛设计：${character.eyes.description}。`,
    `- 服装基底：${character.clothing.canonicalDescription}。`,
    '- 配饰：' + character.accessories.description + '。',
    '- 人物身份：与人物参考图为同一人物（这是同一身份的动漫媒介呈现，不是另一个人）。',
    '- 禁止：重新设计发型 / 刘海 / 发色 / 脸型 / 眼型 / 瞳色 / 服装；禁止写实化；禁止多余角色；禁止画面文字。',
  ].join('\n');
}

export interface CharacterAssetRequestOutcome {
  ok: boolean;
  taskId?: string;
  /** 指纹命中已有资产，本次未报价、未创建任务。 */
  reused?: boolean;
  /** 用户在报价确认中取消。 */
  cancelled?: boolean;
  errorMessage?: string;
}

/**
 * 创建角色参考图生成任务（先统一计费授权，绝不静默扣费）：
 * i2i 单张（source = 人物参考图）+ provenance.animeCharacterAssetRequest 标记。
 */
export async function requestCharacterAssetGeneration(
  project: VisualProject,
  options?: { force?: boolean },
): Promise<CharacterAssetRequestOutcome> {
  const character = resolveAnimeCharacter(project);
  const person = project.modification.person;
  const personPath = person?.path?.trim();
  if (!character || !personPath) {
    return { ok: false, errorMessage: '尚未绑定人物参考图或无法派生动漫角色卡。' };
  }
  if (!options?.force && isCharacterAssetReusable(project)) {
    return { ok: true, reused: true };
  }
  const settings = await api.getSettings().catch(() => null);
  const outputDir = settings?.default_output_dir?.trim()
    || (personPath.includes('\\') || personPath.includes('/')
      ? personPath.replace(/[\\/][^\\/]+$/, '')
      : '');
  let billingRequestId: string | undefined;
  if (useAuthStore.getState().isLoggedIn) {
    try {
      billingRequestId = createRequestId('anime-character');
      await authorizeImageTask(billingRequestId, 1);
    } catch (error: any) {
      if (error?.quoteCancelled) return { ok: false, cancelled: true };
      return { ok: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }
  const provenance: GenerationProvenanceSnapshot = {
    schemaVersion: 1,
    feature: 'vision_recreation',
    userInstruction: `生成动漫角色参考图（项目「${project.name}」的角色一致性准备）`,
    animeCharacterAssetRequest: {
      projectId: project.id,
      fingerprint: characterAssetFingerprint(project),
    },
  };
  const params: CreateTaskParams = {
    prompt: buildCharacterReferencePrompt(character),
    negative_prompt: '写实照片风格，复杂背景，画面文字，多余角色，重新设计的发型与服装',
    final_prompt: buildCharacterReferencePrompt(character),
    prompt_optimized: true,
    task_source: 'vision_recreation',
    size: '1024x1024',
    quality: settings?.default_quality || 'auto',
    output_format: settings?.default_format || 'png',
    count: 1,
    output_dir: outputDir,
    task_type: 'edit',
    source_images: [personPath],
    task_plan_summary: `动漫角色参考图 · ${project.name}`,
    provenance,
  };
  try {
    const task = await api.createTask(params);
    if (billingRequestId) registerTaskAuthorization(task.id, billingRequestId);
    return { ok: true, taskId: task.id };
  } catch (error) {
    if (billingRequestId) void settleImageTask(billingRequestId, false, 0, 'anime character asset task create failed');
    return { ok: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

/** 从完成任务回绑角色参考图资产（指纹复核：输入已变 = 放弃绑定，等用户重新生成）。 */
export async function bindCharacterAssetFromTask(
  task: Task,
  imageById: Map<string, { id: string; local_path: string }>,
): Promise<boolean> {
  const request = task.provenance?.animeCharacterAssetRequest;
  if (!request || task.status !== 'completed') return false;
  const sub = task.sub_tasks.find(item => item.status === 'completed' && item.image_id);
  if (!sub?.image_id) return false;
  const record = imageById.get(sub.image_id);
  if (!record?.local_path) return false;
  const { useVisualProjectStore } = await import('../../../store/useVisualProjectStore');
  const store = useVisualProjectStore.getState();
  // 指纹复核：生成期间人物参考/服装来源/角色设计已变 ⇒ 本次产物不再绑定
  const current = store.active?.id === request.projectId ? store.active : null;
  if (current && characterAssetFingerprint(current) !== request.fingerprint) return false;
  if (!current) {
    // 非 active 项目：读取持久化文档复核指纹（失败 = 放弃绑定）
    try {
      const raw = await api.loadVisualProject(request.projectId);
      if (!raw) return false;
      const persisted = JSON.parse(raw) as VisualProject;
      const { normalizeVisualProject } = await import('./project');
      const parsed = normalizeVisualProject(persisted);
      if (!parsed || characterAssetFingerprint(parsed) !== request.fingerprint) return false;
    } catch {
      return false;
    }
  }
  const asset: CanonicalAnimeCharacterAsset = {
    id: `anime-character-asset-${request.projectId}`,
    projectRevision: current?.revision ?? 0,
    ...(current?.modification.person?.assetId ? { sourcePersonAssetId: current.modification.person.assetId } : {}),
    ...(current?.modification.person?.path ? { sourcePersonPath: current.modification.person.path } : {}),
    ...(current?.sourceAsset.assetId ? { styleTemplateAssetId: current.sourceAsset.assetId } : {}),
    localPath: record.local_path,
    libraryAssetId: record.id,
    characterSnapshotId: CANONICAL_ANIME_CHARACTER_ID,
    fingerprint: request.fingerprint,
    taskId: task.id,
    createdAt: new Date().toISOString(),
  };
  return useVisualProjectStore.getState().bindCharacterAsset(request.projectId, asset);
}

let watcherBound = false;

/** 全局角色参考图回绑 watcher（App 启动后调用一次；内部异常静默，绝不阻塞任务链路）。 */
export function ensureCharacterAssetWatcher(): void {
  if (watcherBound) return;
  watcherBound = true;
  registerTaskRefreshHook(taskId => {
    void (async () => {
      try {
        const { useTaskStore } = await import('../../../store/useTaskStore');
        const task = useTaskStore.getState().tasks.find(item => item.id === taskId);
        if (!task?.provenance?.animeCharacterAssetRequest) return;
        if (task.status !== 'completed') return;
        const images = await api.getImages();
        const imageById = new Map(images.map(img => [img.id, img]));
        await bindCharacterAssetFromTask(task, imageById);
      } catch {
        // watcher 内部异常静默：回绑失败时用户可手动重新生成
      }
    })();
  });
}

/** Strict 模式下生成请求应附带的第三参考图（可复用资产存在时）。 */
export function animeCharacterReferenceImage(project: VisualProject): { path: string; label: string } | null {
  if (project.animeConsistency?.mode !== 'strict_visual_reference') return null;
  if (!isCharacterAssetReusable(project)) return null;
  const asset = project.animeConsistency!.characterAsset!;
  return { path: asset.localPath, label: '动漫角色参考' };
}

/**
 * Strict 模式参考图顺序唯一入口：模板 -> 人物 -> 动漫角色参考 -> 其它引用。
 * 无人物参考时回落到模板之后；同路径/同角色已存在时保持原清单，避免重复提交。
 */
export function withAnimeCharacterReference(
  references: ReadonlyArray<GenerationImageReference>,
  reference: GenerationImageReference | null,
): GenerationImageReference[] {
  const current = [...references];
  if (!reference?.path?.trim()) return current;
  if (current.some(item => item.role === 'anime_character_reference' || item.path === reference.path)) return current;
  const personIndex = current.findIndex(item => item.role === 'person_reference');
  const templateIndex = current.findIndex(item => item.role === 'template');
  const insertAfter = personIndex >= 0 ? personIndex : templateIndex;
  return [
    ...current.slice(0, insertAfter + 1),
    reference,
    ...current.slice(insertAfter + 1),
  ];
}
