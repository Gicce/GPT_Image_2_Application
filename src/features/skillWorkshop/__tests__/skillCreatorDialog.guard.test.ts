import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Skill 创作器结构守卫（源码文本断言，项目内无 DOM 测试环境）：
 * - 三段式弹窗布局（固定头部 + 可收缩内容 + 固定底部）在 1024×768 可用；
 * - 来源事实只读 + 展开/收起；检查规则三卡片行编辑 + 确认语义；
 * - 样例双入口 + 公开授权确认；投稿恢复（不重复创建）；
 * - 图片库选择复用共享 ImageLibraryPicker（ImageStudio 同步迁移，无第二套实现）。
 */

const src = readFileSync(resolve(__dirname, '../SkillCreatorDialog.tsx'), 'utf-8');
const css = readFileSync(resolve(__dirname, '../SkillCreatorDialog.css'), 'utf-8');
const pickerSrc = readFileSync(resolve(__dirname, '../../../components/ImageLibraryPicker.tsx'), 'utf-8');
const studioSrc = readFileSync(resolve(__dirname, '../../../pages/ImageStudio.tsx'), 'utf-8');

describe('弹窗三段式布局（1024×768 可达性）', () => {
  test('弹窗高度 height:min(720px, calc(100vh - 48px)) 且保留最大宽度（V6.1 Wizard Geometry）', () => {
    expect(css).toMatch(/\.skill-creator-dialog\s*{[^}]*height:\s*min\(720px,\s*calc\(100vh - 48px\)\)/s);
    expect(css).toMatch(/\.skill-creator-dialog\s*{[^}]*width:\s*min\(960px,\s*calc\(100vw - 48px\)\)/s);
    expect(css).toMatch(/\.skill-creator-dialog\s*{[^}]*max-height:\s*calc\(100vh - 32px\)/s);
  });

  test('弹窗 grid 行结构 auto / minmax(0,1fr)，滚动只发生在正文与步骤栏', () => {
    expect(css).toMatch(/\.skill-creator-dialog\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
    expect(css).toMatch(/\.skill-creator-main\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/s);
    expect(css).toMatch(/\.skill-creator-body\s*{[^}]*overflow-y:\s*auto[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.skill-creator-steps\s*{[^}]*overflow-y:\s*auto[^}]*min-height:\s*0/s);
  });

  test('所有 grid 子项补 min-height:0 / min-width:0（小分辨率不被截断）', () => {
    expect(css).toMatch(/\.skill-creator-layout\s*{[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.skill-creator-main\s*{[^}]*min-width:\s*0[^}]*min-height:\s*0/s);
  });

  test('底部操作栏固定（上一步/下一步/保存/提交不随长内容滚出视口）', () => {
    expect(src).toContain('className="skill-creator-footer"');
    expect(css).toMatch(/\.skill-creator-footer\s*{[^}]*border-top/s);
    expect(src.match(/className="app-btn app-btn-primary"[^>]*onClick=\{\(\) => void publish\(\)\}/)).toBeTruthy();
    expect(src).toContain('>上一步</button>');
  });

  test('打开弹窗禁止背景滚动，关闭恢复（body overflow 存取原值）', () => {
    expect(src).toMatch(/document\.body\.style\.overflow = 'hidden'/);
    expect(src).toMatch(/document\.body\.style\.overflow = previousOverflow/);
  });

  test('Escape 关闭；图片库选择器打开时弹窗不抢 Escape', () => {
    expect(src).toMatch(/e\.key === 'Escape' && !galleryOpenRef\.current/);
  });

  test('≤1100px 媒体查询收缩（覆盖 1024×768）', () => {
    expect(css).toMatch(/@media \(max-width: 1100px\)/);
    expect(css).toMatch(/\.skill-creator-layout \{ grid-template-columns: 160px minmax\(0, 1fr\); \}/);
  });
});

describe('来源事实页（只读紧凑分组）', () => {
  test('来源事实只读：无输入控件，只读徽标 + 展开/收起', () => {
    expect(src).toContain('skill-fact-readonly');
    expect(src).toContain('is-clamped');
    expect(src).toMatch(/aria-expanded=\{expanded\}/);
    const factSection = src.slice(src.indexOf('step === 1'), src.indexOf('step === 2'));
    expect(factSection).not.toMatch(/<input|<textarea|<select/);
  });

  test('长内容两行折叠由 CSS line-clamp 实现', () => {
    expect(css).toMatch(/-webkit-line-clamp:\s*2/);
  });

  test('AI 通用化不修改来源事实（candidate 展开不改 sourceFacts 字段写入）', () => {
    const generalizeBlock = src.slice(src.indexOf('const generalize'), src.indexOf('const saveLocal'));
    expect(generalizeBlock).not.toMatch(/sourceFacts\s*:/);
  });
});

describe('检查规则页（三卡片行编辑 + 确认语义）', () => {
  test('三张卡片：核心规则 / 阻断条件 / 质检标准（不再是大 textarea）', () => {
    const rulesSection = src.slice(src.indexOf('step === 3 && <div'), src.indexOf('step === 4 && <div'));
    expect(rulesSection).toContain('title="不可破坏的核心规则"');
    expect(rulesSection).toContain('title="生成前阻断条件"');
    expect(rulesSection).toContain('title="质检标准"');
    expect(rulesSection).not.toMatch(/<textarea/);
  });

  test('行级操作：新增 / 删除 / 上移 / 下移 / 空状态（全部走 skillRules 纯函数）', () => {
    expect(src).toContain('addRuleItem');
    expect(src).toContain('removeRuleItem');
    expect(src).toContain('moveRuleItem(props.items, index, -1)');
    expect(src).toContain('moveRuleItem(props.items, index, 1)');
    expect(src).toContain('skill-rule-empty');
  });

  test('AI 候选状态与实际执行模型在固定标题区展示', () => {
    expect(src).toContain('skill-rules-statusbar');
    expect(src).toMatch(/实际执行模型：\{modelLabel \|\| '尚未配置'\}/);
  });

  test('只有点击「确认当前规则」才 confirmed；任何规则编辑回落 ai_candidate', () => {
    expect(src).toMatch(/authoringState: 'confirmed'/);
    expect(src).toMatch(/authoringState: value\.authoringState === 'confirmed' \? 'ai_candidate' : value\.authoringState/);
    // publish 不再代为确认
    const publishBlock = src.slice(src.indexOf('const publish'), src.indexOf('const published ='));
    expect(publishBlock).not.toMatch(/authoringState: 'confirmed' as const/);
    expect(src).toMatch(/draft\.authoringState !== 'confirmed' \|\| published/);
  });
});

describe('保存与发布页（样例双入口 + 授权）', () => {
  test('双入口：从本地选择（api.selectImageFile）+ 从图片库选择（共享 ImageLibraryPicker）', () => {
    expect(src).toContain('从本地选择');
    expect(src).toContain('从图片库选择');
    expect(src).toContain('api.selectImageFile()');
    expect(src).toMatch(/<ImageLibraryPicker/);
  });

  test('选中后展示：缩略图 / 文件名 / 来源徽标 / 尺寸格式 / 更换·移除·查看大图', () => {
    expect(src).toContain('skill-sample-thumb');
    expect(src).toContain('skill-sample-source-badge');
    expect(src).toContain("sample.source === 'gallery' ? '图片库' : '本地'");
    expect(src).toMatch(/\$\{sample\.width\}×\$\{sample\.height\}/);
    expect(src).toContain('>更换</button>');
    expect(src).toContain('>移除</button>');
    expect(src).toContain('>查看大图</button>');
  });

  test('查看大图走全局 ImageViewer（openViewer）', () => {
    expect(src).toMatch(/useImageViewerStore\.getState\(\)\.openViewer/);
  });

  test('提交前必选公开展示授权确认', () => {
    expect(src).toContain('我确认拥有该图片的公开展示权，并同意审核通过后将其作为 Skill 示例展示。');
    expect(src).toMatch(/!sample \|\| !authorized \|\| draft\.authoringState !== 'confirmed' \|\| published/);
    expect(src).toMatch(/请先勾选公开展示授权确认/);
  });

  test('本地保存不需要样例且不触发投稿接口（saveLocal 不引用 submission/upload）', () => {
    const saveBlock = src.slice(src.indexOf('const saveLocal'), src.indexOf('const applySample'));
    expect(saveBlock).not.toMatch(/submitUserSkill|uploadSkillSample|checkSubmissionCapability/);
  });
});

describe('投稿错误处理与恢复', () => {
  test('发布前先做能力预检（checkSubmissionCapability）', () => {
    const publishBlock = src.slice(src.indexOf('const publish'), src.indexOf('const published ='));
    expect(publishBlock).toContain('checkSubmissionCapability()');
    expect(publishBlock.indexOf('checkSubmissionCapability')).toBeLessThan(publishBlock.indexOf('submitUserSkill'));
  });

  test('防重复点击：busy 状态禁用全部底部按钮', () => {
    expect(src).toMatch(/disabled=\{Boolean\(busy\) \|\| published\}/);
    expect(src).toMatch(/disabled=\{step === 0 \|\| Boolean\(busy\)\}/);
  });

  test('投稿创建成功即记住 ID；样例上传失败后重试复用，不重复创建', () => {
    expect(src).toMatch(/setSubmissionId\(targetId\)/);
    expect(src).toMatch(/let targetId = createdId/);
    expect(src).toContain('已保留投稿记录，可直接重试上传样例。');
  });

  test('409 duplicate → findExistingSubmission 恢复已有投稿', () => {
    expect(src).toMatch(/e\.kind === 'duplicate'/);
    expect(src).toContain('findExistingSubmission(draft.id, draft.sourceRevision)');
  });

  test('全部上传完成才标记 submitted（persist 在 upload 之后）', () => {
    const publishBlock = src.slice(src.indexOf('const publish'), src.indexOf('const published ='));
    expect(publishBlock.indexOf('uploadSkillSample')).toBeLessThan(publishBlock.indexOf("status: 'submitted'"));
  });

  test('用户可见错误只来自 SubmissionFailureError 映射文案', () => {
    const publishBlock = src.slice(src.indexOf('const publish'), src.indexOf('const published ='));
    expect(publishBlock).toMatch(/e instanceof SubmissionFailureError \? e\.message/);
  });
});

describe('共享图片库选择器（唯一实现）', () => {
  test('ImageLibraryPicker：useImageStore 数据 + readThumbnail 缩略图 + 打开时刷新', () => {
    expect(pickerSrc).toContain('useImageStore');
    expect(pickerSrc).toContain('api.readThumbnail');
    expect(pickerSrc).toMatch(/if \(props\.open\) void loadImages\(\)/);
    expect(pickerSrc).toMatch(/e\.key === 'Escape'/);
  });

  test('ImageStudio 两处旧弹窗已迁移到共享选择器，无第二套实现', () => {
    expect(studioSrc).toMatch(/<ImageLibraryPicker/);
    expect(studioSrc).not.toContain('studio-gallery-grid');
    expect(studioSrc).not.toContain('studio-gallery-cell');
  });
});
