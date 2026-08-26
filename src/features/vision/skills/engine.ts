/**
 * Runtime Skill Engine（V4.2）—— Contract 系统的可解释执行层。
 *
 * 铁律：
 *  - 全部 executor 都是确定性纯函数，只读 VisualProject / 合同 / 模板快照，
 *    绝不调用 AI（真正需要模型的是 visual_analysis / prompt_optimization，
 *    它们只「登记」已发生的模型执行，不在这里发起调用）；
 *  - Skill 不造第二份业务状态：findings / constraints / contributions 全部
 *    从既有领域函数派生（dimensionLock / subjectExpression / personContract /
 *    promptCompiler），同一输入永远产出同一记录（幂等可重放）；
 *  - 硬约束（hardConstraints）与 DimensionLock 合同同源——skill 说「锁了」
 *    的每一个维度，都必须能在 buildDimensionContracts 里找到对应 locked。
 */

import type {
  GenerationImageReference,
  SkillCompiledSection,
  SkillConstraint,
  SkillExecutionRecord,
  SkillExecutionSnapshot,
  SkillFinding,
  SkillPromptContribution,
  SkillSuggestion,
  SkillUserDecision,
} from '../../../types';
import type { CompiledFinalPrompt } from '../project/promptCompiler';
import {
  compileClothingContract,
  compileFacialExpressionContract,
  compilePersonReplacementContract,
  compileRegionContract,
  compileRenderingContract,
} from '../project/promptCompiler';
import { buildDimensionContracts } from '../project/dimensionLock';
import { personContractHasImage, PERSON_REPLACE_SCOPE_LABELS, PERSON_STRENGTH_LABELS } from '../project/personContract';
import {
  bindDetailInsertsToCharacter,
  detailInsertAspectLabel,
  detailInsertCropLabel,
  resolveAnimeCharacter,
} from '../project/animeCharacter';
import { countInsertInstances } from '../project/detailInsert';
import {
  compileAnimeCharacterContract,
  compileDetailInsertSyncContract,
} from '../project/promptCompiler';
import { clothingSourceIsPersonReference } from '../project/clothingGuard';
import {
  isPoseDimensionLocked,
  lockedExpressionDirective,
  subjectsWithExpression,
} from '../project/subjectExpression';
import { RENDERING_MODE_LABELS } from '../project/rendering';
import { effectiveRuntimeSkills, runtimeSkillById, runtimeSkillExecutionOrder } from './registry';
import type { VisualProject } from '../project/types';

/** 编译器 section 名 → Prompt 块类型 + 归属技能（Prompt 来源反查的映射表）。 */
const SECTION_TO_BLOCK_AND_SKILLS: Record<string, { block: SkillPromptContribution['block']; skillIds: string[] }> = {
  image_role: { block: 'image_roles', skillIds: ['person_replacement', 'prompt_compilation'] },
  person_replacement: { block: 'person_contract', skillIds: ['person_replacement'] },
  region: { block: 'region_contract', skillIds: ['region_replacement'] },
  rendering: { block: 'media_contract', skillIds: ['hybrid_media_preservation', 'anime_character_consistency'] },
  anime_character: { block: 'anime_character_contract', skillIds: ['anime_character_consistency'] },
  detail_insert_sync: { block: 'detail_insert_contract', skillIds: ['detail_insert_sync'] },
  expression_lock: { block: 'expression_contract', skillIds: ['expression_preservation'] },
  clothing: { block: 'clothing_contract', skillIds: ['clothing_source'] },
  dimension: { block: 'dimension_contract', skillIds: ['prompt_compilation'] },
  template_preservation: { block: 'locked_template', skillIds: ['pose_preservation', 'composition_preservation', 'camera_preservation', 'prompt_compilation'] },
  final_description: { block: 'final_description', skillIds: ['prompt_compilation', 'prompt_optimization'] },
};

/** 优化器阶段输入（页面在优化完成时回填；确定性登记，不在这里调模型）。 */
export interface OptimizerStageInput {
  applied: boolean;
  triggeredBy: 'user' | 'auto';
  model?: { displayName?: string; modelId?: string; providerName?: string; source?: string };
  /** 进入优化请求的硬性合同行数。 */
  hardContractLineCount: number;
  /** 优化器越权改写被强制回退的维度（applyOptimizationResult 的 violations）。 */
  ignoredViolations?: string[];
  /** 优化模型回退信息（显式告知，不静默）。 */
  fallback?: { requestedModel: string; actualModel: string; reason?: string } | null;
  failedReason?: string;
}

export interface SkillExecutionInput {
  project: VisualProject;
  imageReferences: ReadonlyArray<GenerationImageReference>;
  disabledSkillIds?: ReadonlyArray<string>;
  optimizer?: OptimizerStageInput;
  /** 生成链路的编译产物（提供时冻结 compiledSections 进快照）。 */
  compiled?: CompiledFinalPrompt | null;
}

