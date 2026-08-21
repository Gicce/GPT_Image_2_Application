/**
 * 模型能力徽章（V4.0.7）—— capability 展示唯一组件。
 *
 * 数据只来源于模型配置的 capabilities（Registry / Discovery / 用户自定义），
 * 禁止按模型名称猜测。徽章 = 短文字 + title 提示；'text' 是所有模型默认能力不展示，
 * 'unknown'（未声明）保守显示「能力未知」。
 */

import type { ModelCapability } from '../features/aiProviders/types';
import './ModelCapabilityBadges.css';

interface BadgeMeta {
  capability: ModelCapability;
  short: string;
  full: string;
}

const BADGE_META: BadgeMeta[] = [
  { capability: 'vision', short: '图片', full: '支持图片理解' },
  { capability: 'video_vision', short: '视频', full: '支持视频理解' },
  { capability: 'reasoning', short: '思考', full: '支持思考模式' },
  { capability: 'tools', short: '工具', full: '支持 Function Call / 工具调用' },
  { capability: 'structured_output', short: '结构化', full: '支持结构化输出' },
  { capability: 'image_generation', short: '生图', full: '支持图片生成' },
  { capability: 'image_edit', short: '修图', full: '支持图片编辑' },
  { capability: 'video_generation', short: '视频生成', full: '支持视频生成' },
  { capability: 'audio', short: '音频', full: '支持音频' },
];

/** capabilities → 徽章元数据（顺序稳定；text 不展示，unknown 折叠为「能力未知」）。 */
export function capabilityBadgeSummaries(capabilities: ModelCapability[]): BadgeMeta[] {
  const caps = capabilities ?? [];
  const badges = BADGE_META.filter(meta => caps.includes(meta.capability));
  if (badges.length === 0 && (caps.length === 0 || caps.includes('unknown'))) {
    return [{ capability: 'unknown', short: '能力未知', full: '模型能力未声明，请在模型管理确认' }];
  }
  return badges;
}

/** 原生 <option> 内的纯文本能力后缀，如「（图片·视频·思考）」；无可展示能力时为空串。 */
export function capabilityOptionSuffix(capabilities: ModelCapability[]): string {
  const summaries = capabilityBadgeSummaries(capabilities).filter(s => s.capability !== 'unknown');
  return summaries.length > 0 ? `（${summaries.map(s => s.short).join('·')}）` : '';
}

export default function ModelCapabilityBadges(props: { capabilities: ModelCapability[] }) {
  const summaries = capabilityBadgeSummaries(props.capabilities);
  if (summaries.length === 0) return null;
  return (
    <span className="mcap-badges">
      {summaries.map(meta => (
        <span key={meta.capability} className={`mcap-badge mcap-${meta.capability}`} title={meta.full}>
          {meta.short}
        </span>
      ))}
    </span>
  );
}
