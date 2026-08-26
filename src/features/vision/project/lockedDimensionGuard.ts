/**
 * Locked Dimension Guard（Dimension Lock §20 正文层）—— 最终画面描述的
 * 确定性拦截与基线回退。
 *
 * 背景（GUI 验收确认的根因）：结构化清洗（enforceOptimizerDimensionLocks）与
 * 生成前校验（validateDimensionLockContract）都只作用于结构化字段，
 * 【最终画面描述】正文从不被检查——优化器重写整图描述时天然会发明新的
 * 动作 / 手势 / 朝向 / 机位（尤其人物参考图姿态经由身份 / 服装描述连带进入），
 * 而该段位于最终 Prompt 末尾、对 gpt-image-2 显著性最高，直接压过模板保留合同。
 *
 * 本模块在 Compiler 装配前对描述正文做句级守卫（零模型裁量）：
 *  - 维度 locked 时，含「该维度信号词且模板基线没有该词」的句子 → 拦截删除；
 *  - 信号词在模板基线中出现（如基线本来就是「蹲姿」「平视」）→ 视为忠实描述，保留；
 *  - 动作锁定且存在逐主体姿态快照 → 段末回退追加模板动作基线（唯一事实来源），
 *    满足「未勾选修改动作 ⇒ 生成结果动作严格沿用模板」的结构化落地。
 *
 * 词表刻意保守：只覆盖姿态 / 手势 / 朝向 / 视线 / 面部表情与镜头语言，不碰空间位置词
 * （描述替换对象需要「左侧 / 右下」类语言；构图由模板保留合同承载）。
 * 表情信号词（眨眼 / 闭眼 / 眯眼 / 微笑…）同样走「基线含词豁免」：
 * 模板基线本来是 wink ⇒ 描述里的 wink 忠实保留，改写成微笑 / 双眼睁开则被拦截。
 */

import { buildDimensionContracts } from './dimensionLock';
import type { VisualProject } from './types';

/** 姿态 / 手势 / 朝向 / 视线信号词（句中命中且模板基线未含 ⇒ 视为动作漂移）。 */
const POSE_SIGNALS: readonly string[] = [
  // 基础体态
  '站姿', '站立', '站起', '站直', '起身', '直立', '笔直',
  '蹲姿', '半蹲', '蹲下', '蹲坐', '深蹲',
  '坐姿', '坐下', '坐着', '席地而坐', '端坐',
  '跪姿', '跪坐', '跪地', '下跪', '单膝跪',
  '平躺', '侧躺', '仰卧', '俯卧', '趴着', '躺下', '卧倒',
  // 移动
  '奔跑', '跑动', '冲刺', '行走', '走动', '迈步', '踱步', '漫步', '散步',
  '跳跃', '跳起', '起跳', '单脚跳', '腾空', '跃起', '空翻', '侧手翻',
  '旋转', '转圈', '舞动', '跳舞', '舞蹈', '摇摆', '摆动',
  // 手臂 / 手势
  '举手', '抬手', '伸手', '挥手', '摊手', '张手',
  '比V', 'V字', 'V手势', '剪刀手', '比心', '爱心手势',
  '叉腰', '抱臂', '抱胸', '交叉双臂', '双手交叉',
  '捂嘴', '托腮', '撑脸', '掩面', '扶额',
  '张开双臂', '展开双臂', '张开手臂', '双臂张开', '双臂展开', '张开', '展开',
  '盘腿', '翘腿', '交叉双腿', '弓步', '马步', '单腿', '重心',
  '抱住', '搂住', '牵手', '挽着手',
  // 头部 / 朝向 / 视线
  '低头', '抬头', '仰头', '歪头', '侧头', '回头',
  '侧身', '转身', '背对', '面向', '朝向', '身体前倾', '前倾', '后仰', '俯身',
  '注视', '凝视', '直视', '望向', '看向', '打量', '目光',
  '倚靠', '靠着', '倚着', '靠在', '撑在', '撑着',
  // 元词（句中自我声明改姿势也算漂移；基线含「站立姿势」等词时豁免）
  '姿势', '姿态', '手势', '肢体',
];

/** 镜头语言信号词（camera locked 时启用；基线含「平视 / 中景」等词时豁免）。
 * 刻意不含「镜头 / 机位 / 视角 / 景别」等元词——忠实复述（如「镜头维持平视」）
 * 不应被误伤；漂移总由具体的景别 / 角度词承载。 */
const CAMERA_SIGNALS: readonly string[] = [
  '俯拍', '仰拍', '俯视', '仰视', '低角度', '高角度',
  '特写', '近景', '中景', '远景', '全景', '大远景',
  '航拍', '鱼眼', '广角', '长焦', '微距', '变焦', '推近', '拉远', '摇镜', '跟拍',
  '第一人称视角', '第三人称视角', '景深',
];

/**
 * 面部表情信号词（pose locked 时启用——表情是动作基线的独立锁定维度）：
 * 优化器重写描述时最典型的表情漂移 = 把 wink 稀释成「微笑 / 双眼睁开 /
 * 眯眼浅笑」；基线含该词（如基线本来写「微笑」）⇒ 忠实描述，保留。
 */
const EXPRESSION_SIGNALS: readonly string[] = [
  '表情', '眨眼', '闭眼', '闭起', '眯眼', '睁眼', '睁开',
  '单眼', '左眼', '右眼', '双眼', '眼神',
  '微笑', '笑容', '含笑', '笑意', '大笑', '嘴角', '挑眉', '皱眉', '吐舌',
  'wink', 'Wink', 'WINK',
];

