/**
 * 生成溯源快照（GenerationProvenanceSnapshot，V4.0.9）：
 * 「确认生成图片」时冻结用户原话 / 修改方案 / 参考图角色 / 服装策略 / 模型记录，
 * 随 Task 落库；三层 Provenance（用户要求 / 修改方案 / 最终 Prompt）严禁混淆。
 */

import { describe, expect, it } from 'vitest';
import {
  buildGenerationProvenance,
  describeClothingPolicy,
  describeExecutionRules,
  describeProvenanceModificationPlan,
  PROVENANCE_ROLE_LABELS,
  renderUserInstruction,
  resolveGenerationImageReferences,
} from '../generationProvenance';
import {
  EMPTY_MODIFICATION_DRAFT,
  type ModificationDraft,
} from '../modificationIntent';
import { buildGenerationCarry, initialRecreationState, type RecreationState } from '../recreationPlan';

function makeRecreation(): RecreationState {
  const state = initialRecreationState(
    {
      summary: '一名男性篮球运动员在室内球馆上篮',
      fields: [
        { key: 'subject', label: '人物 / 主体', value: '男性篮球运动员', locked: false, lockSource: 'intent' },
        { key: 'clothing', label: '服装 / 造型', value: '蓝色球衣', locked: false, lockSource: 'intent' },
        { key: 'pose', label: '动作', value: '双手比心', locked: false, lockSource: 'intent' },
        { key: 'composition', label: '构图', value: '居中', locked: true, lockSource: 'default' },
        { key: 'camera', label: '镜头', value: '低角度', locked: true, lockSource: 'default' },
        { key: 'scene', label: '背景 / 场景', value: '室内球馆', locked: true, lockSource: 'default' },
        { key: 'lighting', label: '光线', value: '顶光', locked: true, lockSource: 'default' },
        { key: 'style', label: '风格', value: '动漫AI照片风', locked: true, lockSource: 'default' },
        { key: 'color', label: '色彩', value: '高饱和', locked: true, lockSource: 'default' },
      ],
    },
    '原始复刻 Prompt',
    '低画质',
  );
  return { ...state, optimizerModelId: 'glm-5v-turbo', modelName: 'GLM-5V-Turbo', providerName: '智谱', optimizerSource: 'follow' };
}

function makeDraft(patch: Partial<ModificationDraft>): ModificationDraft {
  return { ...EMPTY_MODIFICATION_DRAFT, ...patch };
}

describe('renderUserInstruction（@token → @label 人类可读）', () => {
  it('内部 token / 超长文件名解析为完整 label', () => {
    const text = '保留 @a142c6f462.p… 的风格，人物换成 @人物参考';
    const mentions = [
      { id: 'm1', path: 'D:/imgs/a142c6f462.png', label: 'a142c6f462.png', token: 'a142c6f462.p…', role: 'source_reference' as const },
      { id: 'm2', path: 'D:/imgs/person.png', label: '人物参考', token: '人物参考', role: 'person_replacement_reference' as const },
    ];
    const display = renderUserInstruction(text, mentions);
    expect(display).toBe('保留 @a142c6f462.png 的风格，人物换成 @人物参考');
    // 原文 token 不出现在展示层
    expect(display).not.toContain('@a142c6f462.p…');
  });

  it('无绑定时原文返回', () => {
    expect(renderUserInstruction('把背景换成夜景', [])).toBe('把背景换成夜景');
  });
});

