import type { AgentStyleTemplate, AgentTaskTemplate } from '../../types';

type TemplateCache = {
  taskTemplates: AgentTaskTemplate[];
  styleTemplates: AgentStyleTemplate[];
  loadedAt: number;
};

let cache: TemplateCache | null = null;

export function getAgentTemplateCache() {
  return cache;
}

export function setAgentTemplateCache(taskTemplates: AgentTaskTemplate[], styleTemplates: AgentStyleTemplate[]) {
  cache = {
    taskTemplates,
    styleTemplates,
    loadedAt: Date.now(),
  };
}

export function invalidateAgentTemplateCache() {
  cache = null;
}
