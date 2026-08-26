/**
 * Legacy Workspace → VisualProject 迁移（§36）。
 *
 * 用户带着旧 vision_workspace_v1 快照进入新工作台时自动生成
 * 「未命名视觉项目」：只复用已有结构化内容（analysis / recreation /
 * modificationDraft），绝不重新调用视觉分析 API；legacy 缺 templateSnapshot
 * 时按 recreation.plan.originalValue 重建（不伪造新分析）。
 */

import type { VisionAnalysis } from '../../../types';
import type { RecreationState } from '../recreationPlan';
import type { ModificationDraft } from '../modificationIntent';
import { buildTemplateSnapshot } from './template';
import { createVisualProjectFromAnalysis, normalizeVisualProject, toModificationContract } from './project';
import type { VisualProject, VisualProjectWorkspace } from './types';

/** legacy 快照的最小结构视图（避免与 store 运行时耦合；字段同 VisionWorkspaceSnapshot）。 */
export interface LegacyWorkspaceSnapshot {
  sourcePath: string;
  sourceAssetId?: string;
  profileId: string;
  modelId: string;
  analysis: VisionAnalysis | null;
  originalPromptDraft: string;
  promptDraft: string;
  negativeDraft: string;
  modificationDraft: ModificationDraft;
  recreation: RecreationState | null;
  visionTaskId: string;
  sessionId: string;
}

/** legacy 快照是否值得迁移（有源图 + 有分析结果才算有效遗留工作区）。 */
export function isLegacyWorkspaceMigratable(legacy: LegacyWorkspaceSnapshot | null | undefined): boolean {
  return !!legacy?.sourcePath?.trim() && !!legacy.analysis && !!legacy.recreation?.plan;
}

/**
 * 迁移幂等标记（§36 铁律：迁移执行一次与多次结果相同）。
 * workspace 快照在迁移后仍保有 analysis（会被项目持续镜像），没有标记的话
 * 每次重启 / 重进页面都会再复制一个「未命名视觉项目」——标记按内容指纹
 * 判定「这份 legacy 已经迁移过」，跳过并返回当时的 projectId。
 */
const LEGACY_MIGRATION_MARKER_KEY = 'vision_legacy_project_migrated_v1';

export interface LegacyMigrationMarker {
  fingerprint: string;
  projectId: string;
  migratedAt: string;
}

/** 指纹输入：只取「这份分析属于哪次识别会话」的稳定身份字段（promptDraft 会随编辑漂移，禁止入指纹）。 */
export interface WorkspaceIdentityInput {
  sourcePath?: string;
  sourceAssetId?: string;
  sessionId?: string;
  visionTaskId?: string;
}

/**
 * 工作区内容指纹（同一次识别会话 = 同一指纹）。所有 createFromAnalysis 入口
 * （正式分析建项目 / legacy 迁移）都必须以此标记「当前 workspace 已归属某项目」，
 * 否则每次重启都会把同一份 analysis 再复制一个「未命名视觉项目」。
 */
export function workspaceIdentityFingerprint(identity: WorkspaceIdentityInput): string {
  return JSON.stringify([
    identity.sourcePath ?? '',
    identity.sourceAssetId ?? '',
    identity.sessionId ?? '',
    identity.visionTaskId ?? '',
  ]);
}

export function legacyWorkspaceFingerprint(legacy: LegacyWorkspaceSnapshot): string {
  return workspaceIdentityFingerprint({
    sourcePath: legacy.sourcePath,
    sourceAssetId: legacy.sourceAssetId,
    sessionId: legacy.sessionId,
    visionTaskId: legacy.visionTaskId,
  });
}

export function readLegacyMigrationMarker(): LegacyMigrationMarker | null {
  try {
    const raw = localStorage.getItem(LEGACY_MIGRATION_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LegacyMigrationMarker>;
    if (typeof parsed.fingerprint === 'string' && typeof parsed.projectId === 'string' && parsed.projectId) {
      return {
        fingerprint: parsed.fingerprint,
        projectId: parsed.projectId,
        migratedAt: typeof parsed.migratedAt === 'string' ? parsed.migratedAt : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function isLegacyWorkspaceAlreadyMigrated(legacy: LegacyWorkspaceSnapshot): boolean {
  const marker = readLegacyMigrationMarker();
  return marker !== null && marker.fingerprint === legacyWorkspaceFingerprint(legacy);
}

/** 建项目成功后写入标记（写失败不阻断：下次启动会因指纹不同重走迁移判定）。 */
export function markWorkspaceClaimedByProject(identity: WorkspaceIdentityInput, projectId: string): void {
  try {
    const marker: LegacyMigrationMarker = {
      fingerprint: workspaceIdentityFingerprint(identity),
      projectId,
      migratedAt: new Date().toISOString(),
    };
    localStorage.setItem(LEGACY_MIGRATION_MARKER_KEY, JSON.stringify(marker));
  } catch { /* localStorage 不可用不阻断 */ }
}

/**
 * legacy → 项目（缺 plan/analysis 的残缺快照返回 null，调用方走全新建项目流程）。
 * 项目名固定「未命名视觉项目」；revision 从 0 开始（迁移本身不算语义修改）。
 */
export function migrateLegacyWorkspace(
  legacy: LegacyWorkspaceSnapshot,
): VisualProject | null {
  if (!isLegacyWorkspaceMigratable(legacy)) return null;
  const analysis = legacy.analysis!;
  const recreation = legacy.recreation!;
  const workspace: VisualProjectWorkspace = {
    profileId: legacy.profileId || '',
    modelId: legacy.modelId || '',
    mode: 'reverse_prompt',
    analysis,
    reverseResult: null,
    originalPromptDraft: legacy.originalPromptDraft || '',
    promptDraft: legacy.promptDraft || '',
    negativeDraft: legacy.negativeDraft || '',
    recreation,
    genParams: { size: '1024x1024', quality: 'auto', count: 1 },
    generationMode: 'i2i',
    hfTarget: 0.9,
    hfMaxIterations: 2,
    report: null,
    iterations: [],
    visionTaskId: legacy.visionTaskId || '',
    sessionId: legacy.sessionId || '',
  };
  const project = createVisualProjectFromAnalysis({
    name: '未命名视觉项目',
    analysis,
    plan: recreation.plan,
    recreation,
    sourceAsset: {
      path: legacy.sourcePath,
      ...(legacy.sourceAssetId ? { assetId: legacy.sourceAssetId } : {}),
      source: legacy.sourceAssetId ? 'gallery' : 'local_import',
    },
    workspace,
  });
  // 迁移保留用户已有修改意图（V1 person → V2 合同，默认 strict）
  return normalizeVisualProject({
    ...project,
    modification: toModificationContract(legacy.modificationDraft),
    status: 'modified',
  });
}
