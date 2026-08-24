import { describe, it, expect } from 'vitest';
import {
  buildVisionContextImages,
  detectMentionTrigger,
  findMentionTokens,
  insertMentionToken,
  mentionSuggestionSignature,
  mentionTokenOf,
  normalizeImagePath,
  pruneMentions,
  removeMentionToken,
  resolveImageMentionRoles,
  type ImageMention,
} from '../imageMention';
import type { PersonReplacement } from '../modificationIntent';

/** 用户真实场景：图二 = 动漫AI照片风模板（主参考图）；图三 = 真人人物参考。 */
const personRef: PersonReplacement = { source: 'gallery', assetId: 'a3', path: 'D:/imgs/图三.png', label: '图三.png' };

const scenarioPool = buildVisionContextImages({
  sourcePath: 'D:/imgs/图二.png',
  sourceAssetId: 'a2',
  person: personRef,
});

const mentionOf = (token: string, path: string, role: ImageMention['role']): ImageMention => ({
  id: `m-${token}`,
  path,
  label: token,
  token,
  role,
});

describe('当前任务图片池（统一 selector，去重 + 业务标签）', () => {
  it('场景 A：图二（模板）+ 图三（人物）都在池中，带缩略图数据与角色标签', () => {
    expect(scenarioPool.map(image => image.path)).toContain('D:/imgs/图二.png');
    expect(scenarioPool.map(image => image.path)).toContain('D:/imgs/图三.png');
    const person = scenarioPool.find(image => image.path === 'D:/imgs/图三.png')!;
    expect(person.roleLabel).toBe('人物参考');
    expect(person.note).toContain('主角身份');
    const source = scenarioPool.find(image => image.path === 'D:/imgs/图二.png')!;
    expect(source.label).toBe('原图');
    expect(source.roleLabel).toBe('主参考图');
  });

  it('池只来自当前任务输入：其它对话 / 图库无关图片绝不出现', () => {
    expect(scenarioPool.some(image => image.path.includes('别的对话'))).toBe(false);
    expect(scenarioPool.length).toBe(2);
  });

  it('已设置人物参考时置顶（@ 候选优先出现「人物参考」）', () => {
    expect(scenarioPool[0].role).toBe('person_replacement_reference');
  });

  it('同路径去重：一张图同时是主参考图与生成结果时只显示一次，取更具体标签', () => {
    const pool = buildVisionContextImages({
      sourcePath: 'D:/same.png',
      generatedResults: [{ assetId: 'g1', path: 'D:/same.png' }],
    });
    expect(pool.length).toBe(1);
    expect(pool[0].roleLabel).toBe('主参考图');
  });

  it('生成结果按序号命名（生成结果 1 / 生成结果 2）；路径未知的结果跳过', () => {
    const pool = buildVisionContextImages({
      sourcePath: 'D:/src.png',
      generatedResults: [
        { assetId: 'g1', path: 'D:/r1.png' },
        { assetId: 'g2', path: '' },
        { assetId: 'g3', path: 'D:/r2.png' },
      ],
    });
    const labels = pool.map(image => image.label);
    expect(labels).toContain('生成结果 1');
    expect(labels).toContain('生成结果 2');
    expect(pool.length).toBe(3);
  });

  it('图库附加参考（generic）与 person/source 去重（路径归一大小写 / 反斜杠不敏感）', () => {
    const pool = buildVisionContextImages({
      sourcePath: 'D:\\Imgs\\Fig2.PNG',
      person: { source: 'local', path: 'd:/imgs/fig3.png' },
      extraReferences: [{ assetId: 'x1', path: 'D:/imgs/extra.png' }, { path: 'd:/imgs/FIG3.png' }],
    });
    expect(pool.length).toBe(3);
    expect(normalizeImagePath('D:\\A\\B.PNG')).toBe(normalizeImagePath('d:/a/b.png'));
  });
});

