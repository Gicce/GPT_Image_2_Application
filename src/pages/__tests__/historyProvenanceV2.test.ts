import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * History V4.1 Provenance V2 源码契约：
 *  - 项目来源段（projectId / projectName / projectRevision）只读任务快照；
 *  - History 禁止 import useVisualProjectStore（绝不为展示去读「当前项目状态」——
 *    项目之后演进不影响历史任务展示，修订冻结在生成瞬间）；
 *  - 旧任务（无 provenance / 无 projectId）不渲染项目来源 / 区域 / 媒介段（不伪造）；
 *  - 区域段渲染 mask 状态与归一化几何；mask 缩略图进 sourceUrls。
 */

const historySrc = readFileSync(resolve(__dirname, '../History.tsx'), 'utf-8');

describe('historyUsesProjectSnapshotNotCurrentProjectState', () => {
  test('项目来源 / 区域 / 人物合同全部读 task.provenance 快照字段', () => {
    expect(historySrc).toContain('provenance?.projectId');
    expect(historySrc).toContain('provenance!.projectName');
    expect(historySrc).toContain('provenance!.projectRevision');
    expect(historySrc).toContain('provenance?.personContract');
    expect(historySrc).toContain('provenance?.renderingContract');
    expect(historySrc).toContain('provenance!.regions');
  });

  test('History 绝不 import 项目 store（当前项目状态 ≠ 历史快照）', () => {
    expect(historySrc).not.toContain('useVisualProjectStore');
    expect(historySrc).not.toContain('visualProject');
  });

  test('区域段只读快照：类型 / 范围 / 约束 / 归一化几何 / mask 状态', () => {
    expect(historySrc).toContain('REGION_TYPE_LABELS_HISTORY');
    expect(historySrc).toContain('PERSON_SCOPE_LABELS_HISTORY');
    expect(historySrc).toContain('PERSON_STRENGTH_LABELS_HISTORY');
    expect(historySrc).toMatch(/region\.rect\.x\.toFixed\(2\)/);
    expect(historySrc).toContain('mask 已提交');
    expect(historySrc).toContain('无栅格 mask');
  });

  test('mask 缩略图随 sourceUrls 加载（读取失败不阻塞）', () => {
    expect(historySrc).toMatch(/selectedTask\.mask_image[\s\S]{0,200}readThumbnail/);
  });

  test('任务概览含区域 mask 提交行（task.mask_image 真实进入请求的展示锚点）', () => {
    expect(historySrc).toContain('区域 mask');
    expect(historySrc).toContain('已随请求提交');
  });
});

describe('legacyVisionTaskDoesNotInventProjectFields（旧任务兼容）', () => {
  test('项目来源 / 区域段 / 合同行全部有存在性守卫（缺字段 = 不渲染该段）', () => {
    expect(historySrc).toContain('const hasProjectSource = !!(provenance?.projectId && provenance?.projectName)');
    expect(historySrc).toContain('const hasRegions = (provenance?.regions?.length ?? 0) > 0');
    expect(historySrc).toMatch(/\{hasProjectSource && \(/);
    expect(historySrc).toMatch(/\{hasRegions && \(/);
  });

  test('旧任务参考图仍按「参考图 N」编号展示（不猜角色）', () => {
    expect(historySrc).toContain('label: `参考图 ${index + 1}`');
  });

  test('用户要求段保留「未保存原始用户要求」如实提示（不伪造）', () => {
    expect(historySrc).toContain('该历史任务未保存原始用户要求');
  });
});
