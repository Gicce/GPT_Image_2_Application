import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 动作白膜 UI 接入守卫（源码文本断言，与 gallerySourceProvenance 同风格）：
 * - Gallery 卡片来源徽标（CY Video Studio）只由 resolver 的 sourceApp 驱动；
 * - 详情批次区（标题「动作白膜」）行来自 resolveImageDetailMetadata（来源 / 用途在基础信息区）；
 * - TaskQueue 来源标签走 poseBatchTaskSourceLabel（动作白膜 / 视频复刻细分）。
 */

const gallerySrc = readFileSync(resolve(__dirname, '../Gallery.tsx'), 'utf-8');
const taskQueueSrc = readFileSync(resolve(__dirname, '../TaskQueue.tsx'), 'utf-8');
const detailResolverSrc = readFileSync(resolve(__dirname, '../../features/gallery/imageDetailMetadata.ts'), 'utf-8');

describe('Gallery 动作白膜来源接入', () => {
  test('卡片徽标由 cls.sourceApp 驱动（复用 .gallery-kind-badge，本地徽标不受影响）', () => {
    expect(gallerySrc).toMatch(/\{cls\.sourceApp && <span className="gallery-kind-badge">\{cls\.sourceApp\}<\/span>\}/);
    expect(gallerySrc).toMatch(/cls\.isLocal && <span className="gallery-kind-badge">本地<\/span>/);
  });

  test('详情批次区（动作 / 视角 / 关键帧 / 追溯键）行来自 detail resolver，来源 / 用途在基础信息区', () => {
    expect(gallerySrc).toContain('gallery-detail-section-title">动作白膜<');
    expect(gallerySrc).toMatch(/poseRows\.length > 0/);
    expect(detailResolverSrc).toContain('poseSlotOfImage');
    expect(detailResolverSrc).toContain("{ label: '动作', value: poseBatch.action_name }");
    expect(detailResolverSrc).toContain("{ label: '视角', value: poseViewLabel(poseSlot.view) }");
    expect(detailResolverSrc).toContain("{ label: '关键帧', value: poseKeyframeLabel(poseSlot.keyframe) }");
    expect(detailResolverSrc).toContain("{ label: 'Batch ID', value: poseBatch.batch_id, copyValue: poseBatch.batch_id }");
    expect(detailResolverSrc).toContain("{ label: 'Slot ID'");
    expect(detailResolverSrc).toContain("{ label: 'Request ID'");
    expect(detailResolverSrc).toContain("{ label: 'Preset Version', value: poseBatch.preset_version }");
    // 来源 = CY Video Studio、用途 = 动作白膜 是基础信息区的独立两行
    expect(detailResolverSrc).toContain("{ label: '来源', value: sourceLabel }");
    expect(detailResolverSrc).toContain("'动作白膜' : undefined");
  });
});

describe('TaskQueue 动作白膜来源接入', () => {
  test('来源标签细分走 poseBatchTaskSourceLabel（不再硬编码视频复刻）', () => {
    expect(taskQueueSrc).toMatch(/poseBatchTaskSourceLabel\(task\)/);
    expect(taskQueueSrc).not.toContain("return 'CY Video Studio · 视频复刻'");
  });
});
