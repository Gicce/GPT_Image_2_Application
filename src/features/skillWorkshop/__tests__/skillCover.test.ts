/**
 * V6.3 Skill Cover / Entity Cover（§37-§48）回归：
 *
 *  - cover = display-only 元数据：优先级 用户自定义 ＞ 公开样例 ＞ 模板图 ＞ 图标；
 *  - 持久化走 Rust data_json 透传（无结构迁移）；载入合法化拒绝坏数据；
 *  - 隐私铁律：封面（图库引用路径）绝不进入投稿载荷；
 *  - 删除 Skill 不删除图库文件（封面只是引用，没有文件所有权）；
 *  - UI：我的技能卡片真实缩略图 + 唯一 ImageLibraryPicker 换封面；创作器末步封面卡。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createUserSkillFromVisualProject,
  normalizeSkillCover,
  normalizeUserSkillDraft,
  resolveSkillCoverPath,
  sanitizeUserSkillForSubmission,
  skillCoverSamplePath,
  type UserSkillDraft,
} from '../userSkill';

const WORKSHOP_SRC = readFileSync(new URL('../../../pages/SkillWorkshop.tsx', import.meta.url), 'utf-8');
const CREATOR_SRC = readFileSync(new URL('../SkillCreatorDialog.tsx', import.meta.url), 'utf-8');
const COVER_MODULE_SRC = readFileSync(new URL('../userSkill.ts', import.meta.url), 'utf-8');

/** 任意可保存的项目形态（封面测试不关心合同细节，复用最小 mixed 案例成本高——直接构造 draft）。 */
function anyDraft(): UserSkillDraft {
  return normalizeUserSkillDraft({
    id: 'skill-cover-1', name: '封面测试 Skill', coreRules: ['规则一'],
    profiles: [{ id: 'p', name: '基线', kind: 'base', prompt: 'x' }],
  })!;
}

function draftWithSamples(samples: UserSkillDraft['samples']): UserSkillDraft {
  return { ...anyDraft(), samples };
}

describe('V6.3 §38-§39：cover 载入合法化', () => {
  it('normalizeKeepsValidCovers：library 带路径保留；template / generated_result 不需要路径', () => {
    expect(normalizeSkillCover({ source: 'library', path: 'D:/imgs/cover.png', assetId: 'a1', updatedAt: '2026-08-28T00:00:00Z' }))
      .toEqual({ source: 'library', path: 'D:/imgs/cover.png', assetId: 'a1', updatedAt: '2026-08-28T00:00:00Z' });
    expect(normalizeSkillCover({ source: 'custom', path: 'D:/imgs/own.png' }))
      .toEqual({ source: 'custom', path: 'D:/imgs/own.png' });
    expect(normalizeSkillCover({ source: 'template' })).toEqual({ source: 'template' });
    expect(normalizeSkillCover({ source: 'generated_result' })).toEqual({ source: 'generated_result' });
  });

  it('normalizeRejectsBrokenCovers：library 无路径 / 未知来源 / 空对象 ⇒ null（不伪造封面）', () => {
    expect(normalizeSkillCover({ source: 'library' })).toBeNull();
    expect(normalizeSkillCover({ source: 'library', path: '   ' })).toBeNull();
    expect(normalizeSkillCover({ source: 'unknown' })).toBeNull();
    expect(normalizeSkillCover(null)).toBeNull();
    expect(normalizeSkillCover('template')).toBeNull();
  });

  it('draftRoundtripKeepsCover：JSON 往返（data_json 透传语义）保留封面；坏封面被剥离', () => {
    const draft = { ...anyDraft(), cover: { source: 'library', path: 'D:/imgs/cover.png', assetId: 'a1' } };
    const restored = normalizeUserSkillDraft(JSON.parse(JSON.stringify(draft)))!;
    expect(restored.cover).toEqual({ source: 'library', path: 'D:/imgs/cover.png', assetId: 'a1' });
    const broken = normalizeUserSkillDraft(JSON.parse(JSON.stringify({ ...anyDraft(), cover: { source: 'library' } })))!;
    expect(broken.cover).toBeUndefined();
  });
});

