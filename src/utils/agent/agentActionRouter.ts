import type { GallerySearchCriteria } from '../../types';
import { createGalleryCriteriaFromText, DEFAULT_GALLERY_CRITERIA } from './galleryCriteria';
import { classifyAgentIntent } from './intentClassifier';

export type AgentActionDecision =
  | { type: 'send'; intent: ReturnType<typeof classifyAgentIntent> }
  | { type: 'direct_gallery_search'; intent: 'gallery_search'; criteria: GallerySearchCriteria }
  | { type: 'clarify_gallery'; intent: 'gallery_search'; criteria: GallerySearchCriteria };

type AgentActionInput = {
  text: string;
  hasImageAttachments?: boolean;
  hasEditableImage?: boolean;
  planOnly?: boolean;
};

function needsGalleryClarification(text: string, criteria: GallerySearchCriteria): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  const hasTimeRange = !!criteria.timeRange;
  const hasSubject = criteria.subjects.length > 0;
  const hasStyle = criteria.styles.length > 0;
  const hasOrientation = criteria.orientation && criteria.orientation !== '不限';
  const hasExtra = !!criteria.extra.trim();

  const broadLatestRequest = /((最新|最近|近期).*(图库|图片|照片))|(有哪些|哪一些)/.test(normalized);
  const recallOnly = /(我记得|之前|以前|曾经|好像有|有没有)/.test(normalized);

  if (!hasTimeRange && !hasSubject && !hasStyle && !hasOrientation && !hasExtra) return true;
  if (broadLatestRequest && !hasSubject && !hasStyle) return true;
  if (recallOnly && !hasTimeRange && !hasSubject && !hasStyle) return true;

  return false;
}

export function buildGalleryClarificationCriteria(text: string): GallerySearchCriteria {
  const criteria = createGalleryCriteriaFromText(text);
  return {
    ...DEFAULT_GALLERY_CRITERIA,
    ...criteria,
    subjects: [...criteria.subjects],
    styles: [...criteria.styles],
  };
}

export function decideAgentAction(input: AgentActionInput): AgentActionDecision {
  const intent = classifyAgentIntent(input);
  if (intent !== 'gallery_search') {
    return { type: 'send', intent };
  }

  const criteria = buildGalleryClarificationCriteria(input.text);
  if (needsGalleryClarification(input.text, criteria)) {
    return { type: 'clarify_gallery', intent, criteria };
  }

  return { type: 'direct_gallery_search', intent, criteria };
}
