import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProject } from './fixtures';
import { characterAssetFingerprint, isCharacterAssetReusable } from '../animeCharacter';
import {
  animeCharacterReferenceImage,
  requestCharacterAssetGeneration,
  withAnimeCharacterReference,
} from '../animeCharacterAssetService';
import type { VisualProject } from '../types';

vi.mock('../../../../services/api', () => ({
  api: {
    getSettings: vi.fn(async () => ({ default_output_dir: 'D:/out', default_quality: 'auto', default_format: 'png' })),
    createTask: vi.fn(async () => ({ id: 'character-task-1' })),
  },
}));

vi.mock('../../../../services/billingService', () => ({
  authorizeImageTask: vi.fn(async () => ({ amount_credits: 8 })),
  createRequestId: vi.fn(() => 'anime-request-1'),
  registerTaskAuthorization: vi.fn(),
  settleImageTask: vi.fn(),
}));

vi.mock('../../../../store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ isLoggedIn: true }) },
}));

vi.mock('../../../../store/useTaskStore', () => ({ registerTaskRefreshHook: vi.fn() }));

import { api } from '../../../../services/api';
import { authorizeImageTask, registerTaskAuthorization, settleImageTask } from '../../../../services/billingService';

function strictProject(): VisualProject {
  const project = fixtureProject();
  const rendering = {
    overallMode: 'mixed_media' as const,
    preserveTemplateMediaStructure: true,
    regions: [
      { id: 'photo', label: '真人主体', semanticRole: 'primary_subject' as const, renderingMode: 'photorealistic' as const, identityRelation: 'template_identity' as const },
      { id: 'anime', label: '动漫角色', semanticRole: 'secondary_subject' as const, renderingMode: 'anime_illustration' as const, identityRelation: 'same_as_primary' as const },
    ],
  };
  return {
    ...project,
    renderingContract: rendering,
    templateSnapshot: { ...project.templateSnapshot!, mediaStructure: rendering },
    modification: {
      ...project.modification,
      person: {
        enabled: true,
        source: 'local',
        path: 'D:/imgs/person.png',
        label: '人物参考',
        strength: 'strict',
        replaceScope: 'whole_person',
        preserveTemplateIdentity: false,
        applyIdentityTo: 'all_corresponding_subjects',
      },
    },
    animeConsistency: { mode: 'strict_visual_reference' },
  };
}

function withCachedAsset(project: VisualProject): VisualProject {
  return {
    ...project,
    animeConsistency: {
      mode: 'strict_visual_reference',
      characterAsset: {
        id: 'asset-character',
        projectRevision: project.revision,
        localPath: 'D:/out/character.png',
        characterSnapshotId: 'canonical-anime-character',
        fingerprint: characterAssetFingerprint(project),
        createdAt: '2026-08-25T00:00:00Z',
      },
    },
  };
}

describe('Strict Visual Reference 资产、缓存与报价', () => {
  beforeEach(() => vi.clearAllMocks());

  it('首次创建先确认服务端报价，再创建一张角色参考图任务', async () => {
    const outcome = await requestCharacterAssetGeneration(strictProject());
    expect(outcome).toEqual({ ok: true, taskId: 'character-task-1' });
    expect(authorizeImageTask).toHaveBeenCalledWith('anime-request-1', 1);
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ count: 1, source_images: ['D:/imgs/person.png'] }));
    expect(registerTaskAuthorization).toHaveBeenCalledWith('character-task-1', 'anime-request-1');
  });

  it('用户取消报价时不创建任务，也不产生自动扣费', async () => {
    vi.mocked(authorizeImageTask).mockRejectedValueOnce(Object.assign(new Error('用户取消'), { quoteCancelled: true }));
    expect(await requestCharacterAssetGeneration(strictProject())).toEqual({ ok: false, cancelled: true });
    expect(api.createTask).not.toHaveBeenCalled();
    expect(registerTaskAuthorization).not.toHaveBeenCalled();
    expect(settleImageTask).not.toHaveBeenCalled();
  });

  it('计费授权后任务创建失败会释放预留，不留下扣费', async () => {
    vi.mocked(api.createTask).mockRejectedValueOnce(new Error('创建失败'));
    expect(await requestCharacterAssetGeneration(strictProject())).toEqual({ ok: false, errorMessage: '创建失败' });
    expect(settleImageTask).toHaveBeenCalledWith(
      'anime-request-1', false, 0, 'anime character asset task create failed',
    );
    expect(registerTaskAuthorization).not.toHaveBeenCalled();
  });

  it('缓存命中时零新增成本：不报价、不创建任务，并作为第三参考角色返回', async () => {
    const cached = withCachedAsset(strictProject());
    expect(isCharacterAssetReusable(cached)).toBe(true);
    expect(animeCharacterReferenceImage(cached)).toEqual({ path: 'D:/out/character.png', label: '动漫角色参考' });
    expect(await requestCharacterAssetGeneration(cached)).toEqual({ ok: true, reused: true });
    expect(authorizeImageTask).not.toHaveBeenCalled();
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('最终提交顺序固定为模板、人物、动漫角色参考、其它引用', () => {
    const ordered = withAnimeCharacterReference([
      { path: 'D:/template.png', label: '模板', role: 'template' },
      { path: 'D:/person.png', label: '人物', role: 'person_reference' },
      { path: 'D:/background.png', label: '背景', role: 'background_reference' },
    ], { path: 'D:/character.png', label: '动漫角色参考', role: 'anime_character_reference' });
    expect(ordered.map(item => item.role)).toEqual([
      'template', 'person_reference', 'anime_character_reference', 'background_reference',
    ]);
  });

  it('人物、服装或风格变化会失效；动作、镜头、背景和构图变化不会失效', () => {
    const base = withCachedAsset(strictProject());
    const passiveChanges: VisualProject = {
      ...base,
      modification: { ...base.modification, freeText: '改成跑步动作与低机位，背景换为夜景', activeDimensions: ['pose', 'camera', 'scene'] },
    };
    expect(isCharacterAssetReusable(passiveChanges)).toBe(true);
    expect(isCharacterAssetReusable({
      ...base,
      modification: { ...base.modification, person: { ...base.modification.person!, path: 'D:/imgs/new-person.png' } },
    })).toBe(false);
    expect(isCharacterAssetReusable({
      ...base,
      modification: { ...base.modification, clothingPolicy: 'custom', customClothing: '蓝色夹克' },
    })).toBe(false);
    expect(isCharacterAssetReusable({
      ...base,
      templateSnapshot: { ...base.templateSnapshot!, style: { ...base.templateSnapshot!.style, originalValue: '赛璐璐动画' } },
    })).toBe(false);
    expect(isCharacterAssetReusable({
      ...base,
      referenceAppearance: {
        fingerprint: 'person-ref-v2',
        analyzedAt: '2026-08-25T00:00:00Z',
        hair: {
          baseColor: '深棕色',
          length: 'shoulder',
          texture: 'straight',
          parting: 'center',
          bangs: 'curtain',
          silhouetteDescription: '肩长直发',
        },
        face: { shape: '鹅蛋脸', eyeShape: '杏眼', irisColor: '棕色' },
        accessories: [],
        clothing: [],
      },
    })).toBe(false);
  });
});