function recordBase(skillId: string, overrides: Partial<SkillExecutionRecord> & Pick<SkillExecutionRecord, 'status' | 'triggeredBy'>): SkillExecutionRecord {
  const definition = runtimeSkillById(skillId)!;
  const now = new Date().toISOString();
  return {
    executionId: `${skillId}-${now}`,
    skillId,
    skillName: definition.name,
    skillVersion: definition.version,
    category: definition.category,
    findings: [],
    suggestions: [],
    userDecisions: [],
    hardConstraints: [],
    appliedChanges: [],
    promptContributions: [],
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function skippedRecord(skillId: string, reason: string): SkillExecutionRecord {
  return recordBase(skillId, { status: 'skipped', triggeredBy: 'auto', skippedReason: reason });
}

/**
 * 派生决策的 decidedAt = 空串：这些「用户选择」是从项目合同状态确定性派生的
 * 事实（不是离散点击事件，没有事件时刻），非空时间戳会破坏
 * 「同一项目状态两次执行产出一致」的幂等可重放铁律。
 */
function accepted(suggestionId: string, decidedAt = ''): SkillUserDecision {
  return { suggestionId, decision: 'accepted', decidedAt };
}

// ===== 各技能 executor（确定性；同一项目状态 → 同一记录） =====

function executeVisualAnalysis(project: VisualProject): SkillExecutionRecord {
  const snapshot = project.templateSnapshot;
  if (!snapshot) return skippedRecord('visual_analysis', '尚无模板快照（未完成视觉识别）');
  const findings: SkillFinding[] = [{
    id: 'template-baseline',
    title: '已冻结模板九维度基线',
    description: `主体「${snapshot.subject.originalValue || '—'}」· 背景「${snapshot.background.originalValue || '—'}」· 风格「${snapshot.style.originalValue || '—'}」（重新分析前不可变）`,
    severity: 'info',
  }];
  const media = snapshot.mediaStructure;
  if (media?.overallMode === 'mixed_media') {
    findings.push({
      id: 'media-structure',
      title: '模板为混合媒介',
      description: `共 ${media.regions.length} 层：${media.regions.map(region => `${region.label}=${RENDERING_MODE_LABELS[region.renderingMode] ?? region.renderingMode}`).join('；')}`,
      severity: 'important',
      sourceDimension: 'style',
    });
  } else if (media?.singleMode && media.singleMode !== 'unknown') {
    findings.push({
      id: 'media-structure',
      title: '模板为单一媒介',
      description: RENDERING_MODE_LABELS[media.singleMode] ?? media.singleMode,
      sourceDimension: 'style',
    });
  }
  const poses = snapshot.subjectPoses ?? [];
  if (poses.length > 0) {
    findings.push({
      id: 'subject-poses',
      title: `已冻结 ${poses.length} 个主体的姿态基线`,
      description: poses.map(pose => `${pose.label}：${pose.poseDescription}`).join('；'),
      sourceDimension: 'pose',
    });
  }
  return recordBase('visual_analysis', {
    status: 'applied',
    triggeredBy: 'system',
    findings,
    appliedChanges: [{ target: 'templateSnapshot', description: '分析成功时刻冻结模板基线（Template = baseline）' }],
  });
}

function executePersonReplacement(project: VisualProject, imageReferences: ReadonlyArray<GenerationImageReference>): SkillExecutionRecord {
  const person = project.modification.person;
  if (!person?.enabled) return skippedRecord('person_replacement', '当前方案未启用人物替换');
  const hasImage = personContractHasImage(person);
  const label = person.source === 'description'
    ? (person.description?.trim() || '文字描述人物')
    : (person.label?.trim() || '人物参考图');
  const findings: SkillFinding[] = [hasImage
    ? {
      id: 'person-reference-bound',
      title: `绑定了人物参考 @${label}`,
      description: '人物参考图将作为主体人物身份的唯一主来源',
      severity: 'important',
      sourceDimension: 'subject',
      sourceAssetId: person.assetId,
    }
    : {
      id: 'person-description',
      title: '按文字描述重建人物',
      description: `描述：${label}`,
      sourceDimension: 'subject',
    }];
  const suggestions: SkillSuggestion[] = [{
    id: 'person-identity-source',
    title: hasImage ? '人物身份使用人物参考' : '人物身份按文字描述重建',
    description: '身份来源是用户已确认事实，优化器只能表达、不能重新决定',
    type: 'required',
    status: 'auto_applied',
    relatedDimensions: ['subject'],
  }];
  const userDecisions: SkillUserDecision[] = [
    accepted('person-identity-source'),
    {
      suggestionId: 'person-identity-source',
      decision: 'modified',
      decidedAt: '',
      modifiedValue: {
        strength: PERSON_STRENGTH_LABELS[person.strength],
        replaceScope: PERSON_REPLACE_SCOPE_LABELS[person.replaceScope],
      },
    },
  ];
  const constraints: SkillConstraint[] = [{
    dimension: 'subject',
    mode: 'forced',
    source: hasImage ? `@${label}` : '文字描述',
    reason: '模板人物身份不保留（人物替换合同 V2 类型级不变量）',
  }];
  const contributions: SkillPromptContribution[] = [
    {
      block: 'image_roles',
      summary: '图片角色指令：模板图 / 人物参考图各自职责 + 强制执行头',
    },
    {
      block: 'person_contract',
      summary: `人物替换合同（强度=${PERSON_STRENGTH_LABELS[person.strength]}；范围=${PERSON_REPLACE_SCOPE_LABELS[person.replaceScope]}）`,
      finalText: compilePersonReplacementContract({ person, imageReferences }),
    },
  ];
  return recordBase('person_replacement', {
    status: 'applied',
    triggeredBy: 'user',
    findings,
    suggestions,
    userDecisions,
    hardConstraints: constraints,
    appliedChanges: [{ target: 'modification.person', description: `人物替换合同（${PERSON_STRENGTH_LABELS[person.strength]}）生效` }],
    promptContributions: contributions,
  });
}

function executeClothingSource(project: VisualProject, imageReferences: ReadonlyArray<GenerationImageReference>): SkillExecutionRecord {
  const person = project.modification.person;
  const participates = !!person?.enabled || project.modification.activeDimensions.includes('clothing');
  if (!participates) return skippedRecord('clothing_source', '未启用人物替换且未修改服装（服装沿用模板）');
  const policy = project.modification.clothingPolicy;
  const policyText = policy === 'use_subject_reference'
    ? '服装来自人物参考图'
    : policy === 'custom'
      ? `自定义服装：${project.modification.customClothing.trim() || '（描述待填写）'}`
      : '服装沿用画面模板';
  return recordBase('clothing_source', {
    status: 'applied',
    triggeredBy: 'user',
    findings: [{ id: 'clothing-policy', title: policyText, description: '服装来源与「修改服装」维度双向绑定（A/B/C 不变量）', sourceDimension: 'clothing' }],
    suggestions: [{ id: 'clothing-policy-apply', title: policyText, description: '服装合同只约束服装本身，不代表保留模板人物', type: 'required', status: 'auto_applied', relatedDimensions: ['clothing'] }],
    userDecisions: [accepted('clothing-policy-apply')],
    hardConstraints: [{
      dimension: 'clothing',
      mode: 'forced',
      value: policyText,
      reason: '服装来源是用户已确认事实（优化器无权重定）',
    }],
    promptContributions: [{
      block: 'clothing_contract',
      summary: policyText,
      finalText: compileClothingContract({
        clothingPolicy: project.modification.clothingPolicy,
        customClothing: project.modification.customClothing,
        imageReferences,
      }),
    }],
  });
}

function poseConstraintLines(project: VisualProject): string {
  const poses = project.templateSnapshot?.subjectPoses ?? [];
  if (poses.length === 0) return '';
  return ['- 动作（分主体锁定——每个主体保持各自的模板姿态、手势、表情、视线与朝向，禁止统一改动）：',
    ...poses.map(pose => {
      const details = [
        pose.poseDescription,
        pose.gesture ? `手势：${pose.gesture}` : '',
        pose.gaze ? `视线：${pose.gaze}` : '',
        pose.bodyOrientation ? `朝向：${pose.bodyOrientation}` : '',
      ].filter(Boolean).join('；');
      return `  - ${pose.label}：${details}`;
    }),
  ].join('\n');
}

function executePosePreservation(project: VisualProject): SkillExecutionRecord {
  if (!isPoseDimensionLocked(project)) return skippedRecord('pose_preservation', '用户启用了「修改动作」（动作维度解锁）');
  const poses = project.templateSnapshot?.subjectPoses ?? [];
  const findings: SkillFinding[] = [{
    id: 'pose-unmodified',
    title: '用户没有修改动作',
    description: '未启用「修改动作」⇒ 姿态 / 手势 / 表情 / 视线 / 朝向整套锁定',
    severity: 'important',
    sourceDimension: 'pose',
  }];
  if (poses.length > 0) {
    findings.push({
      id: 'pose-per-subject',
      title: `模板动作基线（${poses.length} 个主体）`,
      description: poses.map(pose => `${pose.label}：${pose.poseDescription}${pose.bodyOrientation ? `（${pose.bodyOrientation}）` : ''}`).join('；'),
      sourceDimension: 'pose',
    });
  }
  const constraints: SkillConstraint[] = poses.map(pose => ({
    dimension: 'pose',
    mode: 'locked' as const,
    source: '@原图',
    value: pose.poseDescription,
    reason: `${pose.label} 的模板动作基线（用户未选择修改动作）`,
  }));
  if (poses.length === 0 && project.templateSnapshot) {
    constraints.push({
      dimension: 'pose',
      mode: 'locked',
      source: '@原图',
      value: project.templateSnapshot.action.originalValue,
      reason: '模板动作基线（用户未选择修改动作）',
    });
  }
  const poseText = poseConstraintLines(project);
  return recordBase('pose_preservation', {
    status: 'applied',
    triggeredBy: 'system',
    findings,
    suggestions: [{ id: 'pose-keep-template', title: '保持模板动作', description: '人物替换只改身份与服装，不连带改动作', type: 'required', status: 'auto_applied', relatedDimensions: ['pose'] }],
    hardConstraints: constraints,
    promptContributions: [{
      block: 'locked_template',
      summary: poses.length > 0 ? '动作（分主体锁定）进入模板保留合同' : '动作基线进入模板保留合同',
      ...(poseText ? { finalText: poseText } : {}),
    }],
  });
}

function executeExpressionPreservation(project: VisualProject): SkillExecutionRecord {
  if (!isPoseDimensionLocked(project)) return skippedRecord('expression_preservation', '用户启用了「修改动作」（表情随动作解锁）');
  const subjects = subjectsWithExpression(project);
  if (subjects.length === 0) return skippedRecord('expression_preservation', '模板主体没有可锁定的表情基线');
  const findings: SkillFinding[] = subjects.map(subject => ({
    id: `expression-${subject.id}`,
    title: `模板主体「${subject.label}」的表情基线：${subject.facialExpression}`,
    description: lockedExpressionDirective(subject),
    severity: 'important' as const,
    sourceDimension: 'facial_expression',
  }));
  return recordBase('expression_preservation', {
    status: 'applied',
    triggeredBy: 'system',
    findings,
    suggestions: [{ id: 'expression-keep', title: '锁定表情（禁止稀释）', description: 'wink 类表情编译为强执行语义，眼部 / 面部局部插图继承同一表情基线', type: 'required', status: 'auto_applied', relatedDimensions: ['facial_expression'] }],
    hardConstraints: subjects.map(subject => ({
      dimension: 'facial_expression',
      mode: 'locked' as const,
      source: '@原图',
      value: subject.facialExpression!,
      reason: `${subject.label} 的表情独立锁定（动作未修改 ⇒ 表情不漂移）`,
    })),
    promptContributions: [{
      block: 'expression_contract',
      summary: `${subjects.length} 个主体的表情锁定合同（置于风格描述之前）`,
      finalText: compileFacialExpressionContract(project),
    }],
  });
}

function executeDimensionPreservation(
  project: VisualProject,
  skillId: 'composition_preservation' | 'camera_preservation',
  dimensionKey: 'composition' | 'camera',
  dimensionLabel: string,
): SkillExecutionRecord {
  const contracts = buildDimensionContracts(project);
  const contract = contracts.find(item => item.key === dimensionKey);
  const baseline = project.templateSnapshot
    ? (dimensionKey === 'composition' ? project.templateSnapshot.composition.originalValue : project.templateSnapshot.camera.originalValue)
    : '';
  if (!project.templateSnapshot || contract?.mode !== 'locked') {
    return skippedRecord(skillId, `用户启用了「修改${dimensionLabel}」（维度解锁）`);
  }
  return recordBase(skillId, {
    status: 'applied',
    triggeredBy: 'system',
    findings: [{ id: `${dimensionKey}-baseline`, title: `${dimensionLabel}基线：${baseline || '（保持模板原样）'}`, description: `用户未修改${dimensionLabel} ⇒ 沿用模板基线`, sourceDimension: dimensionKey }],
    hardConstraints: [{
      dimension: dimensionKey,
      mode: 'locked',
      source: '@原图',
      value: baseline,
      reason: `模板${dimensionLabel}基线（Dimension Lock 合同）`,
    }],
    promptContributions: [{
      block: 'locked_template',
      summary: `${dimensionLabel}基线进入模板保留合同`,
      finalText: `- ${dimensionLabel}：${baseline || '（保持模板原样）'}`,
    }],
  });
}

function executeHybridMediaPreservation(project: VisualProject): SkillExecutionRecord {
  const rendering = project.renderingContract;
  if (rendering?.overallMode !== 'mixed_media') {
    return skippedRecord('hybrid_media_preservation', rendering?.overallMode === 'single_media'
      ? `模板为单一媒介（${rendering?.singleMode ? RENDERING_MODE_LABELS[rendering.singleMode] ?? rendering.singleMode : '未知'}），无需分层保持`
      : '尚无媒介结构分析');
  }
  const findings: SkillFinding[] = rendering.regions.map(region => ({
    id: `media-layer-${region.id}`,
    title: `媒介层「${region.label}」：${RENDERING_MODE_LABELS[region.renderingMode] ?? region.renderingMode}`,
    description: `身份关系：${region.identityRelation === 'same_as_primary' ? '与主体同一人物' : region.identityRelation === 'person_reference' ? '人物身份来自人物参考图' : region.identityRelation === 'template_identity' ? '沿用模板原身份设定' : '无特定身份约束'}`,
    sourceDimension: 'style',
  }));
  return recordBase('hybrid_media_preservation', {
    status: 'applied',
    triggeredBy: 'auto',
    findings,
    suggestions: [{ id: 'media-keep-layers', title: '保持模板媒介分层', description: '各媒介层保持各自媒介类型，风格修改只改各层的风格化表达', type: 'required', status: 'auto_applied', relatedDimensions: ['style'] }],
    hardConstraints: rendering.regions.map(region => ({
      dimension: `media:${region.label}`,
      mode: 'locked' as const,
      value: RENDERING_MODE_LABELS[region.renderingMode] ?? region.renderingMode,
      reason: '媒介结构是分析冻结事实（唯一统一入口 = 用户显式 applyUniformRenderingMode）',
    })),
    promptContributions: [{
      block: 'media_contract',
      summary: `混合媒介结构合同（${rendering.regions.length} 层各自保持媒介类型）`,
      finalText: compileRenderingContract({
        rendering,
        clothingFromPersonReference: clothingSourceIsPersonReference(project),
        animeCharacter: resolveAnimeCharacter(project),
      }),
    }],
  });
}

function executeAnimeCharacterConsistency(project: VisualProject): SkillExecutionRecord {
  const character = resolveAnimeCharacter(project);
  if (!character) {
    const rendering = project.renderingContract;
    return skippedRecord('anime_character_consistency', rendering?.overallMode === 'mixed_media'
      ? '混合媒介模板中没有动漫主体层（无需统一角色卡）'
      : '模板不是混合媒介（无动漫角色层，无需统一角色卡）');
  }
  // V5：实例口径计数（一个画框 = 一个 instance；Group 不再冒充 Instance）
  const counts = countInsertInstances(project.renderingContract);
  const sameIdentity = (project.renderingContract?.regions ?? []).some(region =>
    region.identityRelation === 'same_as_primary');
  const findings: SkillFinding[] = [
    {
      id: 'anime-subject-found',
      title: `模板包含动漫主主体「${character.sourceSubjectLabel}」`,
      description: 'Person Identity ≠ Anime Character Design：身份与角色设计分两步确定',
      severity: 'important',
      sourceDimension: 'style',
    },
    {
      id: 'anime-consistency-mode',
      title: `模式：${(project.animeConsistency?.mode ?? 'standard') === 'strict_visual_reference' ? 'Strict Visual Reference（强一致性）' : 'Standard（标准）'}`,
      description: (project.animeConsistency?.mode ?? 'standard') === 'strict_visual_reference'
        ? '已创建并复用「动漫角色参考图」；最终生成把该图作为独立参考图片提交，全部动漫区域以它为唯一视觉角色设计来源'
        : '单次生成（角色卡文本合同驱动）；多动漫头像 / 插图模板推荐开启强一致性',
      severity: (project.animeConsistency?.mode ?? 'standard') === 'strict_visual_reference' ? 'important' : 'info',
      sourceDimension: 'style',
    },
  ];
  if (character.identitySource.kind === 'person_reference') {
    findings.push({
      id: 'anime-identity-bound',
      title: `人物身份绑定 @${character.identitySource.label ?? '人物参考图'}`,
      description: '动漫主角色与真人主体属于同一人物身份（身份关系）；角色设计由身份参考 + 动漫媒介规则派生',
      severity: 'important',
      sourceDimension: 'subject',
      sourceAssetId: character.identitySource.assetId,
    });
  }
  // V5 Resolved Facts：角色事实行（发色 / 发长 / 卷度 / 分缝 / 刘海 / 脸型 / 眼型 / 瞳色）
  const hairFacts = character.hair.facts;
  const faceFacts = character.face.facts;
  if (hairFacts || faceFacts) {
    findings.push({
      id: 'anime-resolved-facts',
      title: '角色事实（已从人物参考解析）',
      description: [
        hairFacts
          ? `发色：${hairFacts.baseColor || '-'}；发长：${hairFacts.length}；卷度：${hairFacts.texture}；分缝：${hairFacts.parting}；刘海：${hairFacts.bangs}`
          : '',
        faceFacts
          ? `脸型：${faceFacts.shape || '-'}；眼型：${faceFacts.eyeShape || '-'}；瞳色：${faceFacts.irisColor || '-'}`
          : '',
      ].filter(Boolean).join('；'),
      severity: 'important',
      sourceDimension: 'subject',
    });
  } else if (character.identitySource.kind === 'person_reference') {
    findings.push({
      id: 'anime-facts-pending',
      title: '角色事实未解析',
      description: '人物参考外貌尚未解析（角色卡当前为来源指示语义）；解析后角色事实将逐项锁定',
      sourceDimension: 'subject',
    });
  }
  if (sameIdentity) {
    findings.push({
      id: 'anime-same-as-primary',
      title: '次要动漫主体与真人主体是同一人物身份',
      description: '同一身份 ≠ 允许各层独立动漫化——角色设计必须只有一套',
      sourceDimension: 'subject',
    });
  }
  if (counts.anime > 0) {
    findings.push({
      id: 'anime-inserts-found',
      title: `检测到 ${counts.anime} 个动漫局部插图（实例口径）`,
      description: counts.incompleteRegions.length > 0
        ? `其中「${counts.incompleteRegions.map(region => region.label).join('、')}」尚未逐个识别实例`
        : '全部相框 / 局部特写实例必须引用同一角色卡',
      severity: counts.incompleteRegions.length > 0 ? 'critical' : 'info',
      sourceDimension: 'style',
    });
  }
  const identityLabel = character.identitySource.kind === 'person_reference'
    ? `@${character.identitySource.label ?? '人物参考图'}`
    : character.identitySource.kind === 'manual'
      ? '文字描述'
      : '模板原身份';
  return recordBase('anime_character_consistency', {
    status: 'applied',
    triggeredBy: 'auto',
    findings,
    suggestions: [{
      id: 'anime-canonical-card',
      title: '建立唯一动漫角色卡，全部动漫层复用',
      description: `一个项目修订只有一个 Canonical Anime Character（当前 R${character.revision}）`,
      type: 'required',
      status: 'auto_applied',
      relatedDimensions: ['subject', 'style'],
    }],
    userDecisions: [accepted('anime-canonical-card')],
    hardConstraints: [
      {
        dimension: 'anime_character.id',
        mode: 'locked',
        value: character.id,
        source: identityLabel,
        reason: '唯一动漫角色设计实例（结构性不变量：单字段承载）',
      },
      { dimension: 'anime_character.hair', mode: 'locked', value: character.hair.description, source: identityLabel, reason: '发型 / 刘海 / 卷度 / 发色不得被任何动漫层改写' },
      { dimension: 'anime_character.face', mode: 'locked', value: character.face.description, source: identityLabel, reason: '脸型与五官结构不得被任何动漫层改写' },
      { dimension: 'anime_character.eyes', mode: 'locked', value: character.eyes.description, source: identityLabel, reason: '眼型与瞳色不得被任何动漫层改写' },
      {
        dimension: 'anime_character.clothing',
        mode: 'locked',
        value: character.clothing.canonicalDescription,
        source: character.clothing.source === 'person_reference'
          ? '@人物参考图（服装来源）'
          : character.clothing.source === 'custom' ? '自定义描述' : '@画面模板',
        reason: '服装基底统一读取 canonical 服装（各层不得自由决定）',
      },
      ...(character.expression.description
        ? [{ dimension: 'anime_character.expression', mode: 'locked' as const, value: character.expression.description, source: '@画面模板', reason: '动漫主体表情基线（模板冻结）' }]
        : []),
    ],
    appliedChanges: [{ target: 'animeCharacter', description: `冻结 Canonical Anime Character「${character.sourceSubjectLabel}」（R${character.revision}）` }],
    promptContributions: [{
      block: 'anime_character_contract',
      summary: '动漫角色一致性合同（唯一角色卡：发型 / 脸型 / 眼型 / 服装 / 表情逐项锁定 + 禁止独立动漫化）',
      finalText: compileAnimeCharacterContract(character),
    }],
  });
}

function executeDetailInsertSync(project: VisualProject): SkillExecutionRecord {
  const binding = bindDetailInsertsToCharacter(project);
  if (!binding) {
    return skippedRecord('detail_insert_sync', resolveAnimeCharacter(project)
      ? '混合媒介模板中没有动漫局部插图'
      : '无 Canonical Anime Character（模板不含动漫主体层）');
  }
  const { character, bindings } = binding;
  const animeBindings = bindings.filter(item => item.characterRef === character.id);
  const plainBindings = bindings.filter(item => item.characterRef !== character.id);
  const counts = countInsertInstances(project.renderingContract);
  const findings: SkillFinding[] = [{
    id: 'insert-count',
    title: `识别到 ${counts.total} 个局部插图（实例口径）`,
    description: `动漫角色插图：${counts.anime}；真人插图：${counts.photographic}；其它媒介：${counts.other}`,
    sourceDimension: 'style',
  }, {
    id: 'insert-instances',
    title: `插图实例清单（${bindings.length} 个）`,
    description: bindings.map((binding, index) =>
      `#${index + 1} ${binding.positionLabel ? `${binding.positionLabel} · ` : ''}${binding.insertLabel}（${detailInsertCropLabel(binding.cropType)}；${binding.characterRef === character.id ? '同步动漫主角色' : '镜像所属主体'}）`).join('；'),
    sourceDimension: 'style',
  }, {
    id: 'insert-sync-target',
    title: `同步 @动漫主角色：${animeBindings.length} / ${counts.anime}`,
    description: `角色设计来源 = Canonical Anime Character「${character.sourceSubjectLabel}」（不是真人主体的视觉设计，也不是各插图自行动漫化）${counts.incompleteRegions.length > 0 ? `；⚠ 有 ${counts.incompleteRegions.length} 个插图层尚未逐实例识别` : ''}`,
    severity: counts.incompleteRegions.length > 0 ? 'critical' : 'important',
    sourceDimension: 'style',
  }];
  return recordBase('detail_insert_sync', {
    status: 'applied',
    triggeredBy: 'auto',
    findings,
    suggestions: [{
      id: 'insert-bind-character',
      title: '全部动漫插图绑定同一角色卡',
      description: '锁定 hair / face / eyes / clothing / accessories；允许变化仅 crop（裁切 / 放大 / 框取）',
      type: 'required',
      status: 'auto_applied',
      relatedDimensions: ['style'],
    }],
    userDecisions: [accepted('insert-bind-character')],
    hardConstraints: bindings.map(binding => ({
      dimension: `detail_insert:${binding.insertLabel}`,
      mode: 'locked' as const,
      value: `characterRef=${binding.characterRef}`,
      source: `@动漫主角色「${character.sourceSubjectLabel}」`,
      reason: `锁定：${binding.lockedAspects.join('、')}；允许变化：${binding.allowedVariation.join('、')}`,
    })),
    appliedChanges: bindings.map(binding => ({
      target: `renderingContract.regions[${binding.groupId}].instances[${binding.instanceId}]`,
      description: `${binding.insertLabel} → ${binding.characterRef ? `characterRef=${binding.characterRef}` : '镜像所属主体'}（${detailInsertAspectLabel('identity')}同步）`,
    })),
    promptContributions: [{
      block: 'detail_insert_contract',
      summary: `细节插图同步合同（${animeBindings.length} 个动漫插图实例逐个引用动漫主角色${plainBindings.length > 0 ? `；${plainBindings.length} 个非动漫插图镜像所属主体` : ''}）`,
      finalText: compileDetailInsertSyncContract({
        bindings,
        character,
        subjectPoses: project.templateSnapshot?.subjectPoses ?? [],
      }),
    }],
  });
}

function executeRegionReplacement(project: VisualProject, disabled: boolean): SkillExecutionRecord {
  if (disabled) return skippedRecord('region_replacement', '已在技能中心停用（区域合同不编译进最终 Prompt）');
  const enabled = project.regions.filter(region => region.enabled);
  if (enabled.length === 0) return skippedRecord('region_replacement', '没有启用中的替换区域');
  return recordBase('region_replacement', {
    status: 'applied',
    triggeredBy: 'user',
    findings: enabled.map(region => ({
      id: `region-${region.id}`,
      title: `区域「${region.name}」（${enabled.length} 个启用中）`,
      description: `${region.shape.kind === 'rect' ? '矩形区域' : '画笔涂抹区域'}；区域外画面严格保持模板`,
      sourceDimension: 'region',
    })),
    suggestions: [{ id: 'region-apply', title: '按区域合同执行替换', description: '用途 / 替换对象 / 范围 / 约束以区域合同为准；mask 经 API 真实传输', type: 'required', status: 'auto_applied' }],
    hardConstraints: enabled.map(region => ({
      dimension: `region:${region.name}`,
      mode: 'forced' as const,
      value: region.prompt?.trim() || region.replaceType,
      reason: '区域替换是用户已确认事实（优化器无权取消任何区域）',
    })),
    promptContributions: [{
      block: 'region_contract',
      summary: `区域编辑合同（${enabled.length} 个区域）`,
      finalText: compileRegionContract({ regions: project.regions, references: project.references }),
    }],
  });
}

function executeReplicationBoost(project: VisualProject, disabled: boolean): SkillExecutionRecord {
  if (!project.modification.replicationBoost) return skippedRecord('replication_boost', '未启用「提高复刻度」');
  if (disabled) return skippedRecord('replication_boost', '已在技能中心停用（优化指令不含复刻增强条款）');
  return recordBase('replication_boost', {
    status: 'applied',
    triggeredBy: 'user',
    findings: [{ id: 'boost-on', title: '用户已开启「提高复刻度」', description: '未开放修改的画面维度（构图 / 风格 / 氛围等）从严保持', sourceDimension: 'composition' }],
    suggestions: [{ id: 'boost-scope', title: '复刻增强只作用于未开放维度', description: '绝不作用于人物身份；取消后自动恢复上一版优化结果', type: 'recommendation', status: 'accepted', relatedDimensions: ['composition', 'style'] }],
    userDecisions: [accepted('boost-scope')],
    hardConstraints: [{
      dimension: 'replication',
      mode: 'preserved',
      reason: '复刻度增强不作用于人物身份维度',
    }],
    promptContributions: [{
      block: 'final_description',
      summary: '复刻强度指令进入优化输入（未开放维度从严保持）',
    }],
  });
}

function executePromptOptimization(optimizer: OptimizerStageInput | undefined): SkillExecutionRecord {
  if (!optimizer) return skippedRecord('prompt_optimization', '本次未执行 Prompt 优化');
  const modelName = optimizer.model?.displayName || optimizer.model?.modelId || '未配置';
  const findings: SkillFinding[] = [{
    id: 'optimizer-model',
    title: `优化模型：${modelName}`,
    description: optimizer.model?.providerName ? `服务商：${optimizer.model.providerName}` : '优化器只负责把已确定合同表达成更好的生成语言',
  }];
  const suggestions: SkillSuggestion[] = [];
  const constraints: SkillConstraint[] = [];
  if (optimizer.hardContractLineCount > 0) {
    findings.push({
      id: 'hard-contract-lines',
      title: `${optimizer.hardContractLineCount} 行硬性合同随请求进入`,
      description: '人物决策 / 服装来源 / 维度 / 区域 / 媒介结构——优化器只能表达，不能重新决定',
      severity: 'important',
    });
    constraints.push({
      dimension: 'hard_contract',
      mode: 'forced',
      value: `${optimizer.hardContractLineCount} 行`,
      reason: 'HARD CONTRACT values are immutable（系统提示词规则 0）',
    });
  }
  if (optimizer.fallback) {
    findings.push({
      id: 'optimizer-fallback',
      title: `优化模型已回退：${optimizer.fallback.requestedModel} → ${optimizer.fallback.actualModel}`,
      description: optimizer.fallback.reason || '原因未知',
      severity: 'important',
    });
  }
  const violations = optimizer.ignoredViolations ?? [];
  if (violations.length > 0) {
    constraints.push({
      dimension: 'locked_dimensions',
      mode: 'locked',
      value: violations.join('、'),
      reason: '优化器越权改写锁定维度，已强制以模板基线为准（Dimension Lock §21）',
    });
  }
  suggestions.push({
    id: 'optimizer-expression-only',
    title: '只优化表达，不改合同',
    description: violations.length > 0
      ? `本次越权改动已被忽略（${violations.join('、')}）`
      : '优化产物只作为「最终画面描述」层进入编译',
    type: 'required',
    status: 'auto_applied',
  });
  return recordBase('prompt_optimization', {
    status: optimizer.applied ? 'applied' : (optimizer.failedReason ? 'failed' : 'skipped'),
    triggeredBy: optimizer.triggeredBy,
    findings,
    suggestions,
    hardConstraints: constraints,
    ...(optimizer.failedReason ? { skippedReason: optimizer.failedReason } : {}),
    promptContributions: optimizer.applied ? [{
      block: 'final_description',
      summary: '优化产物作为「最终画面描述」层进入（置于全部合同块之后）',
    }] : [],
  });
}

function executePromptCompilation(input: SkillExecutionInput): SkillExecutionRecord {
  const sectionCount = input.compiled?.sections.length ?? 0;
  const findings: SkillFinding[] = input.compiled
    ? [{ id: 'compiled-sections', title: `分层编译 ${sectionCount} 个合同块`, description: `装配顺序：${input.compiled.sections.join(' → ')}` }]
    : [{ id: 'compile-pending', title: '编译在生成时刻执行', description: '最终 Prompt = 全部合同块 + 最终画面描述（零模型裁量）' }];
  if (input.compiled?.lockGuard && input.compiled.lockGuard.removedSentences.length > 0) {
    findings.push({
      id: 'lock-guard',
      title: `锁定维度正文守卫拦截 ${input.compiled.lockGuard.removedSentences.length} 处漂移描述`,
      description: `维度：${input.compiled.lockGuard.guardedDimensions.join('、')}；动作基线已回退进最终画面描述`,
      severity: 'important',
    });
  }
  return recordBase('prompt_compilation', {
    status: 'applied',
    triggeredBy: 'system',
    findings,
    appliedChanges: [{ target: 'finalPrompt', description: '合同块置于优化产物之前，优化器输出无权覆盖' }],
    promptContributions: [
      { block: 'image_roles', summary: '图片角色合同（模板图 / 人物参考图职责）' },
      { block: 'final_description', summary: '最终画面描述只承载修改项（锁定维度以模板保留合同为准）' },
    ],
  });
}

function executeContractValidation(project: VisualProject): SkillExecutionRecord {
  const contracts = buildDimensionContracts(project);
  const locked = contracts.filter(contract => contract.mode === 'locked');
  const findings: SkillFinding[] = [{
    id: 'lock-summary',
    title: `${locked.length} 个维度处于锁定态`,
    description: locked.length > 0 ? locked.map(contract => `${contract.key}（基线已冻结）`).join('、') : '全部维度开放修改',
  }];
  const violations = project.workspace.recreation?.plan.fields ?? [];
  const drifted = locked.filter(contract => {
    const field = violations.find(item => item.key === contract.key);
    return !!field?.value.trim() && field.value.trim() !== contract.baseline.trim();
  });
  if (drifted.length > 0) {
    findings.push({
      id: 'lock-violation',
      title: `锁定维度与方案冲突：${drifted.map(contract => contract.key).join('、')}`,
      description: '生成前结构化校验将阻断（绝不静默放行）',
      severity: 'critical',
    });
  }
  return recordBase('contract_validation', {
    status: 'applied',
    triggeredBy: 'system',
    findings,
    hardConstraints: locked.map(contract => ({
      dimension: contract.key,
      mode: 'locked' as const,
      value: contract.baseline,
      reason: 'Dimension Lock 合同（LOCKED = 唯一合法值 = 模板基线）',
    })),
  });
}

// ===== 引擎入口 =====

/**
 * 执行全部内置技能（确定性；同一项目状态 + 同一输入 → 同一记录集）。
 * 执行顺序 = runtimeSkillExecutionOrder()（priority 派生，绝不依赖对象遍历顺序；
 * 依赖链 anime_character_consistency → detail_insert_sync → prompt_compilation
 * 由注册表 priority 保证，注册表测试守护拓扑）。
 * disabledSkillIds 只能停用 canDisable 的技能；核心技能恒执行。
 */
export function executeRuntimeSkills(input: SkillExecutionInput): SkillExecutionRecord[] {
  const disabled = new Set(input.disabledSkillIds ?? []);
  effectiveRuntimeSkills([...disabled]); // 归一化：核心技能即使在 disabled 里也不停
  const isDisabled = (id: string) => {
    const definition = runtimeSkillById(id);
    return !!definition?.canDisable && disabled.has(id);
  };
  const executors: Record<string, () => SkillExecutionRecord> = {
    visual_analysis: () => executeVisualAnalysis(input.project),
    person_replacement: () => executePersonReplacement(input.project, input.imageReferences),
    clothing_source: () => executeClothingSource(input.project, input.imageReferences),
    pose_preservation: () => executePosePreservation(input.project),
    expression_preservation: () => executeExpressionPreservation(input.project),
    composition_preservation: () => executeDimensionPreservation(input.project, 'composition_preservation', 'composition', '构图'),
    camera_preservation: () => executeDimensionPreservation(input.project, 'camera_preservation', 'camera', '镜头'),
    hybrid_media_preservation: () => executeHybridMediaPreservation(input.project),
    anime_character_consistency: () => executeAnimeCharacterConsistency(input.project),
    detail_insert_sync: () => executeDetailInsertSync(input.project),
    region_replacement: () => executeRegionReplacement(input.project, isDisabled('region_replacement')),
    replication_boost: () => executeReplicationBoost(input.project, isDisabled('replication_boost')),
    prompt_optimization: () => executePromptOptimization(input.optimizer),
    prompt_compilation: () => executePromptCompilation(input),
    contract_validation: () => executeContractValidation(input.project),
  };
  return runtimeSkillExecutionOrder()
    .filter(skill => executors[skill.id])
    .map(skill => executors[skill.id]!());
}

/** 编译产物 → 分段归属（Prompt 来源反查；region 停用时编译器已不含该块）。 */
export function compiledSectionsOf(compiled: CompiledFinalPrompt): SkillCompiledSection[] {
  const blocks: Array<{ name: string; text: string }> = (compiled as CompiledFinalPrompt & {
    sectionBlocks?: Array<{ name: string; text: string }>;
  }).sectionBlocks ?? [];
  return blocks
    .map(block => {
      const mapping = SECTION_TO_BLOCK_AND_SKILLS[block.name];
      if (!mapping) return null;
      return { block: mapping.block, skillIds: mapping.skillIds, text: block.text };
    })
    .filter((value): value is SkillCompiledSection => value !== null);
}

/** 构建技能执行快照（优化完成 / 生成时刻冻结）。 */
export function buildSkillExecutionSnapshot(input: SkillExecutionInput): SkillExecutionSnapshot {
  return {
    schemaVersion: 1,
    projectId: input.project.id,
    projectRevision: input.project.revision,
    ...(input.project.optimizedRevision !== undefined ? { optimizationRevision: input.project.optimizedRevision } : {}),
    skills: executeRuntimeSkills(input),
    ...(input.compiled ? { compiledSections: compiledSectionsOf(input.compiled) } : {}),
    createdAt: new Date().toISOString(),
  };
}
