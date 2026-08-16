/**
 * 模型中心编排：刷新模型目录 + 批量快速检测。
 * 并发安全：每次操作携带 generation token，旧请求返回后不覆盖新状态
 * （用户连续刷新 / 切换 Provider 时，过期响应直接丢弃）。
 */
import type { AIProviderProfile, AIProviderModel } from './types';
import { getProviderAdapter, profileToken, resolveProfileBaseUrl } from './adapters';
import { loadRegistry, mergeModelCatalogs, type RegistryModelEntry } from './registry/registry';

export interface RefreshModelsReport {
  ok: boolean;
  /** 合并后的完整模型列表（调用方经 store.applyModelSync 落库） */
  models: AIProviderModel[];
  added: string[];
  updated: string[];
  missing: string[];
  discoveredCount: number;
  /** Provider 未提供 /models 接口（404/405/501）—— 不是错误，回退内置目录 */
  discoveryUnsupported?: boolean;
  registryOrigin: 'remote' | 'cache' | 'builtin';
  errorCode?: string;
  errorMessage?: string;
}

let refreshGeneration = 0;
let batchTestGeneration = 0;

/** 刷新模型目录：Provider Discovery + 远程 Registry + 内置 Registry 三方合并。 */
export async function refreshModelCatalog(
  profile: AIProviderProfile,
  options?: { forceRemote?: boolean },
): Promise<RefreshModelsReport> {
  const generation = ++refreshGeneration;
  const token = profileToken(profile);
  const adapter = getProviderAdapter(profile.provider_type);
  const baseUrl = resolveProfileBaseUrl(profile);

  const [discovery, registryResult] = await Promise.all([
    token ? adapter.discoverModels(baseUrl, token) : Promise.resolve(null),
    loadRegistry(profile.provider_type, { force: options?.forceRemote }),
  ]);
  if (generation !== refreshGeneration) {
    return { ok: false, models: profile.models, added: [], updated: [], missing: [], discoveredCount: 0, registryOrigin: 'builtin', errorCode: 'stale' };
  }

  const registry = (registryResult.registry?.models || []) as RegistryModelEntry[];
  const merge = mergeModelCatalogs({
    existing: profile.models,
    discovered: discovery?.ok ? discovery.modelIds : undefined,
    registry,
  });

  const report: RefreshModelsReport = {
    ok: true,
    models: merge.models,
    added: merge.added,
    updated: merge.updated,
    missing: merge.missing,
    discoveredCount: discovery?.ok ? discovery.modelIds.length : 0,
    discoveryUnsupported: !discovery?.ok && !!discovery?.unsupported,
    registryOrigin: registryResult.origin,
    ...(discovery && !discovery.ok && !discovery.unsupported && discovery.errorCode !== 'missing_api_key'
      ? { errorCode: discovery.errorCode, errorMessage: discovery.errorMessage }
      : {}),
  };
  // Discovery 失败（如未支持 /models）不是错误：回退 Registry，仍返回合并结果
  return report;
}

export interface BatchTestHandle {
  promise: Promise<void>;
  cancel: () => void;
}

export interface BatchTestCallbacks {
  onProgress?: (done: number, total: number, currentModelId: string) => void;
  onModelResult?: (modelRowId: string, modelId: string, result: {
    test_status: 'available' | 'failed';
    last_latency_ms?: number;
    last_error_code?: string;
    last_error_message?: string;
    last_error_status?: number;
    last_check_level?: 'quick' | 'deep';
    inconclusive?: boolean;
  }) => void;
}

/**
 * 检测全部模型 —— 只做 Level 1 快速检测（GET /models，不产生生成请求 / Token 消耗）。
 * concurrency = 2：禁止 Promise.all 轰炸 Provider。
 */
export function runQuickTestAll(
  profile: AIProviderProfile,
  models: AIProviderModel[],
  callbacks: BatchTestCallbacks = {},
): BatchTestHandle {
  const generation = ++batchTestGeneration;
  let cancelled = false;
  const adapter = getProviderAdapter(profile.provider_type);
  const token = profileToken(profile);
  const baseUrl = resolveProfileBaseUrl(profile);
  const queue = models.filter(model => model.enabled && model.lifecycle !== 'retired');
  const total = queue.length;
  let done = 0;

  const promise = (async () => {
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (!cancelled) {
        const model = queue.shift();
        if (!model) return;
        if (generation !== batchTestGeneration) return; // 过期批次：静默退出
        callbacks.onProgress?.(done, total, model.model_id);
        const result = token
          ? await adapter.quickTestModel(baseUrl, token, model.model_id)
          : { ok: false, inconclusive: false, latencyMs: 0, errorCode: 'missing_api_key' as const };
        done += 1;
        callbacks.onProgress?.(done, total, model.model_id);
        if (generation !== batchTestGeneration || cancelled) return;
        if (result.inconclusive) {
          // 快速检测无法判定（接口不支持 / 目录未收录该模型）：保持 untested，提示走深度测试
          callbacks.onModelResult?.(model.id, model.model_id, {
            test_status: 'failed',
            last_error_code: result.errorCode || 'quick_check_unsupported',
            last_error_message: result.errorMessage || '快速检测无法判定，可尝试深度测试',
            inconclusive: true,
          });
        } else {
          callbacks.onModelResult?.(model.id, model.model_id, {
            test_status: result.ok ? 'available' : 'failed',
            last_latency_ms: result.latencyMs,
            last_error_code: result.errorCode,
            last_error_message: result.errorMessage,
            last_error_status: result.httpStatus,
          });
        }
      }
    });
    await Promise.all(workers);
  })();

  return { promise, cancel: () => { cancelled = true; } };
}
