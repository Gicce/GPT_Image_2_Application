import { beforeEach, describe, expect, it } from 'vitest';
import { useVisualProjectStore } from '../useVisualProjectStore';
import { useVisionWorkspaceStore } from '../useVisionWorkspaceStore';
import { fixtureProject } from '../../features/vision/project/__tests__/fixtures';
import type { VisualProject } from '../../features/vision/project/types';

/**
 * 打开项目 = 本地恢复的真实接线测试（GUI 验收 Case B / §32）：
 *  - workspace.analysis 被旧缺陷污染为 null 时，hydrate 从 templateSnapshot 重建；
 *  - 恢复后 stage = ready（UI 不再显示「开始理解这张图片」）；
 *  - hydration 不是语义事件：project.revision 绝不 +1。
 */

describe('useVisualProjectStore.hydrateWorkspaceFromActive（Canonical Restore 接线）', () => {
  beforeEach(() => {
    useVisualProjectStore.setState({ active: null, lastError: '' });
    useVisionWorkspaceStore.getState().reset();
  });

  function pollutedProject(): VisualProject {
    const project = fixtureProject({ name: '动漫AI照片' });
    return { ...project, workspace: { ...project.workspace, analysis: null } };
  }

  it('savedProjectDoesNotRequireReanalysis：analysis 缺失也能恢复为已理解态', () => {
    useVisualProjectStore.setState({ active: pollutedProject() });
    useVisualProjectStore.getState().hydrateWorkspaceFromActive();
    const ws = useVisionWorkspaceStore.getState();
    expect(ws.analysis).not.toBeNull();
    expect(ws.analysis!.subjects[0].label).toBe('成年男性篮球运动员');
    expect(ws.stage).toBe('ready');
    expect(ws.sourcePath).toBe('D:/imgs/template.png');
  });

  it('projectRestoreDoesNotIncrementSemanticRevision：hydration 不动 revision', () => {
    const project = pollutedProject();
    const revisionBefore = project.revision;
    useVisualProjectStore.setState({ active: project });
    useVisualProjectStore.getState().hydrateWorkspaceFromActive();
    expect(useVisualProjectStore.getState().active!.revision).toBe(revisionBefore);
  });

  it('projectRestoreDoesNotInvalidateTemplate：恢复后项目模板快照原样保留', () => {
    const project = pollutedProject();
    const snapshotBefore = JSON.stringify(project.templateSnapshot);
    useVisualProjectStore.setState({ active: project });
    useVisualProjectStore.getState().hydrateWorkspaceFromActive();
    expect(JSON.stringify(useVisualProjectStore.getState().active!.templateSnapshot)).toBe(snapshotBefore);
  });

  it('恢复后再镜像（syncFromWorkspace）：重建的 analysis 回写进项目文档（自愈）', () => {
    useVisualProjectStore.setState({ active: pollutedProject() });
    useVisualProjectStore.getState().hydrateWorkspaceFromActive();
    useVisualProjectStore.getState().syncFromWorkspace();
    const healed = useVisualProjectStore.getState()!.active!;
    expect(healed.workspace.analysis).not.toBeNull();
    expect(healed.workspace.analysis!.subjects[0].pose).toContain('腾空上篮');
    expect(healed.revision).toBe(pollutedProject().revision);
  });

  it('源图更换后（快照 stale）：不得恢复，回 idle 等待重新分析', () => {
    const project = pollutedProject();
    const replaced = { ...project, sourceAsset: { ...project.sourceAsset, path: 'D:/imgs/other.png' } };
    useVisualProjectStore.setState({ active: replaced });
    useVisualProjectStore.getState().hydrateWorkspaceFromActive();
    const ws = useVisionWorkspaceStore.getState();
    expect(ws.analysis).toBeNull();
    expect(ws.stage).toBe('idle');
  });
});
