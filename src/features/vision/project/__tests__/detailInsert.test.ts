import { describe, expect, it } from 'vitest';
import { fixtureProject } from './fixtures';
import {
  allInsertInstances,
  applyDetailInsertInstances,
  countInsertInstances,
  instancesOfRegion,
} from '../detailInsert';
import { bindDetailInsertsToCharacter, validateAnimeCharacterConsistency } from '../animeCharacter';
import { mergeFinalGenerationPrompt } from '../promptCompiler';
import type { DetailInsertInstance, RenderingContract, VisualProject } from '../types';

const INSTANCES: DetailInsertInstance[] = [
  { id: 'details-ins-1', groupId: 'details', mediaType: 'anime_illustration', cropType: 'face', label: '左上动漫面部特写' },
  { id: 'details-ins-2', groupId: 'details', mediaType: 'anime_illustration', cropType: 'eyes', label: '右上动漫眼部特写' },
  { id: 'details-ins-3', groupId: 'details', mediaType: 'anime_illustration', cropType: 'hair', label: '右下动漫发型特写' },
  { id: 'details-ins-4', groupId: 'details', mediaType: 'photorealistic', cropType: 'face', label: '左下真人面部特写' },
  { id: 'details-ins-5', groupId: 'details', mediaType: 'graphic_design', cropType: 'other', label: '中部图形贴纸' },
];

function projectWithDetailGroup(instances: DetailInsertInstance[] | null = INSTANCES): VisualProject {
  const project = fixtureProject();
  const rendering: RenderingContract = {
    overallMode: 'mixed_media',
    preserveTemplateMediaStructure: true,
    regions: [
      { id: 'photo', label: '真人主体', semanticRole: 'primary_subject', renderingMode: 'photorealistic', identityRelation: 'template_identity' },
      { id: 'anime', label: '动漫主角色', semanticRole: 'secondary_subject', renderingMode: 'anime_illustration', identityRelation: 'same_as_primary' },
      {
        id: 'details',
        label: '四角与中部局部插图',
        semanticRole: 'detail_insert',
        renderingMode: 'anime_illustration',
        identityRelation: 'same_as_primary',
        description: '四角多个不同的局部插图画框',
        ...(instances ? { instances } : {}),
      },
    ],
  };
  return {
    ...project,
    renderingContract: rendering,
    templateSnapshot: project.templateSnapshot
      ? { ...project.templateSnapshot, mediaStructure: rendering }
      : project.templateSnapshot,
  };
}

describe('Detail Group 与 Detail Instance 分离', () => {
  it('一个插图组中的五个画框按实例计数，不把 group count 当 instance count', () => {
    const project = projectWithDetailGroup();
    const entries = allInsertInstances(project.renderingContract);
    const counts = countInsertInstances(project.renderingContract);
    expect(entries).toHaveLength(1);
    expect(entries[0].resolution.instances).toHaveLength(5);
    expect(counts).toEqual(expect.objectContaining({ total: 5, anime: 3, photographic: 1, other: 1 }));
  });

  it('动漫面部、眼部、发型画框分别绑定；真人与图形实例不绑定动漫角色', () => {
    const project = projectWithDetailGroup();
    const bound = bindDetailInsertsToCharacter(project)!;
    expect(bound.bindings).toHaveLength(5);
    expect(bound.bindings.filter(item => item.characterRef)).toHaveLength(3);
    expect(bound.bindings.filter(item => item.characterRef).map(item => item.cropType)).toEqual(['face', 'eyes', 'hair']);
    expect(bound.bindings.filter(item => !item.characterRef).map(item => item.mediaType)).toEqual(['photorealistic', 'graphic_design']);
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '只修改人物身份。',
      imageReferences: [{ path: 'D:/imgs/template.png', label: '模板', role: 'template' }],
      personReplacementEnabled: false,
    });
    for (const label of INSTANCES.map(item => item.label)) expect(compiled.prompt).toContain(label);
  });

  it('描述明确含多个画框但缺少 instances 时不合成假实例，并用用户语言阻断生成', () => {
    const project = projectWithDetailGroup(null);
    const region = project.renderingContract!.regions.find(item => item.id === 'details')!;
    expect(instancesOfRegion(region)).toEqual({ instances: [], synthesizedFallback: false, incomplete: true });
    expect(countInsertInstances(project.renderingContract).total).toBe(0);
    expect(validateAnimeCharacterConsistency(project)[0]).toContain('尚未逐个识别');
    expect(validateAnimeCharacterConsistency(project)[0]).not.toContain('instances');
  });

  it('受限修复只补目标层 instances，不改模板其它字段', () => {
    const project = projectWithDetailGroup(null);
    const snapshot = project.templateSnapshot!;
    const repaired = applyDetailInsertInstances(snapshot, 'details', INSTANCES);
    expect(repaired).not.toBe(snapshot);
    expect(repaired.subject).toBe(snapshot.subject);
    expect(repaired.style).toBe(snapshot.style);
    expect(repaired.mediaStructure?.regions.find(item => item.id === 'details')?.instances).toHaveLength(5);
    expect(snapshot.mediaStructure?.regions.find(item => item.id === 'details')?.instances).toBeUndefined();
  });
});
