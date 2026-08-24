/**
 * useQuoteStore — 生成前报价确认（Generation Quote Pattern）
 *
 * 硬规则：所有产生付费图片 API 调用的入口在 authorize 之前必须先取服务端报价，
 * 用户在确认弹层看到 单张/预计/余额/剩余 后才继续。参数变化 → 旧 quote 作废重报。
 * 本 store 只承载弹层状态（视图层），报价数据一律来自服务端，客户端禁止自行
 * 数量×单价 计算。
 */

import { create } from 'zustand';
import type { BillingQuote } from '../services/serverApi';

export interface QuoteConfirmPending {
  quote: BillingQuote;
  resolve: (approved: boolean) => void;
}

interface QuoteState {
  pending: QuoteConfirmPending | null;
  openConfirm: (quote: BillingQuote) => Promise<boolean>;
  settle: (approved: boolean) => void;
}

export const useQuoteStore = create<QuoteState>((set, get) => ({
  pending: null,

  openConfirm: (quote) =>
    new Promise<boolean>((resolve) => {
      // 并发保护：上一个确认未关闭时先拒绝（不可能同时发起两个生成入口）
      if (get().pending) {
        resolve(false);
        return;
      }
      set({ pending: { quote, resolve } });
    }),

  settle: (approved) => {
    const current = get().pending;
    if (!current) return;
    set({ pending: null });
    current.resolve(approved);
  },
}));

/**
 * 请求报价并等待用户确认。resolve true 才可继续提交。
 * 取报价失败时抛出原始错误（由调用方错误链路呈现）。
 */
export async function requestQuoteConfirmation(feature: string, imageCount: number): Promise<BillingQuote> {
  const { serverApi } = await import('../services/serverApi');
  const quote = await serverApi.createQuote(feature, imageCount);
  const approved = await useQuoteStore.getState().openConfirm(quote);
  if (!approved) {
    const err = new Error('已取消生成') as Error & { quoteCancelled?: boolean };
    err.quoteCancelled = true;
    throw err;
  }
  return quote;
}
