import { describe, expect, it } from 'vitest';
import { fixtureAnalysis, fixtureProject } from './fixtures';
import { buildRecreationPlan } from '../../recreationPlan';
import {
  canRestoreAnalyzedTemplate,
  createVisualProjectFromAnalysis,
  normalizeVisualProject,
  reapplyTemplateFromAnalysis,
  resolveRestoredAnalysis,
} from '../project';
import { restoreAnalysisFromSnapshot } from '../template';
import type { VisualProject } from '../types';

/**
 * Project Persistence / Canonical Restore 回归（GUI 验收 Case B / §32）：
 * 「视觉理解完成 + 保存」的项目重新打开后必须直接恢复已理解状态，
 * 绝不重新调用视觉分析 API、绝不显示「开始理解这张图片」。
 */

function savedProject(): VisualProject {
  return fixtureProject({ name: '动漫AI照片' });
}

describe('保存侧：项目文档确实冻结了模板快照', () => {
  it('savedProjectRestoresTemplateSnapshot：源图身份 / 分析时间 / 姿态 / 媒介结构齐全', () => {
    const project = savedProject();
    const snapshot = project.templateSnapshot!;
    expect(snapshot.sourcePath).toBe(project.sourceAsset.path);
    expect(snapshot.sourceAssetId).toBe(project.sourceAsset.assetId);
    expect(snapshot.analyzedAt).toBeTruthy();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.action.originalValue).toContain('腾空上篮');
    expect(snapshot.subjectPoses).toHaveLength(1);
    expect(snapshot.subjectPoses![0].poseDescription).toContain('腾空上篮');
    expect(snapshot.mediaStructure).toBeDefined();
    expect(project.workspace.analysis).not.toBeNull();
  });

  it('restoredMediaStructureMatchesSavedSnapshot / restoredRegionPoseMatchesSavedSnapshot：JSON 落库往返不丢', () => {
    const project = savedProject();
    const roundTripped = normalizeVisualProject(JSON.parse(JSON.stringify(project)))!;
    expect(roundTripped.templateSnapshot!.mediaStructure).toEqual(project.templateSnapshot!.mediaStructure);
    expect(roundTripped.templateSnapshot!.subjectPoses).toEqual(project.templateSnapshot!.subjectPoses);
    expect(roundTripped.revision).toBe(project.revision);
  });
});

describe('Canonical Restore Rule（§5/§6：canRestoreAnalyzedTemplate）', () => {
  it('savedProjectDoesNotRequireReanalysis：workspace.analysis 丢失也可从快照恢复', () => {
    const polluted: VisualProject = {
      ...savedProject(),
      workspace: { ...savedProject().workspace, analysis: null },
    };
    expect(canRestoreAnalyzedTemplate(polluted)).toBe(true);
    const restored = resolveRestoredAnalysis(polluted);
    expect(restored).not.toBeNull();
    expect(restored!.subjects).toHaveLength(1);
    expect(restored!.subjects[0].label).toBe('成年男性篮球运动员');
    expect(restored!.subjects[0].pose).toContain('腾空上篮');
    expect(restored!.scene.environment).toBe('室内篮球馆');
    expect(restored!.camera.shot_type).toBe('中远景');
  });

  it('真实 analysis 在场时优先使用（不经快照重建）', () => {
    const project = savedProject();
    expect(resolveRestoredAnalysis(project)).toBe(project.workspace.analysis);
  });

  it('projectRestoreDoesNotInvalidateTemplate：恢复是纯函数，不触碰项目字段', () => {
    const project = savedProject();
    const before = JSON.stringify(project.templateSnapshot);
    resolveRestoredAnalysis(project);
    resolveRestoredAnalysis({ ...project, workspace: { ...project.workspace, analysis: null } });
    expect(JSON.stringify(project.templateSnapshot)).toBe(before);
  });

  it('userReplacingSourceInvalidatesTemplate：换图后旧快照 = stale，不得恢复', () => {
    const project = savedProject();
    const replaced: VisualProject = {
      ...project,
      sourceAsset: { path: 'D:/imgs/another.png', assetId: 'asset-2', source: 'gallery' },
      workspace: { ...project.workspace, analysis: null },
    };
    expect(canRestoreAnalyzedTemplate(replaced)).toBe(false);
    expect(resolveRestoredAnalysis(replaced)).toBeNull();
  });

  it('assetId 不一致同样视为 stale（同路径不同素材）', () => {
    const project = savedProject();
    const mismatched: VisualProject = {
      ...project,
      sourceAsset: { ...project.sourceAsset, assetId: 'asset-other' },
      workspace: { ...project.workspace, analysis: null },
    };
    expect(canRestoreAnalyzedTemplate(mismatched)).toBe(false);
  });

  it('无模板快照的项目不得伪造恢复', () => {
    const project = savedProject();
    expect(canRestoreAnalyzedTemplate({ ...project, templateSnapshot: undefined })).toBe(false);
    expect(resolveRestoredAnalysis({ ...project, templateSnapshot: undefined, workspace: { ...project.workspace, analysis: null } })).toBeNull();
  });
});

