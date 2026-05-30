export { classifyAgentIntent, type AgentIntent, type IntentInput } from './agent/intentClassifier';
export { decideAgentAction, buildGalleryClarificationCriteria } from './agent/agentActionRouter';

import { decideAgentAction } from './agent/agentActionRouter';

export function shouldOpenGalleryClarification(text: string): boolean {
  return decideAgentAction({
    text,
    hasImageAttachments: false,
    hasEditableImage: false,
    planOnly: false,
  }).type === 'clarify_gallery';
}
