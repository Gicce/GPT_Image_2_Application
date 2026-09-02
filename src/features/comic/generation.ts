/**
 * AI 漫画生成结果回写（Phase 8/9，纯函数层）。
 *
 * 职责：终态 Task（execution_snapshot.comic 标记的漫画任务）→ 项目状态补丁。
 *  - 每槽按 batch_items[i].variables.panelId 定位 Panel（anchor / panel_regen 用 marker.panelId）；
 *  - 子任务 completed 且 image_id 能在图库记录中解析出路径 → 写 panel.imageAsset；
 *  - 失败 / 取消 → generationStatus='failed'；运行中 → running / queued；
 *  - stale 副本永不接收结果（上一代图只读回看）；对白层永不触碰（修改对白零生图）。
 *
 * 幂等 + 结构共享：无变化返回原 project 引用（React memo 友好），
 * 已写入过的同 imageId 不重复计数、不重复替换。
 * 锚点「审定 → 锁定」由 UI 调 buildAnchorConfirmation + domain.lockAnchor 完成。
 */

import type { ImageRecord, Task } from '../../types';
import type { ComicConsistencyProfile, ComicExecutionMarker, ComicPanel, ComicProject } from './types';

/** 读取任务的漫画溯源标记（非漫画任务返回 null）。 */
export function comicTaskMarker(task: Task): ComicExecutionMarker | null {
  return task.execution_snapshot?.comic ?? null;
}

function panelIdOfSlot(task: Task, marker: ComicExecutionMarker, subIndex: number): string | undefined {
  if (marker.kind === 'panels') {
    return task.batch_items?.[subIndex]?.variables?.panelId;
  }
  return marker.panelId;
}

function statusOfSub(sub: Task['sub_tasks'][number]): ComicPanel['generationStatus'] {
  switch (sub.status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'failed';
    case 'running': return 'running';
    default: return 'queued';
  }
}

export interface ComicTaskApplyResult {
  project: ComicProject;
  changed: boolean;
  /** 本次成功落图格数（0 = 无新增落图）。 */
  imagesApplied: number;
}

/** 终态 / 进行中任务结果回写项目（纯函数；图库记录由调用方传入，缺失路径的槽留待下次刷新）。 */
export function applyComicTaskResults(
  project: ComicProject,
  task: Task,
  images: ImageRecord[],
): ComicTaskApplyResult {
  const marker = comicTaskMarker(task);
  if (!marker || marker.projectId !== project.id) {
    return { project, changed: false, imagesApplied: 0 };
  }
  if (marker.kind === 'character_ref') {
    return applyCharacterReferenceResult(project, task, marker, images);
  }
  if (marker.kind === 'bake_text') {
    return applyBakeTextResult(project, task, marker, images);
  }
  const imagesById = new Map(images.map(image => [image.id, image]));

  let imagesApplied = 0;
  let mutated = false;
  const nextPanels = project.panels.map((panel): ComicPanel => {
    const subIndex = task.sub_tasks.findIndex((sub, index) => panelIdOfSlot(task, marker, index) === panel.id && !panel.stale);
    if (subIndex < 0 || panel.stale) return panel;
    const sub = task.sub_tasks[subIndex]!;

    if (sub.status === 'completed') {
      const image = sub.image_id ? imagesById.get(sub.image_id) : undefined;
      if (!image) return panel; // 图库记录尚未扫到 → 留待下次刷新（幂等）
      if (panel.imageAsset?.imageId === image.id && panel.generationStatus === 'completed') return panel;
      mutated = true;
      imagesApplied += 1;
      const replaced = Boolean(panel.imageAsset && panel.imageAsset.imageId !== image.id);
      return {
        ...panel,
        generationStatus: 'completed',
        imageAsset: { path: image.local_path, imageId: image.id, taskId: task.id },
        ...(panel.lastError ? { lastError: undefined } : {}),
        ...(replaced ? { regeneratedCount: (panel.regeneratedCount ?? 0) + 1 } : {}),
      };
    }

    const nextStatus = statusOfSub(sub);
    if (panel.generationStatus === nextStatus) return panel;
    mutated = true;
    // §45 失败原因：失败 / 取消带上子任务错误文案；重新成功落图即清除
    const lastError = nextStatus === 'failed'
      ? (sub.error?.trim() || panel.lastError)
      : undefined;
    return { ...panel, generationStatus: nextStatus, ...(lastError !== panel.lastError ? { lastError } : {}) };
  });

  if (!mutated) return { project, changed: false, imagesApplied: 0 };
  return { project: { ...project, panels: nextPanels, updatedAt: new Date().toISOString() }, changed: true, imagesApplied };
}

