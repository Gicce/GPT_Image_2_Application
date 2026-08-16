/**
 * 充值业务能力开关（客户端统一抽象）。
 *
 * 功能未完善时不要删除/隐藏对应充值 Card：置 enabled=false 即整体禁用
 * （灰色、不可选、不可输入、不进充值合计），功能完成后改回 true 即恢复。
 */
export type ServiceFeatureId = 'image' | 'postprocess';

export interface ServiceFeatureConfig {
  /** false = 功能开发中：充值区保留展示但整体禁用 */
  enabled: boolean;
  status: 'available' | 'development';
  /** 禁用时的状态徽章文案（enabled=true 时不展示） */
  statusText: string;
  /** 禁用时的悬停提示 */
  hint: string;
}

export const SERVICE_FEATURES: Record<ServiceFeatureId, ServiceFeatureConfig> = {
  image: {
    enabled: true,
    status: 'available',
    statusText: '',
    hint: '',
  },
  postprocess: {
    enabled: false,
    status: 'development',
    statusText: '功能开发中',
    hint: '图片后处理功能正在完善中，暂不可用',
  },
};

export function isServiceFeatureEnabled(id: ServiceFeatureId): boolean {
  return SERVICE_FEATURES[id].enabled;
}