describe('Mention token（插入 / 定位 / 清理）', () => {
  it('插入：替换 @query 片段为 @token + 尾随空格，光标落在 token 后', () => {
    const image = scenarioPool[0]; // 图三（person 置顶；label 图三.png → token 去空白）
    const result = insertMentionToken('把 的人物换掉', 3, image, 2);
    const token = mentionTokenOf(image.label);
    expect(result.token).toBe(token);
    expect(result.text).toBe(`把 @${token} 人物换掉`);
    expect(result.caret).toBe(`把 @${token} `.length);
  });

  it('token 定位：文本中 @token 出现位置可查；文本删除后 mention 成为孤儿被清理', () => {
    const mention = mentionOf('图三', 'D:/imgs/图三.png', 'person_replacement_reference');
    const text = '把 @图二 的人物换成 @图三 的人物';
    const matches = findMentionTokens(text, [mention]);
    expect(matches.length).toBe(1);
    expect(text.slice(matches[0].start, matches[0].end)).toBe('@图三');
    expect(pruneMentions(text, [mention]).map(m => m.id)).toContain('m-图三');
    expect(pruneMentions('现在没有引用了', [mention])).toHaveLength(0);
  });

  it('移除：删除首个 @token 并吞掉 token 后的尾随空格', () => {
    const mention = mentionOf('图三', 'D:/imgs/图三.png', 'person_replacement_reference');
    expect(removeMentionToken('把 @图二 的人物换成 @图三 保持风格', mention))
      .toBe('把 @图二 的人物换成 保持风格');
  });

  it('触发检测：@ 后无空白才触发；@ 前是普通字符（邮箱场景）不触发；query 限长', () => {
    expect(detectMentionTrigger('把 @', 3)).toEqual({ start: 2, query: '' });
    expect(detectMentionTrigger('把 @图', 4)).toEqual({ start: 2, query: '图' });
    expect(detectMentionTrigger('mail@a.b', 6)).toBeNull();
    expect(detectMentionTrigger('把 @图 ', 4)).toEqual({ start: 2, query: '图' });
    // 光标已离开 @query 片段（后面有空格）→ 不触发
    expect(detectMentionTrigger('把 @图 的人物', 6)).toBeNull();
  });

  it('触发检测：CJK 前缀必须触发（中文无词间空格，根据@ / 把@ 是自然输入）', () => {
    expect(detectMentionTrigger('@', 1)).toEqual({ start: 0, query: '' });
    expect(detectMentionTrigger('根据@', 3)).toEqual({ start: 2, query: '' });
    expect(detectMentionTrigger('根据@原', 4)).toEqual({ start: 2, query: '原' });
    expect(detectMentionTrigger('把@原图', 4)).toEqual({ start: 1, query: '原图' });
    expect(detectMentionTrigger('参考 @', 4)).toEqual({ start: 3, query: '' });
    // 拉丁字母 / 数字前缀仍按邮箱 / 用户名保护拦截
    expect(detectMentionTrigger('abc@', 4)).toBeNull();
    expect(detectMentionTrigger('123@', 4)).toBeNull();
  });

  it('触发检测：一句话多个 @ 时基于光标识别当前 Mention（最近一个未完成的 @）', () => {
    const text = '保持@原图背景，然后把人物替换成@';
    expect(detectMentionTrigger(text, text.length)).toEqual({ start: text.length - 1, query: '' });
    // 光标落在第一个 @query 中间：query 取当前光标前的片段
    expect(detectMentionTrigger('保持@原图背景', 4)).toEqual({ start: 2, query: '原' });
  });

  it('触发检测（caret-aware）：光标移回已完成 token 中间时按当前位置取 query', () => {
    // 'AAA @原图 BBB'，光标在「原」之后（index 6）
    expect(detectMentionTrigger('AAA @原图 BBB', 6)).toEqual({ start: 4, query: '原' });
    // 光标在 token 之后（index 7）：query='图' 仍处于待补全片段
    expect(detectMentionTrigger('AAA @原图 BBB', 7)).toEqual({ start: 4, query: '原图' });
    // 光标越过 token 到空格（index 8）：query 含空白 → 不触发
    expect(detectMentionTrigger('AAA @原图 BBB', 8)).toBeNull();
  });

  it('触发检测：query 中出现标点终止符即视为 Mention 已完成，不再弹层', () => {
    expect(detectMentionTrigger('看@原图，', 5)).toBeNull();
    expect(detectMentionTrigger('看@原图。继续', 6)).toBeNull();
    expect(detectMentionTrigger('看@原图', 3)).toEqual({ start: 1, query: '原' });
  });

  it('label 去空白成 token；超长截断（16 字上限 + 省略号，不压坏输入区）', () => {
    expect(mentionTokenOf('图 三')).toBe('图三');
    expect(mentionTokenOf('   ')).toBe('图片');
    expect(mentionTokenOf('a'.repeat(50)).length).toBeLessThanOrEqual(16);
    expect(mentionTokenOf('a'.repeat(50))).toBe(`${'a'.repeat(15)}…`);
    expect(mentionTokenOf('屏幕截图-2026-08-24-上午.png')).toBe('屏幕截图-2026-08-24…');
  });
});

