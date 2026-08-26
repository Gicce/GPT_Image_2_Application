/**
 * Runtime Skill Center（V4.2 §28-§31）—— 设置「AI 技能中心」。
 *
 * 铁律（§30 不允许假配置）：
 *  - 核心技能（canDisable=false）显示「核心技能 · 始终启用」徽标，无 Toggle；
 *  - 自动启用技能显示「自动启用」徽标（条件满足即生效，无手动开关）；
 *  - 仅 canDisable 技能给真实 Toggle（停用 = 区域合同不编译 / 复刻增强不进优化指令）。
 */

import { useRuntimeSkillStore } from '../../../store/useRuntimeSkillStore';
import { BUILT_IN_RUNTIME_SKILLS, RUNTIME_SKILL_CATEGORY_LABELS } from './registry';

export default function RuntimeSkillCenter() {
  const disabledSkillIds = useRuntimeSkillStore(state => state.disabledSkillIds);
  const toggleSkill = useRuntimeSkillStore(state => state.toggleSkill);

  return (
    <section className="settings-card" data-testid="runtime-skill-center">
      <h3 className="settings-section-title">AI 技能中心</h3>
      <p className="settings-section-desc">
        视觉理解与复刻工作流的运行时技能。技能是既有合同系统的可解释执行层——在视觉工作台「查看技能执行过程」中，每个技能展示发现、建议、用户选择、系统强制与最终写入 Prompt 的内容。
      </p>
      <div className="runtime-skill-group">
        <h4 className="runtime-skill-group-title">视觉理解与复刻</h4>
        <ul className="runtime-skill-list">
          {BUILT_IN_RUNTIME_SKILLS.map(skill => {
            const disabled = disabledSkillIds.includes(skill.id);
            return (
              <li key={skill.id} className="runtime-skill-item">
                <div className="runtime-skill-info">
                  <span className="runtime-skill-name">{skill.name}</span>
                  <span className="runtime-skill-meta">
                    内置 · v{skill.version} · {RUNTIME_SKILL_CATEGORY_LABELS[skill.category]}
                  </span>
                  <span className="runtime-skill-desc">{skill.description}</span>
                </div>
                {skill.canDisable ? (
                  <label className="runtime-skill-toggle" title={skill.description}>
                    <input
                      type="checkbox"
                      checked={!disabled}
                      onChange={e => toggleSkill(skill.id, !e.target.checked)}
                    />
                    <span>{disabled ? '已停用' : '启用'}</span>
                  </label>
                ) : (
                  <span className={`runtime-skill-badge ${skill.autoEnable ? 'is-auto' : 'is-core'}`}>
                    {skill.autoEnable ? '自动启用' : '核心技能 · 始终启用'}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <p className="settings-section-desc">
        停用「区域替换」后区域合同不再编译进最终 Prompt；停用「复刻度增强」后优化指令不再包含复刻增强条款。历史任务不受影响（生成时已冻结当次技能执行）。
      </p>
    </section>
  );
}