/**
 * 角色参考图任务回写（Phase 1.1 §七）：completed + 图库可解析 → 绑定为该角色
 * referenceImage（新图即最新设定，清除 stale 标记）；panels 永不触碰。
 * 在途 / 失败不改项目（状态由 comicCharactersSummaryState 从任务事实派生）。
 */
function applyCharacterReferenceResult(
  project: ComicProject,
  task: Task,
  marker: ComicExecutionMarker,
  images: ImageRecord[],
): ComicTaskApplyResult {
  const characterId = marker.characterId
    ?? task.batch_items?.[0]?.variables?.characterId;
  if (!characterId) return { project, changed: false, imagesApplied: 0 };
  const sub = task.sub_tasks[0];
  if (!sub || sub.status !== 'completed' || !sub.image_id) {
    return { project, changed: false, imagesApplied: 0 };
  }
  const image = images.find(item => item.id === sub.image_id);
  if (!image) return { project, changed: false, imagesApplied: 0 }; // 图库记录尚未扫到 → 留待下次刷新
  let mutated = false;
  let imagesApplied = 0;
  const characterSnapshots = project.characterSnapshots.map((character) => {
    if (character.id !== characterId) return character;
    if (character.referenceImage?.imageId === image.id) return character; // 幂等
    mutated = true;
    imagesApplied += 1;
    return {
      ...character,
      referenceImage: {
        path: image.local_path,
        label: `${character.name} · 生成参考图`,
        imageId: image.id,
        taskId: task.id,
        generatedAt: new Date().toISOString(),
      },
      referenceStale: undefined, // 新图即最新设定
    };
  });
  if (!mutated) return { project, changed: false, imagesApplied: 0 };
  return {
    project: { ...project, characterSnapshots, updatedAt: new Date().toISOString() },
    changed: true,
    imagesApplied,
  };
}

/**
 * 文字烘焙任务回写（V4.2.14 §63~§66）：completed + 图库可解析 → panel.bakedTextAsset
 * （派生资产：独立文字层随时可回，原成图 imageAsset 永不覆盖）。在途 / 失败不改项目。
 */
function applyBakeTextResult(
  project: ComicProject,
  task: Task,
  marker: ComicExecutionMarker,
  images: ImageRecord[],
): ComicTaskApplyResult {
  if (!marker.panelId) return { project, changed: false, imagesApplied: 0 };
  const sub = task.sub_tasks[0];
  if (!sub || sub.status !== 'completed' || !sub.image_id) {
    return { project, changed: false, imagesApplied: 0 };
  }
  const image = images.find(item => item.id === sub.image_id);
  if (!image) return { project, changed: false, imagesApplied: 0 }; // 图库记录尚未扫到 → 留待下次刷新（幂等）
  let mutated = false;
  const panels = project.panels.map((panel): ComicPanel => {
    if (panel.id !== marker.panelId) return panel;
    if (panel.bakedTextAsset?.imageId === image.id) return panel; // 幂等
    mutated = true;
    return {
      ...panel,
      bakedTextAsset: {
        path: image.local_path,
        imageId: image.id,
        taskId: task.id,
        bakedAt: new Date().toISOString(),
      },
    };
  });
  if (!mutated) return { project, changed: false, imagesApplied: 0 };
  return { project: { ...project, panels, updatedAt: new Date().toISOString() }, changed: true, imagesApplied: 0 };
}

/** 锚点任务 → 一致性档案 anchor 载荷（首子任务成功且路径可解析才有效；交给用户审定后 lockAnchor）。 */
export function buildAnchorConfirmation(
  project: ComicProject,
  task: Task,
  images: ImageRecord[],
): NonNullable<ComicConsistencyProfile['anchor']> | null {
  const marker = comicTaskMarker(task);
  if (!marker || marker.kind !== 'anchor' || marker.projectId !== project.id) return null;
  const sub = task.sub_tasks[0];
  if (!sub || sub.status !== 'completed' || !sub.image_id || !marker.panelId) return null;
  const image = images.find(item => item.id === sub.image_id);
  if (!image) return null;
  return {
    panelId: marker.panelId,
    path: image.local_path,
    imageId: image.id,
    taskId: task.id,
    lockedAt: new Date().toISOString(), // 审定即冻结（lockAnchor 原样写入 consistency）
  };
}
