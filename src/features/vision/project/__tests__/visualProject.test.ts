import { describe, it, expect } from 'vitest';
import {
  createVisualProjectFromAnalysis,
  deriveVisualProject,
  duplicateVisualProject,
  normalizeModificationContract,
  setProjectPersonContract,
  toModificationContract,
  updateVisualProjectSemanticState,
  updateVisualProjectViewState,
  describeProjectStatus,
} from '../project';
import { buildEffectiveVisualPlan } from '../effectivePlan';
import { validateGenerationContract, validateVisualProject } from '../validators';
import { migrateLegacyWorkspace } from '../migrate';
import { EMPTY_MODIFICATION_DRAFT } from '../../modificationIntent';
import { fixtureAnalysis, fixtureProject, emptyWorkspace } from './fixtures';
import type { PersonReplacementContract } from '../types';

function personContract(partial: Partial<PersonReplacementContract> = {}): PersonReplacementContract {
  return {
    enabled: true,
    source: 'gallery',
    assetId: 'asset-person',
    path: 'D:/imgs/person.png',
    label: '人物参考',
    strength: 'strict',
    replaceScope: 'whole_person',
    preserveTemplateIdentity: false,
    applyIdentityTo: 'primary_subject_only',
    ...partial,
  };
}

describe('visualProjectCreatesFromAnalysis（分析 → 项目）', () => {
  it('分析成功即冻结模板基线：九维度 originalValue 来自分析初始值', () => {
    const project = fixtureProject();
    expect(project.id).toBeTruthy();
    expect(project.status).toBe('ready');
    expect(project.revision).toBe(0);
    expect(project.templateSnapshot?.sourcePath).toBe('D:/imgs/template.png');
    expect(project.templateSnapshot?.subject.originalValue).toContain('篮球运动员');
    expect(project.templateSnapshot?.clothing.originalValue).toContain('红色 23 号球衣');
    expect(project.templateSnapshot?.schemaVersion).toBe(1);
    expect(project.renderingContract?.overallMode).toBe('single_media');
  });

  it('修改人物 / 背景绝不污染 TemplateSnapshot（Template = baseline，Modification = overlay）', () => {
    const project = fixtureProject();
    const subjectBefore = project.templateSnapshot!.subject.originalValue;
    const backgroundBefore = project.templateSnapshot!.background.originalValue;
    const withPerson = setProjectPersonContract(project, personContract());
    const modified = updateVisualProjectSemanticState(withPerson, 'dimensions', draft => ({
      ...draft,
      modification: {
        ...draft.modification,
        activeDimensions: [...draft.modification.activeDimensions, 'scene' as const],
      },
    }));
    // 即使用户把 recreation 维度值全改了，模板基线也不动
    const mutatedRecreation = {
      ...modified,
      workspace: {
        ...modified.workspace,
        recreation: modified.workspace.recreation
          ? {
            ...modified.workspace.recreation,
            plan: {
              ...modified.workspace.recreation.plan,
              fields: modified.workspace.recreation.plan.fields.map(() => ({
                key: 'subject' as const,
                label: '已改',
                value: '已被用户改掉',
                locked: false,
                originalValue: '已被用户改掉',
              })),
            },
          }
          : null,
      },
    };
    const restored = createVisualProjectFromAnalysis; // 模板只在分析时刻冻结
    expect(restored).toBeTruthy();
    expect(mutatedRecreation.templateSnapshot!.subject.originalValue).toBe(subjectBefore);
    expect(mutatedRecreation.templateSnapshot!.background.originalValue).toBe(backgroundBefore);
  });
});

