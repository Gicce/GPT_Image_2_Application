/**
 * IntentMentionInput（V4.0.9 → V4.1 @触发收口）——修改意图输入框的 @图片引用能力。
 *
 * 结构：原生 textarea（中文输入法安全，绝不引入富文本编辑器）
 *  + 背景高亮层（@token 渲染为品牌色 pill，排版与 textarea 完全一致）
 *  + @ 触发弹层（当前任务图片池：缩略图 + 名称 + 角色标签；键盘 ↑↓/Enter/Tab/Esc）
 *  + 已引用图片 chips 行（缩略图 + 角色标签；hover 看图、点击进全局 ImageViewer、× 移除）。
 *
 * 触发规则（caret-aware）：基于「光标前最近一个未完成的 @」判定（detectMentionTrigger），
 * 中文 CJK 前缀（根据@ / 把@）正常触发，仅拉丁字母 / 数字前缀（邮箱场景）拦截；
 * caret 点击 / 方向键移动后按新位置重检；query 出现空白 / 第二个 @ / 标点终止符即关闭。
 *
 * 语义边界（View State vs Semantic State 铁律）：
 *  - 弹层开关 / 上下选择 / Esc 关闭 / 点击外部关闭是纯视图操作，绝不写 store、绝不触发 semanticRevision；
 *  - 点击弹层外部只关浮层，不拦截该次点击（目标控件照常响应）；
 *  - 只有真实插入 mention（文本 + mentions 变化）才经 onChange / onMentionsChange 上抛语义修改。
 *  - IME 组合态（compositionstart/end + isComposing）不触发弹层键盘与检测，避免闪烁与拼音被拦。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CompositionEvent, KeyboardEvent } from 'react';
import { api } from '../../services/api';
import { useImageViewerStore } from '../../store/useImageViewerStore';
import {
  detectMentionTrigger,
  findMentionTokens,
  IMAGE_MENTION_ROLE_LABELS,
  insertMentionToken,
  mentionTokenOf,
  normalizeImagePath,
  pruneMentions,
  removeMentionToken,
  type ImageMention,
  type VisionContextImage,
} from './imageMention';
import { IMAGE_MENTION } from './recreationCopy';
import './IntentMentionInput.css';

export interface PendingGalleryImage {
  assetId?: string;
  path: string;
  label?: string;
}

interface IntentMentionInputProps {
  id?: string;
  value: string;
  mentions: ReadonlyArray<ImageMention>;
  pool: ReadonlyArray<VisionContextImage>;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  rows?: number;
  inputRef?: { current: HTMLTextAreaElement | null };
  onChange: (value: string) => void;
  onMentionsChange: (mentions: ImageMention[]) => void;
  onPickFromGallery: () => void;
  /** 图库选图回填（一次消费；组件在记忆的光标处插入 mention）。 */
  pendingGalleryImage?: PendingGalleryImage | null;
  onPendingGalleryImageConsumed?: () => void;
}

