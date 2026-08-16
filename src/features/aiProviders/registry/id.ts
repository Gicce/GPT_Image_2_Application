/** Registry / Discovery 模型的稳定 row id：同一 model_id 跨多次合并保持不变。 */
export function officialModelRowId(modelId: string): string {
  const safe = modelId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `reg_${safe}`;
}

export function generateProfileId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `profile_${timestamp}_${random}`;
}

export function generateModelId(): string {
  return `model_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}