describe('buildGenerationProvenance（快照冻结）', () => {
  const draft = makeDraft({
    freeText: '保留 @原图 的动漫AI照片风，人物换成 @人物参考，同时修改动作和背景。',
    activeDimensions: ['subject', 'pose', 'scene', 'clothing'],
    person: { source: 'gallery', assetId: 'asset-person', path: 'D:/imgs/person.png', label: '人物参考' },
    clothingPolicy: 'use_subject_reference',
    mentions: [
      { id: 'm1', path: 'D:/imgs/ref.png', label: '原图', token: '原图', role: 'source_reference' as const },
      { id: 'm2', path: 'D:/imgs/person.png', label: '人物参考', token: '人物参考', role: 'person_replacement_reference' as const },
    ],
  });

  it('冻结用户原话（人类可读版 + 底层原文 + 绑定表）', () => {
    const snapshot = buildGenerationProvenance({
      draft,
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
      sourceAssetId: 'asset-ref',
    });
    expect(snapshot.feature).toBe('vision_recreation');
    expect(snapshot.userInstruction).toBe('保留 @原图 的动漫AI照片风，人物换成 @人物参考，同时修改动作和背景。');
    expect(snapshot.userInstructionRaw).toBe(draft.freeText.trim());
    expect(snapshot.mentionBindings).toHaveLength(2);
    expect(snapshot.mentionBindings![0]).toMatchObject({ token: '原图', label: '原图', path: 'D:/imgs/ref.png' });
  });

  it('userInstruction 绝不是最终 Prompt / 优化产物（无 freeText 时缺省而非伪造）', () => {
    const snapshot = buildGenerationProvenance({
      draft: makeDraft({}),
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
    });
    expect(snapshot.userInstruction).toBeUndefined();
    expect(snapshot.userInstructionRaw).toBeUndefined();
  });

  it('imageRoles：模板 → 人物 → @引用，同路径去重且带 assetId', () => {
    const snapshot = buildGenerationProvenance({
      draft,
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
      sourceAssetId: 'asset-ref',
    });
    const roles = snapshot.imageRoles!;
    expect(roles).toHaveLength(2); // person 与 @人物参考同路径去重
    expect(roles[0]).toMatchObject({ role: 'template', label: '原图', assetId: 'asset-ref', path: 'D:/imgs/ref.png' });
    expect(roles[1]).toMatchObject({ role: 'person_reference', label: '人物参考', assetId: 'asset-person' });
  });

  it('modificationIntent 冻结维度 / 人物 / 服装策略 / AI 判定修改维度', () => {
    const snapshot = buildGenerationProvenance({
      draft,
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
    });
    const intent = snapshot.modificationIntent!;
    expect(intent.activeDimensions).toEqual(['subject', 'pose', 'scene', 'clothing']);
    // AI 判定（lockSource=intent 且未锁定）：subject / clothing / pose
    expect(intent.changedDimensions).toEqual(['subject', 'clothing', 'pose']);
    expect(intent.personReplacement).toMatchObject({ enabled: true, source: 'gallery', hasReferenceImage: true });
    expect(intent.clothingPolicy).toBe('use_subject_reference');
  });

  it('models 全部来自生成时刻输入，不读当前 Settings', () => {
    const snapshot = buildGenerationProvenance({
      draft,
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
      visionModel: { modelId: 'glm-5v-turbo', displayName: 'GLM-5V-Turbo', providerName: '智谱' },
      optimizerModel: { modelId: 'glm-5v-turbo', displayName: 'GLM-5V-Turbo', providerName: '智谱', source: 'follow' },
      evaluationModel: { modelId: 'glm-5v-turbo', displayName: 'GLM-5V-Turbo', providerName: '智谱' },
    });
    expect(snapshot.models?.visionAnalysis?.displayName).toBe('GLM-5V-Turbo');
    expect(snapshot.models?.promptOptimizer?.displayName).toBe('GLM-5V-Turbo');
    expect(snapshot.models?.imageGeneration?.modelId).toBe('gpt-image-2');
    expect(snapshot.models?.imageEvaluation?.displayName).toBe('GLM-5V-Turbo');
  });

  it('快照随 buildGenerationCarry 完整进入携带草稿', () => {
    const snapshot = buildGenerationProvenance({
      draft,
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
    });
    const carry = buildGenerationCarry(makeRecreation(), {
      sourceVisionTaskId: 'task-7',
      provenance: snapshot,
    });
    expect(carry.provenance).toEqual(snapshot);
    expect(carry.taskPlanSummary).toContain('基于视觉理解复刻方案');
  });
});

