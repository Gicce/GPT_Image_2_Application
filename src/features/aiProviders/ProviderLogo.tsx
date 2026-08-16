/**
 * Provider 品牌 Logo 统一展示组件。
 *
 * 设计边界（与 Agent Avatar 严格区分）：
 *   - ProviderLogo = 底层模型服务商品牌（智谱 GLM / DeepSeek / 第三方 API）
 *   - Agent Avatar = 用户创建的智能体形象（用户上传或默认 Agent 图标）
 * 两者不可互相替代 —— Agent 没设置头像时使用默认 Agent 图标，而不是 Provider Logo。
 *
 * 显示优先级：Registry 官方 Logo → 第三方通用 API 标识 → Provider 名称首字母。
 */

import { getProviderLogo } from './registry/registry';
import type { AIProviderType } from './types';

export function ProviderLogo(props: {
  providerType: AIProviderType;
  /** fallback 首字母来源，默认 "API"。 */
  name?: string;
  size?: number;
  className?: string;
}) {
  const size = props.size || 18;
  const logo = getProviderLogo(props.providerType);
  const label = props.providerType === 'openai_compatible' ? 'API' : (props.name || 'API').trim();
  const initial = label.charAt(0).toUpperCase() || 'A';

  if (logo) {
    return (
      <img
        src={logo}
        alt={`${label} Logo`}
        width={size}
        height={size}
        className={`provider-logo ${props.className || ''}`}
        style={{ width: size, height: size }}
        draggable={false}
      />
    );
  }
  return (
    <span
      className={`provider-logo-fallback ${props.className || ''}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.5)) }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