describe('重新分析（reapplyTemplateFromAnalysis）刷新 workspace（Case B 根因修复）', () => {
  it('旧缺陷回归：reapply 后 workspace.analysis 必须更新为新分析（缺省兜底路径）', () => {
    const project = savedProject();
    const newAnalysis = fixtureAnalysis({ style: { category: '人像摄影' } });
    const newPlan = buildRecreationPlan(newAnalysis);
    const workspace = project.workspace;
    const reapplied = reapplyTemplateFromAnalysis(project, {
      analysis: newAnalysis,
      plan: newPlan,
      recreation: workspace.recreation!,
      sourceAsset: project.sourceAsset,
      keepModification: true,
    });
    expect(reapplied.workspace.analysis).toBe(newAnalysis);
    expect(reapplied.templateSnapshot!.style.originalValue).toBe('人像摄影，照片，写实');
  });

  it('显式 workspace 输入完整落位（analysis / recreation 同步）', () => {
    const project = savedProject();
    const newAnalysis = fixtureAnalysis();
    const newPlan = buildRecreationPlan(newAnalysis);
    const workspace = project.workspace;
    const reapplied = reapplyTemplateFromAnalysis(project, {
      analysis: newAnalysis,
      plan: newPlan,
      recreation: workspace.recreation!,
      sourceAsset: project.sourceAsset,
      keepModification: true,
      workspace: { ...workspace, analysis: newAnalysis },
    });
    expect(reapplied.workspace.analysis).toBe(newAnalysis);
    expect(reapplied.workspace.recreation).toBe(workspace.recreation);
    // 模板重建仍是语义事件：revision +1
    expect(reapplied.revision).toBe(project.revision + 1);
  });
});

describe('快照重建降级（restoreAnalysisFromSnapshot 不伪造数据）', () => {
  it('旧快照缺 structured 时按 originalValue 填充主字段', () => {
    const project = savedProject();
    const snapshot = {
      ...project.templateSnapshot!,
      subject: { originalValue: '一位女性' },
      background: { originalValue: '海边' },
      camera: { originalValue: '平视全身' },
      subjectPoses: undefined,
    };
    const restored = restoreAnalysisFromSnapshot(snapshot);
    expect(restored.subjects).toHaveLength(0); // 无姿态快照且无 structured 主体 → 空主体集
    expect(restored.scene.environment).toBe('海边');
    expect(restored.camera.shot_type).toBe('平视全身');
    expect(restored.objects).toEqual([]);
    expect(restored.fine_details).toEqual([]);
  });
});

describe('createVisualProjectFromAnalysis（分析建项路径）', () => {
  it('分析模型快照随模板冻结（§7 Source Identity）', () => {
    const analysis = fixtureAnalysis();
    const recreation = fixtureProject({ analysis }).workspace.recreation!;
    const project = createVisualProjectFromAnalysis({
      name: '带模型溯源',
      analysis,
      plan: recreation.plan,
      recreation,
      sourceAsset: { path: 'D:/imgs/x.png', source: 'local_import' },
      workspace: {
        profileId: 'p', modelId: 'm', mode: 'reverse_prompt', analysis,
        reverseResult: null, originalPromptDraft: '', promptDraft: '', negativeDraft: '',
        recreation, genParams: { size: '1024x1024', quality: 'auto', count: 1 },
        generationMode: 'i2i', hfTarget: 0.9, hfMaxIterations: 2, report: null, iterations: [],
        visionTaskId: '', sessionId: '',
      },
      analysisModel: { modelId: 'glm-5v-turbo', displayName: 'GLM-5V-Turbo' },
    });
    expect(project.templateSnapshot!.analysisModel?.modelId).toBe('glm-5v-turbo');
    expect(project.status).toBe('ready');
  });
});