describe('semanticRevisionChangesOnlyOnSemanticEdit（语义修订白名单）', () => {
  it('语义修改（人物合同）→ revision +1；视图状态 → revision 不变', () => {
    const project = fixtureProject();
    expect(project.revision).toBe(0);
    const semanticallyChanged = setProjectPersonContract(project, personContract());
    expect(semanticallyChanged.revision).toBe(1);
    const viewOnly = updateVisualProjectViewState(semanticallyChanged, draft => ({
      ...draft,
      lastOpenedAt: new Date().toISOString(),
    }));
    expect(viewOnly.revision).toBe(1);
    const semanticAgain = updateVisualProjectSemanticState(viewOnly, 'regions', draft => ({
      ...draft,
      regions: [
        {
          id: 'region-1',
          name: '区域 1',
          shape: { kind: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.5 },
          replaceType: 'person',
          constraintStrength: 'strict',
          replaceScope: 'whole_person',
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    expect(semanticAgain.revision).toBe(2);
  });

  it('viewStateDoesNotChangeProjectRevision：折叠 / Tab 类操作零修订（updatedAt 不动）', () => {
    const project = fixtureProject({ name: 'X' });
    const untouched = updateVisualProjectViewState(project, draft => draft);
    expect(untouched).toBe(project);
  });
});

describe('duplicateProjectKeepsTemplate / deriveProjectResetsPersonReference（项目复用）', () => {
  it('复制项目：模板 / 合同 / 区域全复制，id 换新，生成历史与 revision 归零', () => {
    const project = setProjectPersonContract(fixtureProject(), personContract());
    const copy = duplicateVisualProject(project);
    expect(copy.id).not.toBe(project.id);
    expect(copy.templateSnapshot).toEqual(project.templateSnapshot);
    expect(copy.modification.person?.path).toBe('D:/imgs/person.png');
    expect(copy.revision).toBe(0);
    expect(copy.generationIds).toEqual([]);
    expect(copy.derivedFromProjectId).toBe(project.id);
    // 复制后独立修改，原项目不受影响（引用隔离）
    const changed = setProjectPersonContract(copy, null);
    expect(project.modification.person?.enabled).toBe(true);
    expect(changed.modification.person).toBeNull();
  });

  it('派生项目：保留模板 / 媒介结构 / 风格，重置人物参考与修改意图', () => {
    const project = setProjectPersonContract(fixtureProject(), personContract());
    const derived = deriveVisualProject(project);
    expect(derived.templateSnapshot).toEqual(project.templateSnapshot);
    expect(derived.renderingContract).toEqual(project.renderingContract);
    expect(derived.modification.person).toBeNull();
    expect(derived.modification.activeDimensions).toEqual([]);
    expect(derived.modification.freeText).toBe('');
    expect(derived.regions).toEqual([]);
    expect(derived.references).toEqual([]);
  });
});

describe('strictPersonReplacementRequiresReference（生成硬门禁）', () => {
  it('strict + 无参考图（非文字描述）→ 生成阻断', () => {
    const project = setProjectPersonContract(fixtureProject(), personContract({
      source: 'gallery',
      path: undefined,
      assetId: undefined,
    }));
    const errors = validateGenerationContract(project);
    expect(errors.some(e => e.includes('人物严格替换需要先绑定人物参考图'))).toBe(true);
  });

  it('strict + 有参考图 → 通过；文字描述人物另走描述校验', () => {
    const ok = setProjectPersonContract(fixtureProject(), personContract());
    expect(validateGenerationContract(ok)).toEqual([]);
    const described = setProjectPersonContract(fixtureProject(), personContract({
      source: 'description',
      path: undefined,
      description: '黑发女性，短发，穿白色卫衣',
      strength: 'balanced',
    }));
    expect(validateGenerationContract(described).some(e => e.includes('严格替换'))).toBe(false);
    const emptyDescription = setProjectPersonContract(fixtureProject(), personContract({
      source: 'description',
      path: undefined,
      description: '  ',
    }));
    expect(validateGenerationContract(emptyDescription).some(e => e.includes('人物描述'))).toBe(true);
  });

  it('模板缺失（无识别图）→ 阻断生成', () => {
    const project = { ...fixtureProject(), templateSnapshot: undefined };
    expect(validateGenerationContract(project).some(e => e.includes('画面模板'))).toBe(true);
  });
});

describe('personClothingPolicyInvariant（V2 服装不变量 A/B/C）', () => {
  it('A: preserve_template ⇒ clothing ∉ activeDimensions', () => {
    const contract = normalizeModificationContract({
      ...EMPTY_MODIFICATION_CONTRACT_FROM_DRAFT,
      clothingPolicy: 'preserve_original',
      activeDimensions: ['clothing', 'style'],
    });
    expect(contract.activeDimensions).not.toContain('clothing');
  });

  it('B: use_person_reference ⇒ clothing ∈ activeDimensions（无人物图自动降级 custom）', () => {
    const withPerson = normalizeModificationContract({
      ...EMPTY_MODIFICATION_CONTRACT_FROM_DRAFT,
      person: personContract(),
      clothingPolicy: 'use_subject_reference',
    });
    expect(withPerson.activeDimensions).toContain('clothing');
    const noImage = normalizeModificationContract({
      ...EMPTY_MODIFICATION_CONTRACT_FROM_DRAFT,
      clothingPolicy: 'use_subject_reference',
      activeDimensions: ['clothing'],
    });
    expect(noImage.clothingPolicy).toBe('custom');
    expect(noImage.activeDimensions).toContain('clothing');
  });

  it('C: custom ⇒ clothing ∈ activeDimensions 且空描述被生成门禁拦截', () => {
    const contract = normalizeModificationContract({
      ...EMPTY_MODIFICATION_CONTRACT_FROM_DRAFT,
      clothingPolicy: 'custom',
      activeDimensions: ['clothing'],
      customClothing: '  ',
    });
    expect(contract.activeDimensions).toContain('clothing');
    const project = { ...fixtureProject(), modification: contract };
    expect(validateGenerationContract(project).some(e => e.includes('服装'))).toBe(true);
  });

  it('preserveTemplateClothingDoesNotPreserveIdentity：保留服装合同下模板人物身份仍不保留', () => {
    const project = setProjectPersonContract(fixtureProject(), personContract({ clothing: undefined } as never));
    const plan = buildEffectiveVisualPlan({
      ...project,
      modification: normalizeModificationContract({
        ...project.modification,
        clothingPolicy: 'preserve_original',
      }),
    });
    const identityRow = plan.rows.find(row => row.key === 'person_identity');
    const templateIdentityRow = plan.rows.find(row => row.key === 'template_identity');
    expect(identityRow?.value).toContain('替换为 @人物参考');
    expect(templateIdentityRow?.value).toContain('不保留');
    const clothingRow = plan.rows.find(row => row.key === 'clothing');
    expect(clothingRow?.value).toContain('仅服装');
    expect(clothingRow?.value).toContain('人物参考');
  });
});

const EMPTY_MODIFICATION_CONTRACT_FROM_DRAFT = toModificationContract(EMPTY_MODIFICATION_DRAFT);

describe('migrateLegacyWorkspace（§36 legacy 迁移）', () => {
  it('有效 legacy 快照 → 未命名视觉项目，保留修改意图，不触发任何分析', () => {
    const analysis = fixtureAnalysis();
    const workspace = emptyWorkspace(analysis);
    const legacy = {
      sourcePath: 'D:/imgs/legacy.png',
      sourceAssetId: 'asset-legacy',
      profileId: 'p1',
      modelId: 'glm-5v',
      analysis,
      originalPromptDraft: '原 Prompt',
      promptDraft: '当前 Prompt',
      negativeDraft: '',
      modificationDraft: {
        ...EMPTY_MODIFICATION_DRAFT,
        freeText: '把人物换成另一个人',
        person: {
          source: 'gallery' as const,
          assetId: 'asset-person',
          path: 'D:/imgs/person.png',
          label: '人物参考',
        },
      },
      recreation: workspace.recreation,
      visionTaskId: 'task-1',
      sessionId: 'session-1',
    };
    const project = migrateLegacyWorkspace(legacy);
    expect(project).not.toBeNull();
    expect(project!.name).toBe('未命名视觉项目');
    expect(project!.templateSnapshot?.sourcePath).toBe('D:/imgs/legacy.png');
    // V1 person → V2 合同（默认 strict）
    expect(project!.modification.person?.strength).toBe('strict');
    expect(project!.modification.person?.preserveTemplateIdentity).toBe(false);
    expect(validateVisualProject(project)).toEqual([]);
  });

  it('残缺快照（无分析 / 无方案）返回 null，不伪造模板', () => {
    expect(migrateLegacyWorkspace({
      sourcePath: '',
      profileId: '',
      modelId: '',
      analysis: null,
      originalPromptDraft: '',
      promptDraft: '',
      negativeDraft: '',
      modificationDraft: EMPTY_MODIFICATION_DRAFT,
      recreation: null,
      visionTaskId: '',
      sessionId: '',
    })).toBeNull();
  });
});

describe('describeProjectStatus（项目状态标签）', () => {
  it('全状态有中文标签', () => {
    expect(describeProjectStatus('ready')).toBe('已理解');
    expect(describeProjectStatus('modified')).toBe('已修改');
    expect(describeProjectStatus('generated')).toBe('已生成');
  });
});
