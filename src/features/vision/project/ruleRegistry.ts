/**
 * Vision Plan Rule Registry（§C 规则中心）—— 视觉方案工作台「本页用了什么规则系统」
 * 的唯一注册表。
 *
 * 审计结论：本链路不存在独立 skill 体系，实际生效的是两层确定性 + 一层模型约束：
 *  1) Prompt Compiler（分层合同编译，零模型裁量）；
 *  2) 领域不变量（dimensionLock / 服装状态机 / 人物合同）；
 *  3) 优化器系统提示词规则包（规则 0–11 + 硬性合同块）。
 * 本注册表把这些规则以用户可理解的名称登记，Context Rail「方案规则」块按项目
 * 状态过滤展示——系统做了哪些约束不再是黑盒。
 */

import { buildDimensionContracts } from './dimensionLock';
import { personContractHasImage } from './personContract';
import type { VisualProject } from './types';

export interface VisionPlanRule {
  /** 稳定 id（测试锚点）。 */
  id: string;
  /** 规则名（用户可见；命名沿用项目术语）。 */
  name: string;
  /** 一句话说明（title tooltip 展示）。 */
  description: string;
}

/** 常驻规则（视觉方案工作台恒定生效）。 */
export const ALWAYS_ON_RULES: readonly VisionPlanRule[] = [
  {
    id: 'prompt_compiler',
    name: '视觉复刻 Prompt 编译器',
    description: '把图片角色 / 人物替换 / 区域 / 媒介 / 服装 / 维度 / 模板保留各层合同确定性编译进最终 Prompt，优化器输出只作为「最终画面描述」层进入。',
  },
  {
    id: 'template_lock',
    name: '模板锁定编译规则',
    description: '未启用修改的维度一律锁定：编译时直接复制模板基线，生成前结构化校验冲突即拦截。',
  },
  {
    id: 'locked_description_guard',
    name: '锁定维度正文守卫',
    description: '锁定维度的漂移描述在装配前被句级拦截并回退模板基线（动作锁定时分主体回退姿态基线），不依赖模型自觉。',
  },
  {
    id: 'clothing_invariant',
    name: '服装状态不变量',
    description: '「修改服装」与服装来源策略双向绑定：选原图服装自动取消修改维度，选人物 / 自定义服装自动启用，绝不出现矛盾状态。',
  },
  {
    id: 'optimizer_hard_contract',
    name: '优化器硬性合同',
    description: '人物是否替换 / 服装来源 / 区域 / 媒介结构 / 显式维度是已确认事实，优化器只能表达、不能重新决定。',
  },
];

/** 按项目状态启用的规则。 */
export function activeVisionPlanRules(project: VisualProject | null): VisionPlanRule[] {
  const rules: VisionPlanRule[] = [...ALWAYS_ON_RULES];
  if (!project) return rules;

  const person = project.modification.person?.enabled ? project.modification.person : null;
  if (person) {
    rules.push({
      id: 'person_contract',
      name: '人物替换合同',
      description: `身份主来源 = ${personContractHasImage(person) ? '人物参考图' : '文字描述'}；强度 / 替换范围 / 身份应用按合同执行，模板人物身份不保留。`,
    });
    if (personContractHasImage(person)) {
      rules.push({
        id: 'person_reference_isolation',
        name: '人物参考边界隔离',
        description: '人物参考图只供应身份（与按服装合同的服装）；其姿势、动作、身体朝向、观看角度、镜头、构图与背景一律不得采用，这些以画面模板为准。',
      });
    }
  }

  const poseContract = buildDimensionContracts(project).find(contract => contract.key === 'pose');
  if (poseContract?.mode === 'locked' && (project.templateSnapshot?.subjectPoses?.length ?? 0) > 0) {
    rules.push({
      id: 'per_subject_pose_lock',
      name: '动作分主体锁定',
      description: '未勾选「修改动作」时，真人主体与动漫 / 次要主体各自姿态按模板逐主体冻结，人物替换只改身份与服装，绝不连带改动作。',
    });
    const hasExpression = (project.templateSnapshot?.subjectPoses ?? [])
      .some(pose => pose.facialExpression?.trim());
    if (hasExpression) {
      rules.push({
        id: 'expression_lock',
        name: '表情独立锁定',
        description: '动作未修改时面部表情独立锁定（与姿态 / 手势 / 视线分列）：wink 类表情编译为强执行语义（一只眼完全闭合、另一只眼睁开有神、禁止半眯弱化），眼部 / 面部局部插图继承同一表情基线。',
      });
    }
  }

  if (project.renderingContract?.overallMode === 'mixed_media') {
    rules.push({
      id: 'mixed_media_structure',
      name: '混合媒介结构规则',
      description: '各媒介层保持各自媒介类型（真人层真人、动漫层动漫），禁止整图统一成单一媒介；风格修改只改各层的风格化表达。',
    });
    const hasMirrorInsert = project.renderingContract.regions
      .some(region => region.semanticRole === 'detail_insert' && (region.mirrors?.length ?? 0) > 0);
    if (hasMirrorInsert) {
      rules.push({
        id: 'detail_insert_binding',
        name: '局部插图同步规则',
        description: '模板中的局部特写插图与所属主体绑定同步：同一身份、发型与色调；眼部 / 面部特写额外继承同一表情（主动漫人物 wink ⇒ 插图同 wink），绝不画成另一个角色。',
      });
    }
  }

  if (project.modification.replicationBoost) {
    rules.push({
      id: 'replication_boost',
      name: '复刻度增强规则',
      description: '提高复刻度只作用于未开放修改的画面维度（构图 / 风格 / 氛围等从严保持），绝不作用于人物身份；取消后自动恢复上一版优化结果。',
    });
  }

  return rules;
}
