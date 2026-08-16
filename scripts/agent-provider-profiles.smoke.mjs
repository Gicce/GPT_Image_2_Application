// 静态 smoke 测试 -- node scripts/agent-provider-profiles.smoke.mjs
//
// 验证多 AI 智能体 Profile store 的核心约束：
//   1. 多 Profile 并存（DeepSeek 官方 / GLM 官方 / 第三方 同保存）
//   2. 官方 Provider 禁止新增自定义模型（绕过前端直接调 store action 也必须抛错）
//   3. 第三方可以新增 / 修改 / 删除自定义模型
//   4. 官方 built-in 模型禁止修改和删除
//   5. 同 model_id 在不同 Profile 下保持独立（选择 key = profile_id + model_id）
//   6. 删除默认 Profile -> 安全回退到下一个 enabled profile，绝不恢复内置 GPT Agent
//   7. 全部删光 -> 未配置状态，不自动创建任何 Agent

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const storeMod = await loadTs('../src/features/aiProviders/store.ts');
const { useAIProviderStore } = storeMod;

const migration = await loadTs('../src/features/aiProviders/migration.ts');
const { createEmptyProfile } = migration;

const store = useAIProviderStore.getState();
store.hydrate();

function reset() {
  useAIProviderStore.setState({ profiles: [], selections: {}, defaultProfileId: '', migrated: true });
}

// ============ 一、三种 Provider 并存 ============

{
  reset();
  const deepseek = createEmptyProfile('deepseek_official', 'DeepSeek 官方');
  const glm = createEmptyProfile('glm_official', '智谱 GLM');
  const third = createEmptyProfile('openai_compatible', 'Packy API');
  store.addProfile(deepseek);
  store.addProfile(glm);
  store.addProfile(third);

  const { profiles } = useAIProviderStore.getState();
  assert.equal(profiles.length, 3);
  assert.deepEqual(profiles.map(p => p.provider_type).sort(),
    ['deepseek_official', 'glm_official', 'openai_compatible']);

  // 官方 Profile 自带 Registry 模型（official_registry），GLM 收录多代模型
  const ds = profiles.find(p => p.provider_type === 'deepseek_official');
  assert.ok(ds.models.length >= 1);
  assert.ok(ds.models.every(m => m.model_source === 'official_registry'));
  const glmProfile = profiles.find(p => p.provider_type === 'glm_official');
  assert.ok(glmProfile.models.length >= 8, `GLM Registry 应收录多代模型（当前 ${glmProfile.models.length}）`);
  assert.ok(glmProfile.models.every(m => Array.isArray(m.capabilities) && m.capabilities.length > 0));
  console.log(`✓ DeepSeek / GLM / 第三方三种 Profile 并存（GLM Registry ${glmProfile.models.length} 个模型）`);
}

// ============ 二、官方 Provider 禁止新增自定义模型（store 层硬约束）============

{
  reset();
  const deepseek = createEmptyProfile('deepseek_official', 'DeepSeek 官方');
  store.addProfile(deepseek);
  assert.throws(
    () => store.addCustomModel(deepseek.id, { model_id: 'my-fake-deepseek', display_name: 'Fake' }),
    /官方 Provider/,
    '官方 Provider 必须拒绝新增自定义模型（即使绕过前端）',
  );

  const glm = createEmptyProfile('glm_official', 'GLM');
  store.addProfile(glm);
  assert.throws(
    () => useAIProviderStore.getState().addCustomModel(glm.id, { model_id: 'glm-hack', display_name: 'Hack' }),
    /官方 Provider/,
  );
  console.log('✓ DeepSeek / GLM 官方均拒绝新增自定义模型');
}

// ============ 三、第三方模型 CRUD ============

