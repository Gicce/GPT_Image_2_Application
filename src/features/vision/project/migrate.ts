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