export interface LockGuardResult {
  /** 守卫后的描述正文（只删漂移句；无漂移时与输入一致）。 */
  text: string;
  /** 被拦截删除的句子（供 UI 提示与测试断言）。 */
  removedSentences: string[];
  /** 实际启用守卫的维度（如 ['pose', 'camera']）。 */
  guardedDimensions: string[];
}

/** 句子切分（保留分隔符语义；按 。！？；与换行）。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .map(part => part.trim())
    .filter(Boolean);
}

/** 句中命中的「基线未包含」信号词（全部信号词都在基线中 ⇒ null，句子保留）。 */
function foreignSignals(sentence: string, signals: readonly string[], baseline: string): string[] | null {
  const hits = signals.filter(signal => sentence.includes(signal) && !baseline.includes(signal));
  return hits.length > 0 ? hits : null;
}

/** 模板动作基线全文（全局动作 + 逐主体姿态 / 手势 / 表情 / 视线 / 朝向）。 */
function poseBaselineText(project: VisualProject): string {
  const snapshot = project.templateSnapshot;
  if (!snapshot) return '';
  const parts = [snapshot.action.originalValue];
  for (const pose of snapshot.subjectPoses ?? []) {
    parts.push(pose.poseDescription);
    if (pose.gesture) parts.push(pose.gesture);
    if (pose.facialExpression) parts.push(pose.facialExpression);
    if (pose.gaze) parts.push(pose.gaze);
    if (pose.bodyOrientation) parts.push(pose.bodyOrientation);
  }
  return parts.filter(Boolean).join('；');
}

/** 段末回退块：模板逐主体姿态基线（V4.2 行为；V5 §57 起锁定基线唯一来源 =
 * 【模板保留合同】，最终画面描述不再追加——本函数仅供历史测试锚定，
 * 主链路不再调用）。 */
export function compilePoseBaselineFallback(project: VisualProject): string {
  const snapshot = project.templateSnapshot;
  const poses = snapshot?.subjectPoses ?? [];
  if (poses.length === 0) return '';
  const roleLabels: Record<string, string> = {
    primary_subject: '主体',
    anime_counterpart: '动漫对应角色',
    secondary_subject: '次要主体',
    detail_insert: '细节特写',
  };
  const lines = poses.map(pose => {
    const details = [
      pose.poseDescription,
      pose.gesture ? `手势：${pose.gesture}` : '',
      pose.facialExpression ? `表情：${pose.facialExpression}` : '',
      pose.gaze ? `视线：${pose.gaze}` : '',
      pose.bodyOrientation ? `朝向：${pose.bodyOrientation}` : '',
    ].filter(Boolean).join('；');
    return `- ${pose.label}（${roleLabels[pose.subjectRole] ?? pose.subjectRole}）：${details}`;
  });
  return [
    '动作基线（模板唯一事实来源——最终画面必须严格按以下姿态、手势、表情、视线呈现，'
    + '任何主体不得出现新的动作、手势、肢体展开、表情、身体朝向或视线）：',
    ...lines,
  ].join('\n');
}

/**
 * 最终画面描述守卫：维度 locked ⇒ 拦截基线外信号句。
 * V5 §57/§58：描述只承载 Delta——不再向段末追加动作基线（锁定基线唯一来源 =
 * 【模板保留合同】；历史缺陷「手动 Prompt 末尾拼接动作基线」在此修复）。
 * 无模板快照 / 维度未锁 / 描述无漂移时原样返回（绝不误伤忠实描述）。
 */
export function guardLockedDimensionsInDescription(input: {
  description: string;
  project: VisualProject;
}): LockGuardResult {
  const { project } = input;
  const description = input.description.trim();
  const empty: LockGuardResult = {
    text: description,
    removedSentences: [],
    guardedDimensions: [],
  };
  if (!description || !project.templateSnapshot) return empty;

  const contracts = new Map(buildDimensionContracts(project).map(c => [c.key, c]));
  const poseLocked = contracts.get('pose')?.mode === 'locked';
  const cameraLocked = contracts.get('camera')?.mode === 'locked';
  if (!poseLocked && !cameraLocked) return empty;

  const poseBaseline = poseLocked ? poseBaselineText(project) : '';
  const cameraBaseline = cameraLocked ? project.templateSnapshot.camera.originalValue : '';

  const removed: string[] = [];
  const kept: string[] = [];
  for (const sentence of splitSentences(description)) {
    const poseHits = poseLocked ? foreignSignals(sentence, POSE_SIGNALS, poseBaseline) : null;
    const expressionHits = poseLocked ? foreignSignals(sentence, EXPRESSION_SIGNALS, poseBaseline) : null;
    const cameraHits = cameraLocked ? foreignSignals(sentence, CAMERA_SIGNALS, cameraBaseline) : null;
    if (poseHits || expressionHits || cameraHits) {
      removed.push(sentence);
      continue;
    }
    kept.push(sentence);
  }

  const guardedDimensions: string[] = [
    ...(poseLocked ? ['pose' as const] : []),
    ...(cameraLocked ? ['camera' as const] : []),
  ];

  return {
    text: kept.join(''),
    removedSentences: removed,
    guardedDimensions,
  };
}
