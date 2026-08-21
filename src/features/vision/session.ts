/**
 * VisionSession 历史记录（V4.0.6）
 *
 * 轻量 localStorage 持久化（上限 50 条，LIFO）：只存 id / 路径 / Prompt /
 * JSON 分析与评分，绝不存 base64 图片。路径丢失时详情降级（重新分析即可）。
 */

import type { VisionAnalysis } from '../../types';
import type { ReversePromptResult } from './reversePrompt';
import type { SimilarityReport } from './similarity';
import type { RecreationState } from './recreationPlan';

export type VisionMode = 'quick' | 'reverse_prompt' | 'high_fidelity';

/** 迭代记录里只保留评分摘要（differences 可能很长，截断保存） */
export interface IterationSimilaritySnapshot {
  final_score: number;
  subject: number;
  composition: number;
  style: number;
  lighting: number;
  color: number;
  objects: number | null;
  ocr: number | null;
  topDifferences: string[];
}

export interface RecreationIterationRecord {
  attempt: number;
  generatedAssetId?: string;
  candidatePath?: string;
  prompt: string;
  negativePrompt?: string;
  similarity?: IterationSimilaritySnapshot;
}

export interface VisionSession {
  id: string;
  sourceAssetId?: string;
  sourcePath: string;
  visionProfileId: string;
  visionModelId: string;
  mode: VisionMode;
  analysis?: VisionAnalysis;
  reversePrompt?: {
    prompt: string;
    negativePrompt: string;
    recommended: ReversePromptResult['recommended'];
  };
  /** V4.0.7 复刻工作台状态：结构化方案 + 原始/优化后 Prompt + 编辑状态机。 */
  recreation?: RecreationState;
  /** 关联的视觉理解任务 id（任务中心链路显示用）。 */
  visionTaskId?: string;
  iterations: RecreationIterationRecord[];
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'vision_sessions_v1';
const MAX_SESSIONS = 50;

function readAll(): VisionSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.id === 'string');
  } catch {
    return [];
  }
}

function writeAll(sessions: VisionSession[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
    return true;
  } catch {
    return false;
  }
}

export function listVisionSessions(): VisionSession[] {
  return readAll();
}

export function saveVisionSession(session: VisionSession): void {
  const all = readAll().filter(item => item.id !== session.id);
  writeAll([session, ...all]);
}

export function deleteVisionSession(id: string): void {
  writeAll(readAll().filter(item => item.id !== id));
}

export function similarityToSnapshot(report: SimilarityReport): IterationSimilaritySnapshot {
  return {
    final_score: report.final_score,
    subject: report.scores.subject,
    composition: report.scores.composition,
    style: report.scores.style,
    lighting: report.scores.lighting,
    color: report.scores.color,
    objects: report.scores.objects,
    ocr: report.scores.ocr,
    topDifferences: report.differences.slice(0, 6).map(d => d.text),
  };
}