describe('双图角色语义解析（图二 = 模板 / 图三 = 人物替换来源）', () => {
  const fig2 = mentionOf('图二', 'D:/imgs/图二.png', 'source_reference');
  const fig3 = mentionOf('图三', 'D:/imgs/图三.png', 'person_replacement_reference');

  it('例 1：「把 @图二 的人物换成 @图三」→ 图二=模板、图三=人物（explicit；面板同图时 origin=panel）', () => {
    const resolution = resolveImageMentionRoles({
      freeText: '把 @图二 的人物换成 @图三 的人物',
      mentions: [fig2, fig3],
      pool: scenarioPool,
    });
    expect(resolution.confidence).toBe('explicit');
    expect(resolution.template?.path).toBe('D:/imgs/图二.png');
    expect(resolution.template?.label).toBe('原图');
    expect(resolution.person?.path).toBe('D:/imgs/图三.png');
    // 面板人物 = 同一张图三：显式面板选择优先（值一致，来源标记为 panel）
    expect(resolution.person?.origin).toBe('panel');
  });

  it('例 2：「参考 @图二 的风格，把主角换成 @图三 这个女生」→ 同一映射', () => {
    const resolution = resolveImageMentionRoles({
      freeText: '参考 @图二 的风格，把主角换成 @图三 这个女生',
      mentions: [fig2, fig3],
      pool: scenarioPool,
    });
    expect(resolution.person?.path).toBe('D:/imgs/图三.png');
    expect(resolution.template?.path).toBe('D:/imgs/图二.png');
    expect(resolution.confidence).toBe('explicit');
  });

  it('例 3：「让 @图三 也生成成像 @图二 这样的动漫AI照片风」→ 像字句式识别模板', () => {
    const resolution = resolveImageMentionRoles({
      freeText: '让 @图三 也生成成像 @图二 这样的动漫AI照片风',
      mentions: [fig2, fig3],
      pool: scenarioPool,
    });
    expect(resolution.template?.path).toBe('D:/imgs/图二.png');
    expect(resolution.person?.path).toBe('D:/imgs/图三.png');
    expect(resolution.confidence).toBe('explicit');
  });

  it('例 4（自然语言，无 @）：「保留图二这种风格和构图，把里面的人换成图三」→ 序号 + 池推断', () => {
    // 面板未设置人物：图三以图库附加参考在池中（「图N」文件名标签匹配 + 动词后序号 = 人物）
    const poolNoPanel = buildVisionContextImages({
      sourcePath: 'D:/imgs/图二.png',
      extraReferences: [{ assetId: 'a3', path: 'D:/imgs/图三.png', label: '图三.png' }],
    });
    const resolution = resolveImageMentionRoles({
      freeText: '我想保留图二这种风格和构图，把里面的人换成图三',
      mentions: [],
      pool: poolNoPanel,
    });
    expect(resolution.confidence).toBe('inferred');
    expect(resolution.person?.path).toBe('D:/imgs/图三.png');
    expect(resolution.person?.origin).toBe('pool');
    expect(resolution.template?.path).toBe('D:/imgs/图二.png');
  });

  it('面板人物（显式选择）优先级最高：mention / 推断绝不覆盖', () => {
    const otherPerson = mentionOf('另一个人', 'D:/other.png', 'person_replacement_reference');
    const resolution = resolveImageMentionRoles({
      freeText: '把 @图二 的人物换成 @另一个人',
      mentions: [fig2, otherPerson],
      pool: scenarioPool, // 池内 person = 图三（面板显式选择）
    });
    expect(resolution.person?.origin).toBe('panel');
    expect(resolution.person?.path).toBe('D:/imgs/图三.png');
  });

  it('单 mention + 换人句式 → 该 mention 为人物来源，模板回落主参考图', () => {
    const resolution = resolveImageMentionRoles({
      freeText: '把画面主角换成 @图三',
      mentions: [fig3],
      pool: scenarioPool,
    });
    expect(resolution.person?.path).toBe('D:/imgs/图三.png');
    expect(resolution.template?.path).toBe('D:/imgs/图二.png');
  });

  it('无换人意图、单模板 mention → 只识别模板不产生 mention 语义人物', () => {
    const resolution = resolveImageMentionRoles({
      freeText: '照着 @图二 的风格画一张',
      mentions: [fig2],
      pool: scenarioPool,
    });
    expect(resolution.person?.origin).toBe('panel'); // 池内仍有面板人物，但不是 mention 语义
    expect(resolution.template?.origin).toBe('mention');
  });

  it('无任何线索 → confidence none（不瞎猜）', () => {
    const emptyPool = buildVisionContextImages({ sourcePath: 'D:/imgs/图二.png' });
    const resolution = resolveImageMentionRoles({
      freeText: '整体更梦幻一些',
      mentions: [],
      pool: emptyPool,
    });
    expect(resolution.confidence).toBe('none');
    expect(resolution.person).toBeUndefined();
  });

  it('建议态签名：模板 / 人物 / 置信度变化才变化', () => {
    const poolNoPanel = buildVisionContextImages({ sourcePath: 'D:/imgs/图二.png' });
    const a = resolveImageMentionRoles({ freeText: '把 @图二 的人物换成 @图三', mentions: [fig2, fig3], pool: scenarioPool });
    const b = resolveImageMentionRoles({ freeText: '照着 @图二 的风格画一张', mentions: [fig2], pool: poolNoPanel });
    expect(mentionSuggestionSignature(a)).not.toBe(mentionSuggestionSignature(b));
    expect(mentionSuggestionSignature(a)).toContain('explicit');
  });
});