export default function IntentMentionInput(props: IntentMentionInputProps) {
  const {
    id, value, mentions, pool, disabled, placeholder, ariaLabel, rows = 4,
    inputRef, onChange, onMentionsChange, onPickFromGallery,
    pendingGalleryImage, onPendingGalleryImageConsumed,
  } = props;

  // ===== 纯视图状态（不落 store，绝不触发 semanticRevision） =====
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [flipUp, setFlipUp] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef(0);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  /** IME 组合态：拼音上屏期间不检测 / 不闪烁，组合结束按光标重检。 */
  const composingRef = useRef(false);

  const activeMentions = useMemo(() => pruneMentions(value, mentions), [value, mentions]);

  // 候选过滤（query 对 label / token / roleLabel 不区分大小写匹配）
  const candidates = useMemo<VisionContextImage[]>(() => {
    if (!trigger) return [];
    const query = trigger.query.toLowerCase();
    return pool.filter(image => {
      if (!query) return true;
      return image.label.toLowerCase().includes(query)
        || mentionTokenOf(image.label).toLowerCase().includes(query)
        || image.roleLabel.toLowerCase().includes(query);
    });
  }, [trigger, pool]);

  // 弹层开着加载全池缩略图；仅 chips 存在时只补引用中的图（本地重读，不持久化）
  useEffect(() => {
    const wantedPaths = trigger
      ? pool.map(image => image.path)
      : pool
        .filter(image => activeMentions.some(m => normalizeImagePath(m.path) === normalizeImagePath(image.path)))
        .map(image => image.path);
    const missing = wantedPaths.filter(path => !thumbs[path]);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const path of missing) {
        try { next[path] = await api.readThumbnail(path); } catch { /* 单图失败跳过 */ }
      }
      if (!cancelled) setThumbs(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // thumbs 只做去重快照，避免循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, pool, activeMentions]);

  // 打开 / 过滤变化时收敛选中索引
  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.start, trigger?.query]);

  // 弹层贴近视口底部时向上翻转（不超出 viewport）
  useEffect(() => {
    if (!trigger) return;
    const rect = popupRef.current?.getBoundingClientRect();
    setFlipUp(!!rect && rect.bottom > window.innerHeight && rect.top > rect.height);
  }, [trigger, candidates]);

  // 点击弹层外部：仅关闭浮层，不拦截该次点击（目标控件照常响应）
  useEffect(() => {
    if (!trigger) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (popupRef.current?.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      setTrigger(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [trigger]);

  const closePopup = () => { setTrigger(null); };

  const commitInsert = (image: VisionContextImage, start: number) => {
    const textarea = textareaRef.current;
    const caret = textarea ? textarea.selectionStart : caretRef.current;
    const inserted = insertMentionToken(value, caret, image, start);
    caretRef.current = inserted.caret;
    const samePath = (m: ImageMention) => normalizeImagePath(m.path) === normalizeImagePath(image.path);
    const nextMentions: ImageMention[] = mentions.some(samePath)
      ? mentions.map(m => (samePath(m) ? { ...m, token: inserted.token, role: image.role, label: image.label } : m))
      : [...mentions, {
        id: crypto.randomUUID(),
        assetId: image.assetId,
        path: image.path,
        label: image.label,
        token: inserted.token,
        role: image.role,
      }];
    setTrigger(null);
    onChange(inserted.text);
    onMentionsChange(nextMentions);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(inserted.caret, inserted.caret);
      }
    });
  };

  // 图库回填：在记忆光标处插入（一次消费）
  useEffect(() => {
    if (!pendingGalleryImage) return;
    onPendingGalleryImageConsumed?.();
    const image: VisionContextImage = {
      key: pendingGalleryImage.assetId ?? normalizeImagePath(pendingGalleryImage.path),
      assetId: pendingGalleryImage.assetId,
      path: pendingGalleryImage.path,
      label: pendingGalleryImage.label?.trim() || pendingGalleryImage.path.split(/[\\/]/).pop() || '图片',
      role: 'generic_reference',
      roleLabel: '图片引用',
      note: '从图片库加入当前任务的参考图',
    };
    commitInsert(image, caretRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGalleryImage]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    caretRef.current = event.target.selectionStart;
    onChange(event.target.value);
    // IME 组合中的拼音中间态不检测（避免弹层闪烁 / 过滤抖动），组合结束统一重检
    if (!composingRef.current) {
      setTrigger(detectMentionTrigger(event.target.value, event.target.selectionStart));
    }
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    const el = event.currentTarget;
    caretRef.current = el.selectionStart;
    setTrigger(detectMentionTrigger(el.value, el.selectionStart));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (!trigger || candidates.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(index => (index + 1) % candidates.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => (index - 1 + candidates.length) % candidates.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      commitInsert(candidates[activeIndex], trigger.start);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePopup();
    }
  };

  const handleScroll = () => {
    if (backdropRef.current && textareaRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const handleSelect = () => {
    const textarea = textareaRef.current;
    if (!textarea || composingRef.current) return;
    caretRef.current = textarea.selectionStart;
    // caret 移动（点击 / 方向键）后按新位置重检：处于待补全 @query → 开，否则关
    setTrigger(detectMentionTrigger(textarea.value, textarea.selectionStart));
  };

  // 背景高亮层内容：普通文本段 + @token pill 段（排版度量与 textarea 一致，无 padding 差异）
  const overlay = useMemo(() => {
    const tokens = findMentionTokens(value, activeMentions);
    const segments: Array<{ text: string; isToken: boolean }> = [];
    let cursor = 0;
    for (const match of tokens) {
      if (match.start > cursor) segments.push({ text: value.slice(cursor, match.start), isToken: false });
      segments.push({ text: value.slice(match.start, match.end), isToken: true });
      cursor = match.end;
    }
    if (cursor < value.length) segments.push({ text: value.slice(cursor), isToken: false });
    return segments;
  }, [value, activeMentions]);

  const removeMention = (mention: ImageMention) => {
    onChange(removeMentionToken(value, mention));
    onMentionsChange(mentions.filter(m => m.id !== mention.id));
  };

  const openMentionViewer = (mention: ImageMention) => {
    useImageViewerStore.getState().openViewer([{
      id: `mention-${mention.id}`,
      path: mention.path,
      title: IMAGE_MENTION.viewerTitle,
      fileName: mention.path.split(/[\\/]/).pop(),
      metadata: [{ label: '引用', value: `@${mention.token}` }],
    }], 0);
  };

  const thumbOf = (path: string): string => thumbs[path] ?? thumbs[normalizeImagePath(path)] ?? '';

  const renderBackdrop = () => {
    return (
      <div ref={backdropRef} className="vision-mention-backdrop" aria-hidden="true">
        {overlay.map((segment, i) => {
          if (segment.isToken) {
            return <span key={i} className="vision-mention-token">{segment.text}</span>;
          }
          return <span key={i}>{segment.text}</span>;
        })}
        {'\n '}
      </div>
    );
  };

  const renderPopup = () => {
    if (!trigger) return null;
    return (
      <div
        ref={popupRef}
        className={`vision-mention-popup${flipUp ? ' is-flipped' : ''}`}
        role="listbox"
        aria-label={IMAGE_MENTION.popupTitle}
      >
        <div className="vision-mention-popup-head">
          <span className="vision-mention-popup-title">{IMAGE_MENTION.popupTitle}</span>
          <span className="vision-mention-popup-hint">{IMAGE_MENTION.popupHint}</span>
        </div>
        <div className="vision-mention-popup-section">{IMAGE_MENTION.popupSectionTask}</div>
        {candidates.length === 0 && (
          <p className="vision-mention-popup-empty">{IMAGE_MENTION.popupEmpty}</p>
        )}
        {candidates.map((image, index) => {
          const thumb = thumbOf(image.path);
          return (
            <button
              key={image.key}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? 'vision-mention-option active' : 'vision-mention-option'}
              onMouseDown={event => {
                event.preventDefault();
                commitInsert(image, trigger.start);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {thumb
                ? <img className="vision-mention-option-thumb" src={thumb} alt="" />
                : <span className="vision-mention-option-thumb is-loading" aria-hidden="true" />}
              <span className="vision-mention-option-body">
                <span className="vision-mention-option-label">{image.label}</span>
                <span className="vision-mention-option-note">{image.note}</span>
              </span>
              <span className="vision-mention-option-role">{image.roleLabel}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="vision-mention-option vision-mention-option-gallery"
          onMouseDown={event => {
            event.preventDefault();
            closePopup();
            onPickFromGallery();
          }}
        >
          <span className="vision-mention-option-thumb is-plus" aria-hidden="true">＋</span>
          <span className="vision-mention-option-body">
            <span className="vision-mention-option-label">{IMAGE_MENTION.popupPickGallery}</span>
          </span>
        </button>
      </div>
    );
  };

  const renderChips = () => {
    if (activeMentions.length === 0) return null;
    return (
      <div className="vision-mention-chips" aria-label={IMAGE_MENTION.chipsLabel}>
        {activeMentions.map(mention => {
          const thumb = thumbOf(mention.path);
          return (
            <span key={mention.id} className="vision-mention-chip" title={mention.label}>
              {thumb
                ? <img src={thumb} alt={IMAGE_MENTION.chipAlt} onClick={() => openMentionViewer(mention)} />
                : <span className="vision-mention-chip-placeholder" onClick={() => openMentionViewer(mention)}>图</span>}
              <button
                type="button"
                className="vision-mention-chip-main"
                title={IMAGE_MENTION.chipsView}
                onClick={() => openMentionViewer(mention)}
              >
                <span className="vision-mention-chip-label">@{mention.label}</span>
                <span className="vision-mention-chip-role">{IMAGE_MENTION_ROLE_LABELS[mention.role]}</span>
              </button>
              <button
                type="button"
                className="vision-mention-chip-remove"
                title={IMAGE_MENTION.chipsRemove}
                disabled={disabled}
                onClick={() => removeMention(mention)}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="vision-mention-input">
      <div className="vision-mention-stage">
        {renderBackdrop()}
        <textarea
          id={id}
          ref={el => {
            textareaRef.current = el;
            if (inputRef) inputRef.current = el;
          }}
          className="vision-adjust-textarea vision-mention-textarea"
          rows={rows}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          onClick={handleSelect}
          onKeyUp={handleSelect}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
        />
      </div>
      {renderPopup()}
      {renderChips()}
    </div>
  );
}