describe('V6.3 §44：封面解析优先级（自定义 ＞ 公开样例 ＞ 模板图 ＞ 图标）', () => {
  it('customCoverWins：用户自定义封面压过样例与模板', () => {
    expect(resolveSkillCoverPath(
      { source: 'library', path: 'D:/imgs/own.png' },
      { samplePath: 'D:/imgs/sample.png', templatePath: 'D:/imgs/template.png' },
    )).toBe('D:/imgs/own.png');
  });

  it('sampleBeatsTemplate：generated_result（或旧数据缺省）走样例，无样例落模板', () => {
    expect(resolveSkillCoverPath(
      { source: 'generated_result' },
      { samplePath: 'D:/imgs/sample.png', templatePath: 'D:/imgs/template.png' },
    )).toBe('D:/imgs/sample.png');
    expect(resolveSkillCoverPath(
      { source: 'generated_result' },
      { templatePath: 'D:/imgs/template.png' },
    )).toBe('D:/imgs/template.png');
    // 旧数据（无 cover 字段）同链兜底
    expect(resolveSkillCoverPath(undefined, { samplePath: 'D:/imgs/sample.png', templatePath: 'D:/imgs/t.png' }))
      .toBe('D:/imgs/sample.png');
  });

  it('templateSourcePrefersTemplateButFallsBack：模板缺失（如 generic）时回落样例，全无 ⇒ null', () => {
    expect(resolveSkillCoverPath({ source: 'template' }, { samplePath: 'D:/imgs/s.png' })).toBe('D:/imgs/s.png');
    expect(resolveSkillCoverPath({ source: 'template' }, {})).toBeNull();
    expect(resolveSkillCoverPath(null, {})).toBeNull();
    // 自定义封面但路径损坏（空串）⇒ 沿链兜底而非 undefined
    expect(resolveSkillCoverPath({ source: 'custom', path: '' }, { templatePath: 'D:/imgs/t.png' })).toBe('D:/imgs/t.png');
  });

  it('samplePathPriority：publicCover ＞ selectedForSubmission ＞ 任一样例', () => {
    expect(skillCoverSamplePath(draftWithSamples([
      { id: '1', taskId: 't', imagePath: 'D:/imgs/any.png', selectedForSubmission: false, publicCover: false },
      { id: '2', taskId: 't', imagePath: 'D:/imgs/submitted.png', selectedForSubmission: true, publicCover: false },
      { id: '3', taskId: 't', imagePath: 'D:/imgs/public.png', selectedForSubmission: false, publicCover: true },
    ]))).toBe('D:/imgs/public.png');
    expect(skillCoverSamplePath(draftWithSamples([
      { id: '1', taskId: 't', imagePath: 'D:/imgs/any.png', selectedForSubmission: false, publicCover: false },
      { id: '2', taskId: 't', imagePath: 'D:/imgs/submitted.png', selectedForSubmission: true, publicCover: false },
    ]))).toBe('D:/imgs/submitted.png');
    expect(skillCoverSamplePath(draftWithSamples([
      { id: '1', taskId: 't', imagePath: 'D:/imgs/only.png', selectedForSubmission: false, publicCover: false },
    ]))).toBe('D:/imgs/only.png');
    expect(skillCoverSamplePath(draftWithSamples([]))).toBeUndefined();
  });

  it('newSkillDefaultsToTemplateCover：从视觉项目创建的 Skill 默认模板封面（解析期动态取路径）', () => {
    // createUserSkillFromVisualProject 的默认值语义（模板路径不落死在 cover 里）
    expect(COVER_MODULE_SRC).toContain("cover: { source: 'template' }");
  });
});

describe('V6.3 §46-§47：隐私与边界（display-only，不碰投稿 / 不删文件）', () => {
  it('coverNeverEntersSubmissionPayload：投稿载荷不含 cover 字段与图库本地路径', () => {
    const draft = { ...anyDraft(), cover: { source: 'library' as const, path: 'D:/imgs/private-cover.png' } };
    const { payload } = sanitizeUserSkillForSubmission(draft);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('cover');
    expect(serialized).not.toContain('D:/imgs/private-cover.png');
  });

  it('coverIsReferenceNotOwnership：封面模块零文件操作（无删除 / 复制 / 移动调用）', () => {
    expect(COVER_MODULE_SRC).not.toContain('deleteFile');
    expect(COVER_MODULE_SRC).not.toContain('removeFile');
    expect(COVER_MODULE_SRC).not.toContain('copyFile');
  });
});

describe('V6.3 §40-§43 / §48：UI 接线（唯一 picker + 持久化 + 本机边界文案）', () => {
  it('workshopCardShowsRealThumbnail：SkillCoverThumb 真实缩略图 + glyph 回落 + 更换封面菜单', () => {
    expect(WORKSHOP_SRC).toContain('function SkillCoverThumb');
    expect(WORKSHOP_SRC).toContain('my-skill-cover is-image');
    expect(WORKSHOP_SRC).toContain('api.readThumbnail');
    expect(WORKSHOP_SRC).toContain('>更换封面</button>');
  });

  it('workshopReusesSoleImagePicker：封面选择复用唯一 ImageLibraryPicker（禁止第二选择器实现）', () => {
    expect(WORKSHOP_SRC).toContain('import ImageLibraryPicker');
    expect(WORKSHOP_SRC.match(/<ImageLibraryPicker/g)?.length).toBe(1);
    expect(WORKSHOP_SRC).toContain("title=\"选择 Skill 封面\"");
  });

  it('coverChangePersistsAndStatesBoundary：换封面重新载入草稿 + dataJson 整包保存 + 本机边界文案', () => {
    expect(WORKSHOP_SRC).toContain('applySkillCover');
    expect(WORKSHOP_SRC).toContain("source: 'library'");
    expect(WORKSHOP_SRC).toContain('api.saveUserSkill');
    // 边界：本机展示元数据，不假装同步服务器投稿
    expect(WORKSHOP_SRC).toContain('仅本机展示');
    expect(WORKSHOP_SRC).toContain('已提交的审核记录');
    // 删除 Skill 仍只删本地记录（封面引用的图库文件不受影响）
    expect(WORKSHOP_SRC).toContain('api.deleteUserSkill(deleteTarget.id)');
  });

  it('creatorFinalStepHasCoverCard：创作器「保存与发布」含封面卡 + 恢复默认 + 独立 picker 实例', () => {
    expect(CREATOR_SRC).toContain('skill-cover-card');
    expect(CREATOR_SRC).toContain('从图片库选择封面');
    expect(CREATOR_SRC).toContain('恢复默认（模板图）');
    expect(CREATOR_SRC).toContain('setCoverPickOpen');
    // 两个 picker 实例（样例 + 封面）都是同一组件；Escape 由 picker 各自消化
    expect(CREATOR_SRC.match(/<ImageLibraryPicker/g)?.length).toBe(2);
    expect(CREATOR_SRC).toContain('galleryOpenRef.current = galleryOpen || coverPickOpen');
  });
});