{
  reset();
  const third = createEmptyProfile('openai_compatible', 'Packy API');
  store.addProfile(third);
  const pid = third.id;

  const created = store.addCustomModel(pid, { model_id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna' });
  assert.equal(created.model_source, 'custom');
  assert.equal(created.enabled, true);

  // 重名拒绝
  assert.throws(() => store.addCustomModel(pid, { model_id: 'gpt-5.6-luna', display_name: 'Dup' }), /已存在/);
  // 非法 ID 拒绝
  assert.throws(() => store.addCustomModel(pid, { model_id: '   ', display_name: 'Blank' }), /不能为空/);

  // 修改显示名 + model_id
  store.updateCustomModel(pid, created.id, { model_id: 'gpt-5.6-luna-v2', display_name: 'Luna V2' });
  let updated = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.ok(updated.models.some(m => m.model_id === 'gpt-5.6-luna-v2'));

  // 删除
  store.removeCustomModel(pid, created.id);
  updated = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.ok(!updated.models.some(m => m.id === created.id));
  console.log('✓ 第三方模型新增 / 重名校验 / 修改 / 删除');
}

// ============ 四、官方 Registry / Discovery 模型禁止修改删除 ============

{
  reset();
  const deepseek = createEmptyProfile('deepseek_official', 'DeepSeek 官方');
  store.addProfile(deepseek);
  const pid = deepseek.id;
  const official = useAIProviderStore.getState().profiles.find(p => p.id === pid).models[0];

  assert.throws(() => store.updateCustomModel(pid, official.id, { display_name: '改名' }), /自定义模型允许修改/);
  assert.throws(() => store.removeCustomModel(pid, official.id), /自定义模型允许删除/);
  console.log('✓ 官方 Registry 模型禁止修改和删除');
}

// ============ 五、同 model_id 跨 Profile 独立（分组选择 key）============

{
  reset();
  const a = createEmptyProfile('openai_compatible', 'Packy 主线路');
  const b = createEmptyProfile('openai_compatible', '公司测试 API');
  store.addProfile(a);
  store.addProfile(b);
  store.addCustomModel(a.id, { model_id: 'glm-5', display_name: 'GLM-5' });
  store.addCustomModel(b.id, { model_id: 'glm-5', display_name: 'GLM-5（公司）' });

  const { profiles } = useAIProviderStore.getState();
  assert.equal(profiles.length, 2);
  assert.ok(profiles.every(p => p.models.some(m => m.model_id === 'glm-5')), '同 model_id 必须保留在两个分组');

  // 会话选择：不同 profile + 同 model_id 解析到各自 Profile
  useAIProviderStore.getState().setSelection('conv1', { profileId: b.id, modelId: 'glm-5' });
  const resolved = useAIProviderStore.getState().getSelection('conv1');
  assert.equal(resolved.profile.id, b.id);
  assert.equal(resolved.model.display_name, 'GLM-5（公司）');
  console.log('✓ 同 model_id 在不同 Profile 下独立；选择 key = profile_id + model_id');
}

// ============ 六、删除默认 Profile 安全回退 ============

{
  reset();
  const a = createEmptyProfile('openai_compatible', 'A 主力');
  const b = createEmptyProfile('openai_compatible', 'B 备用');
  store.addProfile(a);
  store.addProfile(b);
  useAIProviderStore.getState().addCustomModel(a.id, { model_id: 'model-a', display_name: 'A 模型' });
  useAIProviderStore.getState().addCustomModel(b.id, { model_id: 'model-b', display_name: 'B 模型' });
  useAIProviderStore.getState().setDefaultProfile(a.id);
  useAIProviderStore.getState().setSelection('conv1', { profileId: a.id, modelId: 'model-a' });

  useAIProviderStore.getState().removeProfile(a.id);

  const state = useAIProviderStore.getState();
  assert.equal(state.profiles.length, 1);
  assert.equal(state.defaultProfileId, b.id, '默认 Profile 删除后回退到下一个 enabled profile');
  const sel = state.getSelection('conv1');
  assert.ok(sel && sel.profile.id === b.id, '会话选择必须安全迁移到备用 Profile');
  console.log('✓ 删除默认 Profile -> 回退到下一个 enabled profile');
}

// ============ 七、全部删光 -> 未配置状态，绝不自动创建 GPT Agent ============

{
  reset();
  useAIProviderStore.getState().removeProfile(useAIProviderStore.getState().profiles[0]?.id || 'x');
  const state = useAIProviderStore.getState();
  assert.equal(state.profiles.length, 0);
  assert.equal(state.getSelection('conv1'), null, '无 Profile 时解析结果必须是 null（未配置状态）');
  assert.equal(state.defaultProfileId, '');
  // 再次 hydrate 也不会凭空造出内置 Agent（migrated marker 已置位）
  useAIProviderStore.setState({ hydrated: false });
  useAIProviderStore.getState().hydrate();
  assert.equal(useAIProviderStore.getState().profiles.length, 0, '不得自动恢复/创建任何内置 GPT Agent');
  console.log('✓ 删光后进入未配置状态；无内置 GPT Agent 复活');
}

console.log('\n全部通过：agent-provider-profiles');
