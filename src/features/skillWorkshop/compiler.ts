import type { PromptCompileResult, SkillPackage, SkillProject } from './types';

function clean(value?: string) { return (value ?? '').trim(); }

/** Deterministic compiler. Order is contract: confirmed assets > core rules > overrides > profiles > base > defaults. */
export function compileSkillPrompt(pkg: SkillPackage, project: SkillProject): PromptCompileResult {
  const blockers: string[] = [];
  const confirmedBrands = project.assets.filter(a => a.role === 'brand_logo' && a.brandCard?.confirmed);
  const unconfirmedBrands = project.assets.filter(a => a.role === 'brand_logo' && !a.brandCard?.confirmed);
  if (unconfirmedBrands.length) blockers.push('Logo 素材尚未完成分析与确认，不能用于生成。');
  if (project.themeId === 'custom' && project.assets.length === 0) blockers.push('自定义素材主题必须先上传合法参考素材。');

  const assetText = confirmedBrands.map(asset => {
    const c = asset.brandCard!;
    return `使用附件原始 Logo（禁止文字重绘）：结构 ${c.structure}；文字 ${c.visibleText || '无'}；色彩 ${c.colors.join('、')}；安全区 ${c.safeArea}；禁止 ${c.prohibitedTransformations.join('、')}；用户确认 ${c.userNotes || '按素材卡执行'}。`;
  }).join('\n');
  const profile = (kind: string, id: string) => pkg.profiles.find(p => p.kind === kind && p.id === id)?.prompt ?? '';
  const sections = [
    { label: '安全与素材限制', text: '仅使用用户有权使用的素材；不得伪造品牌标识，不得拉伸、重绘或改造已确认 Logo。' },
    { label: '已确认素材卡', text: assetText },
    { label: '领域硬规则', text: pkg.core_rules.join('\n') },
    { label: '用户本次要求', text: [clean(project.purpose), clean(project.audience) && `目标受众：${clean(project.audience)}`, clean(project.userOverrides)].filter(Boolean).join('\n') },
    { label: '风格与主题', text: [profile('style', project.styleId), profile('theme', project.themeId), profile('platform', project.platformId)].filter(Boolean).join('\n') },
    { label: '基础方案', text: profile('base', pkg.defaults.base) },
    { label: '默认输出', text: `专业、高端、照片级真实感；${project.output.size}；${project.output.quality}质量；真实产品比例与自然光影。` },
  ].filter(s => clean(s.text));
  return { blockers, sections, prompt: sections.map(s => `【${s.label}】\n${s.text}`).join('\n\n') };
}