describe('describeProvenanceModificationPlan（历史「本次修改方案」行）', () => {
  it('人物替换 / 修改维度 / 服装来源 / 沿用模板逐行结构化', () => {
    const snapshot = buildGenerationProvenance({
      draft: makeDraft({
        freeText: '改一改',
        activeDimensions: ['subject', 'pose', 'scene', 'clothing'],
        person: { source: 'gallery', assetId: 'asset-person', path: 'D:/imgs/person.png', label: '人物参考' },
        clothingPolicy: 'use_subject_reference',
      }),
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
    });
    const rows = describeProvenanceModificationPlan(snapshot);
    const byLabel = Object.fromEntries(rows.map(row => [row.label, row.value]));
    expect(byLabel['人物']).toBe('替换为 @人物参考（身份 / 五官 / 发型以人物参考为准）');
    expect(byLabel['模板人物身份']).toBe('不保留（仅保留画面模板 / 风格 / 构图）');
    expect(byLabel['动作']).toBe('修改');
    expect(byLabel['背景']).toBe('修改');
    expect(byLabel['服装']).toBe('使用人物参考服装');
    expect(byLabel['风格']).toBe('沿用 @原图');
    expect(byLabel['构图']).toBe('沿用 @原图');
  });

  it('无 modificationIntent（旧任务语义）返回空，不凭 Prompt 反推', () => {
    expect(describeProvenanceModificationPlan({ schemaVersion: 1, feature: 'vision_recreation' })).toEqual([]);
  });

  it('服装策略三态描述', () => {
    expect(describeClothingPolicy('preserve_original')).toBe('保留原图服装');
    expect(describeClothingPolicy('use_subject_reference')).toBe('使用人物参考服装');
    expect(describeClothingPolicy('custom', '红色晚礼服')).toBe('自定义：红色晚礼服');
    expect(describeClothingPolicy('custom')).toBe('自定义服装（未填写描述）');
  });

  it('参考图角色标签固定', () => {
    expect(PROVENANCE_ROLE_LABELS.template).toBe('画面模板');
    expect(PROVENANCE_ROLE_LABELS.person_reference).toBe('人物参考');
    expect(PROVENANCE_ROLE_LABELS.background_reference).toBe('背景参考');
    expect(PROVENANCE_ROLE_LABELS.style_reference).toBe('风格参考');
    expect(PROVENANCE_ROLE_LABELS.generic_reference).toBe('参考图');
  });
});

// ===== V4.0.9.1 人物强替换：参考图唯一解析器 + 快照人物字段 + 执行规则 =====

describe('resolveGenerationImageReferences（顺序 = 提交顺序的唯一解析器）', () => {
  it('面板人物图：模板 → 人物，路径不同两张都存活（dedupe 不误删人物图）', () => {
    const refs = resolveGenerationImageReferences({
      draft: makeDraft({
        person: { source: 'gallery', assetId: 'a-p', path: 'D:/imgs/person.png', label: '人物参考' },
      }),
      sourcePath: 'D:/imgs/ref.png',
      sourceAssetId: 'a-t',
    });
    expect(refs.map(ref => ref.role)).toEqual(['template', 'person_reference']);
    expect(refs[0]).toMatchObject({ path: 'D:/imgs/ref.png', assetId: 'a-t', label: '原图' });
    expect(refs[1]).toMatchObject({ path: 'D:/imgs/person.png', assetId: 'a-p' });
  });

  it('面板为空但 @mention 提供人物图 → 人物位由 mention 补上（不再丢失）', () => {
    const refs = resolveGenerationImageReferences({
      draft: makeDraft({}),
      sourcePath: 'D:/imgs/ref.png',
      personMention: { path: 'D:/imgs/person.png', assetId: 'a-m', label: '图三' },
    });
    expect(refs.map(ref => ref.role)).toEqual(['template', 'person_reference']);
    expect(refs[1]).toMatchObject({ path: 'D:/imgs/person.png', assetId: 'a-m', label: '图三' });
  });

  it('面板人物优先于 mention 人物（panel > mention，绝不双人物）', () => {
    const refs = resolveGenerationImageReferences({
      draft: makeDraft({
        person: { source: 'local', path: 'D:/imgs/panel-person.png' },
      }),
      sourcePath: 'D:/imgs/ref.png',
      personMention: { path: 'D:/imgs/mention-person.png' },
    });
    const personRefs = refs.filter(ref => ref.role === 'person_reference');
    expect(personRefs).toHaveLength(1);
    expect(personRefs[0].path).toBe('D:/imgs/panel-person.png');
  });

  it('其余 @mention 附加在尾部（image[2...]）；生成结果引用不进入生成参考图', () => {
    const refs = resolveGenerationImageReferences({
      draft: makeDraft({
        freeText: '参考 @街景 的背景',
        mentions: [
          { id: 'm1', path: 'D:/imgs/street.png', label: '街景', token: '街景', role: 'background_reference' as const },
          { id: 'm2', path: 'D:/imgs/gen-1.png', label: '生成结果 1', token: '生成结果1', role: 'generated_result_reference' as const },
        ],
      }),
      sourcePath: 'D:/imgs/ref.png',
    });
    expect(refs.map(ref => ref.role)).toEqual(['template', 'background_reference']);
    expect(refs[1].path).toBe('D:/imgs/street.png');
  });

  it('与模板同路径的 mention 去重（同一张图绝不出现两次）', () => {
    const refs = resolveGenerationImageReferences({
      draft: makeDraft({
        freeText: '照着 @原图 风格',
        mentions: [
          { id: 'm1', path: 'D:\\imgs\\REF.png', label: '原图', token: '原图', role: 'template_reference' as const },
        ],
      }),
      sourcePath: 'D:/imgs/ref.png',
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].role).toBe('template');
  });
});

