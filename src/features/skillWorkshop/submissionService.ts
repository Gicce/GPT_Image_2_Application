/**
 * Skill 公开投稿服务（V4.2.3 重构）。
 *
 * 错误处理铁律：
 * - 绝不把 Not Found / JSON / Schema / 代理原始错误透给用户；
 * - 按状态码映射为具体中文文案（describeSubmissionFailure 唯一入口）；
 * - 服务端结构化 detail（{code, message}）里的 message 是我们自己写的中文文案，可直接采用。
 */

import { requestServerUrl } from '../../services/serverApi';
import type { UserSkillDraft } from './userSkill';
import { sanitizeUserSkillForSubmission } from './userSkill';

export interface SkillSubmissionSummary {
  id: string; local_skill_id: string; revision: number; version: string; name: string;
  domain: string; summary: string; status: string; review_message?: string | null;
  sample_count: number; public_skill_id?: string | null; updated_at: string;
}

export type SubmissionFailureKind =
  | 'unauthorized'        // 401 登录失效
  | 'server_unsupported'  // 404/405 服务器未部署投稿服务
  | 'duplicate'           // 409 同修订已投稿（可恢复）
  | 'sample_too_large'    // 413
  | 'payload_incompatible'// 422
  | 'unsafe_content'      // 400 净化扫描拒绝
  | 'bad_request'         // 400 其它
  | 'server_error'        // 5xx
  | 'network'             // 请求未达服务器
  | 'unknown';

export interface SubmissionFailure {
  kind: SubmissionFailureKind;
  message: string;
}

/** 状态码 → 用户文案（唯一映射入口；technical 原文一律不外露）。 */
export function describeSubmissionFailure(status: number, data?: unknown): SubmissionFailure {
  // 服务端结构化错误优先：detail.message 是我们自己下发的中文文案
  const structuredMessage = extractServerMessage(data);
  if (status === 401) return { kind: 'unauthorized', message: '登录已失效，请重新登录后再投稿。' };
  if (status === 404 || status === 405) {
    return { kind: 'server_unsupported', message: '当前服务器尚未部署 Skill 投稿服务，请更新服务端；本地 Skill 不受影响。' };
  }
  if (status === 409) {
    return { kind: 'duplicate', message: structuredMessage || '当前修订已经投稿，将载入已有投稿状态；如需修改内容请创建新修订。' };
  }
  if (status === 413) return { kind: 'sample_too_large', message: '样例图片过大，请压缩后重试。' };
  if (status === 422) return { kind: 'payload_incompatible', message: '投稿数据格式不兼容，请将客户端更新到最新版本。' };
  if (status >= 500) return { kind: 'server_error', message: '服务器暂时不可用，请稍后重试。' };
  if (status >= 400) {
    if (structuredMessage) {
      const code = (data as any)?.detail?.code;
      return { kind: code === 'SKILL_SUBMISSION_UNSAFE' ? 'unsafe_content' : 'bad_request', message: structuredMessage };
    }
    return { kind: 'bad_request', message: '投稿请求被拒绝，请检查内容后重试。' };
  }
  return { kind: 'unknown', message: 'Skill 投稿请求失败，请稍后重试。' };
}

function extractServerMessage(data: unknown): string {
  const detail = (data as { detail?: unknown } | undefined)?.detail;
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
    return (detail as { message: string }).message;
  }
  return '';
}

export class SubmissionFailureError extends Error {
  readonly kind: SubmissionFailureKind;
  readonly status: number;
  readonly serverCode?: string;
  constructor(failure: SubmissionFailure, status: number, serverCode?: string) {
    super(failure.message);
    this.name = 'SubmissionFailureError';
    this.kind = failure.kind;
    this.status = status;
    this.serverCode = serverCode;
  }
}

function authHeaders(json = true): HeadersInit {
  const token = localStorage.getItem('cy_jwt');
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function request(url: string, init: RequestInit): Promise<{ status: number; data: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new SubmissionFailureError({ kind: 'network', message: '网络连接失败，请检查网络后重试。' }, 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = describeSubmissionFailure(response.status, data);
    const serverCode = (data as { detail?: { code?: string } } | undefined)?.detail?.code;
    throw new SubmissionFailureError(failure, response.status, serverCode);
  }
  return { status: response.status, data };
}

/**
 * 投稿能力预检：已登录状态下 GET /api/skills/mine 应返回 200。
 * 旧服务器（未部署投稿路由）返回 404 → 立即阻止提交并提示兼容。
 */
export async function checkSubmissionCapability(): Promise<{ ok: boolean; failure?: SubmissionFailure }> {
  try {
    await request(`${requestServerUrl()}/api/skills/mine`, { headers: authHeaders(false) });
    return { ok: true };
  } catch (error) {
    if (error instanceof SubmissionFailureError) return { ok: false, failure: { kind: error.kind, message: error.message } };
    return { ok: false, failure: { kind: 'unknown', message: '无法连接投稿服务，请稍后重试。' } };
  }
}

export async function submitUserSkill(draft: UserSkillDraft): Promise<SkillSubmissionSummary> {
  const { payload } = sanitizeUserSkillForSubmission(draft);
  const { data } = await request(`${requestServerUrl()}/api/skills/submissions`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({
      local_skill_id: draft.id, revision: draft.sourceRevision, version: draft.version,
      name: draft.name, domain: draft.domain, summary: draft.summary, payload,
      source_facts: draft.sourceFacts.map(fact => ({
        key: fact.key, label: fact.label, value: fact.value, immutable: fact.immutable,
      })),
      authoring_meta: {
        model: draft.ai?.modelId, provider: draft.ai?.providerName,
        source_revision: draft.ai?.generalizedRevision, confirmed_at: draft.confirmedAt,
      },
    }),
  });
  return data as SkillSubmissionSummary;
}

export async function uploadSkillSample(
  submissionId: string, fileName: string, dataUrl: string, taskId: string, publicCover: boolean,
): Promise<void> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const form = new FormData();
  form.append('image', blob, fileName);
  form.append('task_id', taskId);
  form.append('metadata_json', JSON.stringify({ source: 'visual_project', user_authorized: true }));
  form.append('public_cover', String(publicCover));
  await request(`${requestServerUrl()}/api/skills/submissions/${submissionId}/samples`, {
    method: 'POST', headers: authHeaders(false), body: form,
  });
}

export async function listMySkillSubmissions(): Promise<SkillSubmissionSummary[]> {
  const { data } = await request(`${requestServerUrl()}/api/skills/mine`, { headers: authHeaders(false) });
  const list = (data as { submissions?: unknown })?.submissions;
  return Array.isArray(list) ? list as SkillSubmissionSummary[] : [];
}

/** 409 恢复：按 local_skill_id + revision 找回已存在的投稿（含零样例残留）。 */
export async function findExistingSubmission(
  localSkillId: string, revision: number,
): Promise<SkillSubmissionSummary | null> {
  const submissions = await listMySkillSubmissions();
  return submissions.find(item => item.local_skill_id === localSkillId && item.revision === revision) || null;
}
