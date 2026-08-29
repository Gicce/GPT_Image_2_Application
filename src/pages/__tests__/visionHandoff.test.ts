/**
 * V6.2 Handoff Responsiveness 回归（确认生成 → 图片工作室）：
 *  - 确认后同步守卫全过 ⇒ 立即关弹窗 + 过渡态（100ms 级体感，重活后移）；
 *  - 防重入：一次确认只允许一个交接在途；
 *  - correction toast 去重：同 operation + 同 key 只弹一次（严格模式 / 镜像重放）；
 *  - 外貌解析预热：先发起、后等待（不在弹窗里同步阻塞）；
 *  - 失败回到工作台（弹窗不复活），成功 navigate imagestudio。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  newHandoffOperationId,
  resetCorrectionToastDedup,
  shouldShowCorrectionToast,
} from '../../features/vision/handoffOperation';

const PAGE_SRC = readFileSync(new URL('../VisionUnderstanding.tsx', import.meta.url), 'utf-8');
const CSS_SRC = readFileSync(new URL('../VisionUnderstanding.css', import.meta.url), 'utf-8');

describe('handoffOperation（去重纯函数）', () => {
  beforeEach(() => resetCorrectionToastDedup());

  it('dedupsSameOperationAndKey：同 operation 同 key 只展示一次，不同 key / 不同 operation 正常展示', () => {
    const operation = newHandoffOperationId();
    expect(shouldShowCorrectionToast(operation, 'anime_guard')).toBe(true);
    expect(shouldShowCorrectionToast(operation, 'anime_guard')).toBe(false);
    expect(shouldShowCorrectionToast(operation, 'clothing_guard')).toBe(true);
    expect(shouldShowCorrectionToast(operation, 'lock_guard')).toBe(true);
    const next = newHandoffOperationId();
    expect(next).not.toBe(operation);
    expect(shouldShowCorrectionToast(next, 'anime_guard')).toBe(true);
  });

  it('operationIdIsUniqueAndShaped：handoff-<ms>-<rand>，连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newHandoffOperationId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^handoff-/);
  });
});

describe('VisionUnderstanding Handoff 接线（源码级守卫）', () => {
  it('closesConfirmImmediatelyAfterSyncGuards：守卫后立即关弹窗 + 过渡态（重活后移）', () => {
    const generateFromPlan = PAGE_SRC.slice(PAGE_SRC.indexOf('const generateFromPlan'));
    const closeAt = generateFromPlan.indexOf('setGenerateConfirmOpen(false)');
    const preparingAt = generateFromPlan.indexOf('setHandoffPreparing(true)');
    expect(closeAt).toBeGreaterThan(-1);
    expect(preparingAt).toBeGreaterThan(closeAt);
    // 立即关弹窗发生在重活（外貌解析 / 编译）之前
    expect(generateFromPlan.indexOf('const appearancePromise')).toBeGreaterThan(preparingAt);
    expect(generateFromPlan.indexOf('mergeFinalGenerationPrompt({')).toBeGreaterThan(preparingAt);
  });

  it('guardsReentryWithInFlightRef：在途交接期间二次确认直接忽略', () => {
    expect(PAGE_SRC).toContain('if (handoffInFlightRef.current) return;');
    expect(PAGE_SRC).toContain('handoffInFlightRef.current = true;');
    expect(PAGE_SRC).toContain('handoffInFlightRef.current = false;');
  });

  it('dedupsCorrectionToastsByOperation：三种系统修正共用 operationId 去重', () => {
    expect(PAGE_SRC).toContain("shouldShowCorrectionToast(operationId, 'anime_guard')");
    expect(PAGE_SRC).toContain("shouldShowCorrectionToast(operationId, 'clothing_guard')");
    expect(PAGE_SRC).toContain("shouldShowCorrectionToast(operationId, 'lock_guard')");
  });

  it('preheatsAppearanceBeforeAwaiting：外貌解析先发起、溯源装配后等待', () => {
    const generateFromPlan = PAGE_SRC.slice(PAGE_SRC.indexOf('const generateFromPlan'));
    const startAt = generateFromPlan.indexOf('const appearancePromise');
    const awaitAt = generateFromPlan.indexOf('await appearancePromise');
    expect(startAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(startAt);
    // 等待点在溯源快照装配之后（并行窗口最大化）
    const provenanceAt = generateFromPlan.indexOf('buildGenerationProvenance({');
    expect(provenanceAt).toBeGreaterThan(startAt);
    expect(awaitAt).toBeGreaterThan(provenanceAt);
  });

  it('showsHandoffOverlayWithHonestCopy：过渡态 = 状态指示 + 正在进入文案（非 loading 假进度）', () => {
    expect(PAGE_SRC).toContain('data-testid="vision-handoff-overlay"');
    expect(PAGE_SRC).toContain('正在进入图片工作室…');
    expect(CSS_SRC).toContain('.vision-handoff-overlay');
    // 过渡态不伪造百分比进度
    const overlayBlock = PAGE_SRC.slice(
      PAGE_SRC.indexOf('vision-handoff-overlay'),
      PAGE_SRC.indexOf('vision-handoff-overlay') + 600,
    );
    expect(overlayBlock).not.toContain('%');
  });

  it('finishesHandoffBeforeNavigate：成功路径先收尾再导航 imagestudio', () => {
    const generateFromPlan = PAGE_SRC.slice(PAGE_SRC.indexOf('const generateFromPlan'));
    const finishAt = generateFromPlan.indexOf('finishHandoff();', generateFromPlan.indexOf('buildGenerationCarry'));
    const navigateAt = generateFromPlan.indexOf("page: 'imagestudio'");
    expect(finishAt).toBeGreaterThan(-1);
    expect(navigateAt).toBeGreaterThan(finishAt);
  });
});