describe('personReplacement 快照字段（V4.0.9.1）', () => {
  it('携带参考图 → strict_identity_replace + path / assetId 冻结', () => {
    const snapshot = buildGenerationProvenance({
      draft: makeDraft({
        person: { source: 'gallery', assetId: 'a-p', path: 'D:/imgs/person.png', label: '人物参考' },
      }),
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
    });
    expect(snapshot.modificationIntent!.personReplacement).toMatchObject({
      enabled: true,
      hasReferenceImage: true,
      replacementMode: 'strict_identity_replace',
      personReferencePath: 'D:/imgs/person.png',
      personReferenceAssetId: 'a-p',
    });
  });

  it('mention 人物（面板为空）→ 同样按强替换冻结', () => {
    const snapshot = buildGenerationProvenance({
      draft: makeDraft({}),
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
      personMention: { path: 'D:/imgs/person.png', assetId: 'a-m', label: '图三' },
    });
    expect(snapshot.modificationIntent!.personReplacement).toMatchObject({
      enabled: true,
      hasReferenceImage: true,
      replacementMode: 'strict_identity_replace',
      personReferencePath: 'D:/imgs/person.png',
      personReferenceAssetId: 'a-m',
    });
  });

  it('文字描述人物（无图）→ description_replace，不伪造 path', () => {
    const snapshot = buildGenerationProvenance({
      draft: makeDraft({
        person: { source: 'description', description: '黑长发的年轻女性' },
      }),
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
    });
    expect(snapshot.modificationIntent!.personReplacement).toMatchObject({
      enabled: true,
      hasReferenceImage: false,
      replacementMode: 'description_replace',
    });
    expect(snapshot.modificationIntent!.personReplacement!.personReferencePath).toBeUndefined();
  });

  it('传入 imageReferences 时快照与其同源同序（快照 = payload 事实）', () => {
    const snapshot = buildGenerationProvenance({
      draft: makeDraft({}),
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
      imageReferences: [
        { path: 'D:/t.png', label: '原图', role: 'template' },
        { path: 'D:/p.png', label: '人物参考', role: 'person_reference' },
        { path: 'D:/b.png', label: '街景', role: 'background_reference' },
      ],
    });
    expect(snapshot.imageRoles!.map(ref => [ref.path, ref.role])).toEqual([
      ['D:/t.png', 'template'],
      ['D:/p.png', 'person_reference'],
      ['D:/b.png', 'background_reference'],
    ]);
  });
});

describe('describeExecutionRules（History 执行规则摘要，只读快照）', () => {
  it('强替换：人物身份来源 / 模板人物不保留 / 服装 / 各维度逐行速览', () => {
    const snapshot = buildGenerationProvenance({
      draft: makeDraft({
        activeDimensions: ['subject', 'pose', 'scene'],
        person: { source: 'gallery', assetId: 'a-p', path: 'D:/imgs/person.png', label: '人物参考' },
        clothingPolicy: 'preserve_original',
        replicationBoost: true,
      }),
      recreation: makeRecreation(),
      sourcePath: 'D:/imgs/ref.png',
    });
    const rules = describeExecutionRules(snapshot);
    expect(rules).toContain('人物身份：@人物参考（人物参考图）');
    expect(rules).toContain('模板人物身份：不保留');
    expect(rules).toContain('服装：保留原图服装');
    expect(rules).toContain('动作：修改');
    expect(rules).toContain('背景：修改');
    expect(rules).toContain('风格：沿用 @原图');
    expect(rules).toContain('复刻度：提高（不作用于人物身份）');
  });

  it('historyDoesNotInferPersonRoleFromImageOrder：旧快照（无 imageRoles / 无 intent）不产出任何角色推断', () => {
    const rules = describeExecutionRules({ schemaVersion: 1, feature: 'vision_recreation' });
    expect(rules).toEqual([]);
    // 旧任务详情回落「参考图 N」编号展示，不猜角色（页面 fallback 由源码守卫测试锚定）
  });
});
