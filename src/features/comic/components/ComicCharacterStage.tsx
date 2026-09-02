/**
 * 角色确认阶段（V4.2.10「本期演员阵容」工作台重构，docs/ai-comic/18 审计）：
 *  - 页面结构：顶部演员阵容总览（roster + 完成计数 + 下一步条件）→ 必选演员分区 →
 *    可选演员分区；required 槽位 2 列网格，不再纵向全宽堆叠；
 *  - 角色卡（§四/§五/§六）：参考图 = 视觉中心（约 25%~30% 宽）；Reference Surface
 *    四态：空态（暂无角色参考图 + 生成/图库/上传入口）/ 生成中（真实任务事实）/
 *    失败（原位重试）/ 成图（点击进全局 ImageViewer，四宫参考图可放大细看）；
 *  - 锁定（§八/§九/§十）：单一 Primary [确认并锁定] + 复选项「保存到演员库，方便
 *    以后复用」（默认勾选）；不再并列两个语义接近的按钮；锁定后 Primary 消失，
 *    状态徽标区分「已锁定 · 已保存演员库 / 仅本项目」；
 *  - 折叠（§二十四/§二十五）：locked 默认 Compact 卡（[编辑角色] 再展开）；
 *    draft / generating / editing 保持展开；
 *  - 信息分层（§十一/§十二）：默认只有名字 / 定位 / 一句话设定 + 特征计数，
 *    固定特征 / 外观 Prompt / 负面约束全部收进「查看角色设定详情」折叠；
 *  - 业务链路零改动：draftComicCharacter / patchComicCharacter / lock / unlock /
 *    bind / unbind / 演员库 / Image2 参考图任务全部走原 domain 动作与页面唯一入口；
 *    在途状态查 comicCharactersSummaryState 单一事实源（§十一）。
 */

import { useEffect, useState } from 'react';
import { api } from '../../../services/api';
import { toastError, toastSuccess, toastWarning } from '../../../components/Toast';
import ImageLibraryPicker from '../../../components/ImageLibraryPicker';
import { useImageViewerStore } from '../../../store/useImageViewerStore';
import { draftComicCharacter, patchComicCharacter } from '../../../services/comicPlanner';
import { resolveModelForRole } from '../../aiRouting/resolveModelForRole';
import { newComicId, normalizeComicCharacter } from '../normalize';
import {
  applyComicCharacterPatches,
  attachCharacterReference,
  bindSlotCharacter,
  comicCharacterFromLibrary,
  comicCharacterToLibraryEntry,
  lockComicCharacter,
  COMIC_CHARACTER_LOCK_MISSING_REFERENCE,
  unbindSlot,
  unlockComicCharacter,
  upsertCharacterSnapshot,
  comicCharactersSummaryState,
  type ComicCharactersSummaryState,
  type ComicReferenceTaskState,
  type ComicSlotCharacterState,
} from '../domain';
import { useDebouncedDraftValue } from '../useComicUiDraft';
import type { ComicCharacter, ComicCharacterSlot, ComicProject, ComicUiDraft } from '../types';
import type { ComicCharacterSummary } from '../../../store/useComicStore';
import ComicActorDraftDialog from './ComicActorDraftDialog';
import ComicActorLibraryDialog from './ComicActorLibraryDialog';
import AIPlanningSurface from './AIPlanningSurface';
import type { ComicPlannerProgressStatus } from '../comicPlannerProgress';

export interface ComicCharacterStageProps {
  project: ComicProject;
  onPatch: (apply: (draft: ComicProject) => ComicProject) => void;
  /** 步骤 blockers（V4.2.10 起由阵容总览「还需要完成」承接展示，不再单独渲染横条）。 */
  blockers: string[];
  /** 步骤草稿写穿（页面层 → updateActive 只写 uiDraft，不参与阶段派生）。 */
  onDraft: (mutate: (uiDraft: ComicUiDraft) => ComicUiDraft) => void;
  /** 演员库（comic_characters）摘要，供槽位选角。 */
  libraryCharacters: ComicCharacterSummary[];
  /** 每角色最新参考图任务状态（页面从 comicTasks(kind='character_ref') 派生）。 */
  referenceTasks: Record<string, ComicReferenceTaskState>;
  /** 生成角色参考图（页面唯一入口：buildCharacterReferenceTask → createSeriesTask）。 */
  onGenerateReference: (character: ComicCharacter) => void;
  /**
   * V4.2.11 §B：一键补齐缺失参考图（所有已绑定但无参考图、无在途任务的角色，
   * 逐个独立提交；A 进行中不影响 B）。
   */
  onGenerateMissingRefs: () => void;
  /** 保存角色到演员库（页面接线 store.saveCharacter；返回是否成功）。 */
  onSaveToLibrary: (character: ComicCharacter) => Promise<boolean>;
  /** 引用即计数（§18）：从库选角成功后给库条目 +1 usageCount / 刷新 lastUsedAt。 */
  onRecordUsage: (id: string) => void;
}

/** per-slot 起草进度（§三：Record<slotId>，互不 disable）。 */
interface SlotDraftState {
  status: ComicPlannerProgressStatus;
  startedAt: number | null;
  errorText: string | null;
  modelLabel: string | null;
}

const IDLE_DRAFT: SlotDraftState = { status: 'idle', startedAt: null, errorText: null, modelLabel: null };

function slotBadgeTone(state: ComicSlotCharacterState): string {
  switch (state) {
    case 'locked': return 'is-locked';
    case 'ready':
    case 'confirmed': return 'is-ready';
    case 'ref_failed': return 'is-problem';
    case 'empty': return 'is-empty';
    default: return 'is-active';
  }
}

/** §16 参考图来源标签（按回写字段判定，不猜模型能力）。 */
function refSourceLabel(ref: { taskId?: string; imageId?: string; assetId?: string }): string {
  if (ref.taskId) return 'AI 生成';
  if (ref.imageId) return '图库';
  if (ref.assetId) return '上传';
  return '本地文件';
}

/** §22B/§22C 草稿命名缺省：文件名去扩展名。 */
function fileNameOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, '') || '未命名演员';
}

/** 阵容总览/Compact 卡头像缺省：角色名首字。 */
function avatarInitial(name: string): string {
  return name.trim().slice(0, 1) || '角';
}

export default function ComicCharacterStage(props: ComicCharacterStageProps) {
  const { project } = props;
  const skill = project.skillSnapshot;
  // §三：per-slot 起草状态（角色 A 起草不影响角色 B 按钮）
  const [drafting, setDrafting] = useState<Record<string, SlotDraftState>>({});
  /** 图库选择意图：ref-swap = 给当前角色换参考图；library-add = §22B 从图库添加演员。 */
  const [pickerIntent, setPickerIntent] = useState<{ kind: 'ref-swap'; slotId: string } | { kind: 'library-add' } | null>(null);
  /** 演员库弹窗：select = 槽位选角；browse = §27 [查看演员库] 只读浏览。 */
  const [libraryView, setLibraryView] = useState<{ mode: 'select'; slotId: string } | { mode: 'browse' } | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  /** §22B/§22C Library Character Draft：图片选定后命名入库。 */
  const [draftEntry, setDraftEntry] = useState<{
    source: 'gallery' | 'upload';
    path: string;
    assetId?: string;
    defaultName: string;
  } | null>(null);
  const [draftPreview, setDraftPreview] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  // §30/§85：微调输入草稿（防抖写穿 uiDraft.character.patchTexts；卸载冲刷由 Hook 保证）
  const [patchText, setPatchText] = useDebouncedDraftValue<Record<string, string>>(
    () => project.uiDraft?.character?.patchTexts ?? {},
    value => {
      const kept = Object.fromEntries(Object.entries(value).filter(([, text]) => text));
      props.onDraft(draft => {
        if (Object.keys(kept).length === 0) {
          const rest = { ...draft };
          delete rest.character;
          return rest;
        }
        return { ...draft, character: { patchTexts: kept } };
      });
    },
  );
  const [patchBusy, setPatchBusy] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<Record<string, string | null>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // §二十五：视图状态（锁定折叠 / 编辑展开；纯 view state，不进业务对象）
  const [expandedSlots, setExpandedSlots] = useState<Record<string, boolean>>({});
  /** §九：锁定时的入库偏好（characterId → 是否保存演员库；缺省 true 勾选）。 */
  const [savePrefs, setSavePrefs] = useState<Record<string, boolean>>({});
  /** §十：本会话锁定事实（characterId → 锁定时是否入库成功），驱动「已锁定 · 已保存演员库」。 */
  const [lockedSaved, setLockedSaved] = useState<Record<string, boolean>>({});

  // §十一：槽位状态 / 徽标 / 阻塞原因单一事实源（禁止组件自拼）
  const slotsSummary: ComicCharactersSummaryState = comicCharactersSummaryState(project, props.referenceTasks);
  const refsRequired = skill.referenceStrategy.characterRefs === 'required';

  // §三/§十五：必选 / 可选分区 + 总览计数
  const requiredSlots = skill.characterSlots.filter(slot => slot.required);
  const optionalSlots = skill.characterSlots.filter(slot => !slot.required);
  const optionalDone = optionalSlots.filter(slot => {
    const view = slotsSummary.slots.find(item => item.slotId === slot.slotId);
    return view?.state === 'locked' && !view.blocker;
  }).length;
  const lockedCount = slotsSummary.slots.filter(slot => slot.state === 'locked' && !slot.blocker).length;

  // §22B/§22C 草稿预览：选定图片后懒读缩略（失败显示占位，不阻塞命名）
  useEffect(() => {
    if (!draftEntry) {
      setDraftPreview(null);
      return;
    }
    let alive = true;
    void api.readThumbnail(draftEntry.path)
      .then(data => { if (alive) setDraftPreview(data); })
      .catch(() => { if (alive) setDraftPreview(null); });
    return () => { alive = false; };
  }, [draftEntry]);

  useEffect(() => {
    let alive = true;
    const paths = new Map<string, string>();
    for (const character of project.characterSnapshots) {
      if (character.referenceImage) paths.set(character.id, character.referenceImage.path);
    }
    if (paths.size === 0) return;
    void Promise.all([...paths.entries()].map(async ([id, path]) => {
      try {
        return [id, await api.readThumbnail(path)] as const;
      } catch {
        return [id, ''] as const;
      }
    })).then(entries => {
      if (!alive) return;
      setThumbs(Object.fromEntries(entries.filter(([, data]) => data)));
    });
    return () => { alive = false; };
  }, [project.characterSnapshots]);

  const characterOfSlot = (slotId: string): ComicCharacter | null => {
    const characterId = project.characterBindings[slotId];
    if (!characterId) return null;
    return project.characterSnapshots.find(item => item.id === characterId) ?? null;
  };

  const setDraft = (slotId: string, patch: Partial<SlotDraftState>) => {
    setDrafting(prev => ({ ...prev, [slotId]: { ...IDLE_DRAFT, ...prev[slotId], ...patch } }));
  };

  const runDraft = async (slotId: string) => {
    // §二/§十二：真实 resolved 模型预显（只读，不暴露 Key/Base URL/Token）
    const resolution = resolveModelForRole('comic_planner');
    const previewModel = resolution.ok ? resolution.resolved.displayName : null;
    if (!resolution.ok) {
      setDraft(slotId, { status: 'failed', errorText: resolution.error, modelLabel: null });
      return;
    }
    setDraft(slotId, {
      status: 'resolving',
      startedAt: Date.now(),
      errorText: null,
      modelLabel: previewModel,
    });
    try {
      const outcome = await draftComicCharacter({
        skill,
        slotId,
        onStage: stage => setDraft(slotId, { status: stage, modelLabel: previewModel }),
      });
      if (!outcome.ok) {
        setDraft(slotId, { status: 'failed', errorText: outcome.error, modelLabel: previewModel });
        return;
      }
      const character = normalizeComicCharacter(outcome.character);
      if (!character) {
        setDraft(slotId, { status: 'failed', errorText: '起草的角色缺少名字，请重试', modelLabel: previewModel });
        return;
      }
      props.onPatch(draft => bindSlotCharacter(draft, slotId, character));
      setDraft(slotId, { status: 'completed', modelLabel: outcome.modelName });
      toastSuccess(`已为槽位起草角色「${character.name}」`);
    } catch (err) {
      setDraft(slotId, {
        status: 'failed',
        errorText: err instanceof Error ? err.message : '角色起草失败，请重试',
        modelLabel: previewModel,
      });
    }
  };

  const loadCharacterDoc = async (item: ComicCharacterSummary): Promise<ComicCharacter | null> => {
    const raw = await api.loadComicCharacter(item.id);
    if (!raw) return null;
    return normalizeComicCharacter(JSON.parse(raw) as ComicCharacter);
  };

  const pickFromLibrary = async (item: ComicCharacterSummary) => {
    if (!libraryView || libraryView.mode !== 'select') return;
    setLibraryBusy(true);
    try {
      const loaded = await loadCharacterDoc(item);
      if (!loaded) {
        toastError('演员库文档读取失败');
        return;
      }
      // §21：复用 = 深拷贝快照入项目，库计数不随快照走；§18：引用即计数（只写库条目）
      const character = comicCharacterFromLibrary(loaded);
      props.onPatch(draft => bindSlotCharacter(draft, libraryView.slotId, character));
      props.onRecordUsage(item.id);
      toastSuccess(`已让「${character.name}」出演`);
      setLibraryView(null);
    } catch (err) {
      toastError(err instanceof Error ? err.message : '演员选择失败');
    } finally {
      setLibraryBusy(false);
    }
  };

  const runPatch = async (character: ComicCharacter) => {
    const text = (patchText[character.id] ?? '').trim();
    if (!text) {
      setPatchError(prev => ({ ...prev, [character.id]: '请先填写角色调整要求' }));
      return;
    }
    setPatchBusy(character.id);
    setPatchError(prev => ({ ...prev, [character.id]: null }));
    try {
      const outcome = await patchComicCharacter({ character, instruction: text });
      if (!outcome.ok) {
        setPatchError(prev => ({ ...prev, [character.id]: outcome.error }));
        return;
      }
      const application = applyComicCharacterPatches(character, outcome.patches);
      props.onPatch(draft => upsertCharacterSnapshot(draft, application.character));
      if (application.applied.length > 0) {
        setPatchText(prev => ({ ...prev, [character.id]: '' }));
        toastSuccess(
          application.character.referenceStale
            ? `已应用 ${application.applied.length} 处修改；角色设定已变，参考图需要重新生成`
            : `已应用 ${application.applied.length} 处修改`,
        );
      } else {
        setPatchError(prev => ({ ...prev, [character.id]: '本次调整没有命中可修改的字段，请换一种说法' }));
      }
    } catch (err) {
      setPatchError(prev => ({
        ...prev,
        [character.id]: err instanceof Error ? err.message : '角色调整失败，请重试',
      }));
    } finally {
      setPatchBusy(null);
    }
  };

  /**
   * 锁定（§八/§九 V4.2.10：单一 Primary + 入库复选项）：
   *  - [确认并锁定] = 锁定；勾选「保存到演员库」时同步入库（toast 带 [查看演员库]）；
   *  - 未勾选 = 仅本项目锁定，toast「角色已锁定，仅用于当前漫画。」
   *  - 锁定成功后该卡收起为 Compact（§二十四）。
   */
  const tryLock = async (character: ComicCharacter, saveToLibrary: boolean) => {
    // §五/§八：技能要求参考图时无参考图不得锁定（domain 二次防御 + UI 原位提示）
    if (refsRequired && !character.referenceImage) {
      toastError(COMIC_CHARACTER_LOCK_MISSING_REFERENCE);
      return;
    }
    try {
      const locked = lockComicCharacter(character, { requireReference: refsRequired });
      props.onPatch(draft => upsertCharacterSnapshot(draft, locked));
      if (saveToLibrary) {
        const saved = await props.onSaveToLibrary(comicCharacterToLibraryEntry(locked));
        if (saved) {
          setLockedSaved(prev => ({ ...prev, [character.id]: true }));
          toastSuccess(`角色「${character.name}」已锁定，并已保存到演员库`, undefined, {
            label: '查看演员库',
            onClick: () => setLibraryView({ mode: 'browse' }),
          });
        } else {
          toastWarning('角色已锁定；演员库保存失败，可稍后在卡片上重新保存');
        }
      } else {
        setLockedSaved(prev => ({ ...prev, [character.id]: false }));
        toastSuccess(`角色「${character.name}」已锁定，仅用于当前漫画。`);
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : COMIC_CHARACTER_LOCK_MISSING_REFERENCE);
    }
  };

  /** §22A 卡片 [保存到演员库]（快照语义：入库不回写项目）。 */
  const saveToLibrary = async (character: ComicCharacter) => {
    const saved = await props.onSaveToLibrary(comicCharacterToLibraryEntry(character));
    if (saved) {
      setLockedSaved(prev => ({ ...prev, [character.id]: true }));
      toastSuccess(`「${character.name}」已保存到演员库，以后的新漫画可以直接选 TA`);
    } else {
      toastWarning('演员库保存失败，请稍后重试');
    }
  };

  /** §二十三：参考图点击进全局 ImageViewer（查看器自读完整图，组件只传 path）。 */
  const openReferenceView = (character: ComicCharacter) => {
    if (!character.referenceImage) return;
    useImageViewerStore.getState().openViewer([{
      id: character.id,
      path: character.referenceImage.path,
      title: `${character.name} · 角色参考图`,
      fileName: fileNameOf(character.referenceImage.path),
    }]);
  };

  /** §五/§22C 空态 [上传参考图]：本地图片走图库导入管道后绑定为该角色参考图（只引用；导入结果无资产 ID 时回落原始路径）。 */
  const uploadReferenceFor = async (character: ComicCharacter) => {
    try {
      const path = await api.selectImageFile();
      if (!path) return;
      const imported = await api.importImagesToLibrary([path])
        .then(result => result.imported[0] ?? null)
        .catch(() => null);
      props.onPatch(draft => upsertCharacterSnapshot(draft, attachCharacterReference(character, {
        path: imported?.local_path ?? path,
        label: character.name,
      })));
      toastSuccess('参考图已绑定');
    } catch (err) {
      toastError(err instanceof Error ? err.message : '读取本地图片失败');
    }
  };

  /** §八：解锁回到待确认，同时展开编辑（视图操作）。 */
  const unlockAndExpand = (slotId: string, character: ComicCharacter) => {
    setExpandedSlots(prev => ({ ...prev, [slotId]: true }));
    props.onPatch(draft => upsertCharacterSnapshot(draft, unlockComicCharacter(character)));
  };

  /** §23 当前项目第一个已锁定角色（空态「保存当前〈名〉到演员库」的目标）。 */
  const lockedCharacter = project.characterSnapshots.find(item => item.status === 'locked') ?? null;

  /** §23 空态 [AI 创建一个]：关弹窗 → 起草第一个空槽（browse 模式没有目标槽时回落首槽）。 */
  const quickDraftSlotId = skill.characterSlots.find(slot => !project.characterBindings[slot.slotId])?.slotId
    ?? skill.characterSlots[0]?.slotId;
  const quickCreateAi = () => {
    setLibraryView(null);
    if (quickDraftSlotId) void runDraft(quickDraftSlotId);
  };

  /** §22B [从图库添加演员]：关库弹窗 → 打开图库选择器（library-add 意图）。 */
  const addFromGallery = () => {
    setLibraryView(null);
    setPickerIntent({ kind: 'library-add' });
  };

  /** §22C [上传演员参考图]：本地文件 → 走图库导入管道成受管资产（失败回落原始路径引用）。 */
  const uploadReference = async () => {
    setLibraryView(null);
    try {
      const path = await api.selectImageFile();
      if (!path) return;
      const imported = await api.importImagesToLibrary([path])
        .then(result => result.imported[0] ?? null)
        .catch(() => null);
      setDraftEntry({
        source: 'upload',
        path: imported?.local_path ?? path,
        defaultName: fileNameOf(imported?.local_path ?? path),
      });
    } catch (err) {
      toastError(err instanceof Error ? err.message : '读取本地图片失败');
    }
  };

  /** §22B/§22C 草稿入库：图片只引用（§25），名称 + 一句话设定构成 Library Character Draft。 */
  const saveDraftEntry = async (input: { name: string; description: string }) => {
    if (!draftEntry) return;
    setDraftBusy(true);
    try {
      const now = new Date().toISOString();
      const entry: ComicCharacter = {
        id: newComicId('char'),
        name: input.name,
        description: input.description,
        role: '辅助角色',
        source: draftEntry.source,
        referenceImage: {
          path: draftEntry.path,
          ...(draftEntry.assetId ? { assetId: draftEntry.assetId } : {}),
          label: input.name,
        },
        appearance: input.description,
        immutableTraits: [],
        mutableTraits: [],
        negativeConstraints: [],
        status: 'confirmed',
        createdAt: now,
        updatedAt: now,
      };
      const saved = await props.onSaveToLibrary(entry);
      if (saved) {
        toastSuccess(`已把「${input.name}」收进演员库`);
        setDraftEntry(null);
      } else {
        toastWarning('演员库保存失败，请稍后重试');
      }
    } finally {
      setDraftBusy(false);
    }
  };

  // ===== V4.2.11 §B：一键补齐缺失参考图的目标（已绑定 + 无参考图 + 无在途任务） =====
  const missingRefCharacters = skill.characterSlots
    .map(slot => characterOfSlot(slot.slotId))
    .filter((character): character is ComicCharacter => character !== null)
    .filter(character =>
      !character.referenceImage
      && props.referenceTasks[character.id]?.status !== 'queued'
      && props.referenceTasks[character.id]?.status !== 'running');

  // ===== 阵容总览 roster 行（槽位顺序 = 技能槽位顺序） =====
  const renderRosterRow = (slot: ComicCharacterSlot) => {
    const character = characterOfSlot(slot.slotId);
    const slotView = slotsSummary.slots.find(item => item.slotId === slot.slotId);
    const label = !slot.required && !character ? '可选' : (slotView?.label ?? '未绑定');
    return (
      <li className="comic-cast-roster-row" data-testid={`comic-cast-roster-${slot.slotId}`} key={slot.slotId}>
        {character && thumbs[character.id]
          ? <img className="comic-cast-avatar" src={thumbs[character.id]} alt={character.name} />
          : <span className="comic-cast-avatar comic-cast-avatar-empty" aria-hidden>
              {character ? avatarInitial(character.name) : '＋'}
            </span>}
        <div className="comic-cast-roster-info">
          <strong>{character?.name ?? slot.name}</strong>
          <span className="comic-muted">
            {slot.name}
            {character?.role ? ` · ${character.role}` : ''}
            {slot.required ? '' : ' · 可选'}
          </span>
        </div>
        <span className={`comic-slot-badge ${slotBadgeTone(slotView?.state ?? 'empty')}`}>
          {label}
        </span>
      </li>
    );
  };

  // ===== 未绑定槽位：必选 = 完整空槽卡；可选 = Compact Add Card（§十六） =====
  const renderEmptySlotCard = (slot: ComicCharacterSlot, required: boolean) => {
    const draftState = drafting[slot.slotId] ?? IDLE_DRAFT;
    const draftRunning = draftState.status !== 'idle' && draftState.status !== 'completed' && draftState.status !== 'failed';
    if (!required) {
      return (
        <section className="comic-card comic-cast-add-card" data-testid={`comic-cast-add-${slot.slotId}`} key={slot.slotId}>
          <div className="comic-cast-add-info">
            <strong>{slot.name}</strong>
            <span className="comic-muted">可选角色{slot.displayRule ? ` · ${slot.displayRule}` : ''}</span>
          </div>
          <div className="comic-actions-row">
            <button
              type="button"
              className="app-btn app-btn-primary app-btn-sm"
              disabled={draftRunning}
              data-testid={`comic-draft-${slot.slotId}`}
              onClick={() => void runDraft(slot.slotId)}
            >
              AI 起草
            </button>
            <button
              type="button"
              className="app-btn app-btn-secondary app-btn-sm"
              disabled={libraryBusy}
              onClick={() => setLibraryView({ mode: 'select', slotId: slot.slotId })}
            >
              从演员库选择
            </button>
          </div>
          {draftState.status !== 'idle' && (
            <AIPlanningSurface
              title="AI 正在起草角色"
              status={draftState.status}
              startedAt={draftState.startedAt}
              modelLabel={draftState.modelLabel}
              errorText={draftState.errorText}
              onRetry={draftState.status === 'failed' ? () => void runDraft(slot.slotId) : undefined}
              retryLabel="重新起草"
              inline
            />
          )}
        </section>
      );
    }
    return (
      <section className="comic-card comic-character-card comic-slot-empty" data-testid={`comic-slot-card-${slot.slotId}`} key={slot.slotId}>
        <header className="comic-character-head">
          <div>
            <h4 className="comic-card-title">{slot.name}</h4>
            {slot.displayRule && <p className="comic-muted">{slot.displayRule}</p>}
          </div>
          <span className="comic-slot-badge is-empty">未绑定</span>
        </header>
        <div className="comic-actions-row">
          <button
            type="button"
            className="app-btn app-btn-primary app-btn-sm"
            disabled={draftRunning}
            data-testid={`comic-draft-${slot.slotId}`}
            onClick={() => void runDraft(slot.slotId)}
          >
            AI 起草演员
          </button>
          <button
            type="button"
            className="app-btn app-btn-secondary app-btn-sm"
            disabled={libraryBusy}
            onClick={() => setLibraryView({ mode: 'select', slotId: slot.slotId })}
          >
            从演员库选择
          </button>
        </div>
        {draftState.status !== 'idle' && (
          <AIPlanningSurface
            title="AI 正在起草角色"
            status={draftState.status}
            startedAt={draftState.startedAt}
            modelLabel={draftState.modelLabel}
            errorText={draftState.errorText}
            onRetry={draftState.status === 'failed' ? () => void runDraft(slot.slotId) : undefined}
            retryLabel="重新起草"
            inline
          />
        )}
      </section>
    );
  };

  // ===== 已绑定角色卡（展开 / Compact，§四/§二十四） =====
  const renderCharacterCard = (slot: ComicCharacterSlot) => {
    const character = characterOfSlot(slot.slotId);
    if (!character) return renderEmptySlotCard(slot, slot.required);
    const slotView = slotsSummary.slots.find(item => item.slotId === slot.slotId);
    const draftState = drafting[slot.slotId] ?? IDLE_DRAFT;
    const draftRunning = draftState.status !== 'idle' && draftState.status !== 'completed' && draftState.status !== 'failed';
    const refTask = props.referenceTasks[character.id];
    const refBusy = refTask?.status === 'queued' || refTask?.status === 'running';
    const refFailed = refTask?.status === 'failed' && !character.referenceImage;
    const lockDisabledReason = refsRequired && !character.referenceImage
      ? COMIC_CHARACTER_LOCK_MISSING_REFERENCE
      : character.referenceStale
        ? '角色设定已修改，请先重新生成参考图'
        : null;
    // §二十五：draft / generating / editing 展开；locked 默认 Compact（编辑角色再展开）
    const legacyLockedMissingRef = refsRequired && !character.referenceImage;
    const expanded = character.status !== 'locked' || expandedSlots[slot.slotId] === true || legacyLockedMissingRef;
    const savePref = savePrefs[character.id] ?? true;
    const savedNote = lockedSaved[character.id] === true
      ? ' · 已保存演员库'
      : lockedSaved[character.id] === false
        ? ' · 仅本项目'
        : '';

    return (
      <section
        className={`comic-card comic-character-card${character.status === 'locked' ? ' is-locked' : ''}`}
        data-testid={`comic-character-card-${slot.slotId}`}
        key={slot.slotId}
      >
        {!expanded ? (
          <div className="comic-character-compact" data-testid={`comic-character-compact-${slot.slotId}`}>
            {thumbs[character.id]
              ? <img className="comic-compact-thumb" src={thumbs[character.id]} alt={character.name} />
              : <span className="comic-compact-thumb comic-ref-thumb-placeholder" aria-hidden>{avatarInitial(character.name)}</span>}
            <div className="comic-compact-info">
              <strong>{character.name}</strong>
              <span className="comic-muted">{slot.name} · {slot.required ? '必选' : '可选'} · 已锁定 ✓{savedNote}</span>
              <span className="comic-compact-summary" title={character.description || character.appearance || undefined}>
                {character.description || character.appearance || ''}
              </span>
            </div>
            <button
              type="button"
              className="app-btn app-btn-secondary app-btn-sm"
              data-testid={`comic-edit-character-${slot.slotId}`}
              onClick={() => setExpandedSlots(prev => ({ ...prev, [slot.slotId]: true }))}
            >
              编辑角色
            </button>
          </div>
        ) : (
          <>
            <header className="comic-character-head">
              <div className="comic-hero-head">
                <strong className="comic-hero-name">{character.name}</strong>
                <span className="comic-hero-role">{character.role}</span>
              </div>
              {slotView && (
                <span className={`comic-slot-badge ${slotBadgeTone(slotView.state)}`} data-testid={`comic-slot-badge-${slot.slotId}`}>
                  {slotView.label}
                </span>
              )}
            </header>
            <p className="comic-cast-slotline comic-muted">
              {slot.name} · {slot.required ? '必选' : '可选'}
              {slot.displayRule ? ` · ${slot.displayRule}` : ''}
            </p>

            <div className="comic-character-body comic-character-hero">
              {/* §五/§六：参考图 = 视觉中心；Reference Surface 四态（空/生成中/失败/成图） */}
              <div className="comic-hero-figure" data-testid={`comic-ref-${slot.slotId}`}>
                <span className="comic-ref-title">角色参考图</span>
                {character.referenceStale && character.referenceImage && (
                  <div className="comic-ref-stale-banner" data-testid={`comic-ref-stale-${slot.slotId}`}>
                    角色设定已修改，参考图需要重新生成
                  </div>
                )}
                {refBusy ? (
                  <div className="comic-ref-busy" data-testid={`comic-ref-busy-${slot.slotId}`}>
                    <span className="comic-ref-busy-thumb" aria-hidden />
                    <p className="comic-ref-busy-title">正在生成角色参考图</p>
                    <p className="comic-ref-busy-meta">任务已提交，进度见任务队列</p>
                  </div>
                ) : refFailed ? (
                  <div className="comic-ref-failed" data-testid={`comic-ref-failed-${slot.slotId}`}>
                    <p>参考图生成失败，请重试</p>
                    <button
                      type="button"
                      className="app-btn app-btn-primary app-btn-sm"
                      onClick={() => props.onGenerateReference(character)}
                    >
                      重新生成参考图
                    </button>
                  </div>
                ) : character.referenceImage && thumbs[character.id] ? (
                  <button
                    type="button"
                    className="comic-ref-view"
                    data-testid={`comic-ref-view-${slot.slotId}`}
                    title={`查看 ${character.name} 的角色参考图（点击放大）`}
                    onClick={() => openReferenceView(character)}
                  >
                    <img className="comic-hero-thumb" src={thumbs[character.id]} alt={`${character.name} 角色参考图`} />
                  </button>
                ) : character.referenceImage ? (
                  <span className="comic-hero-thumb comic-ref-thumb-placeholder">读取中…</span>
                ) : (
                  <div className="comic-ref-empty" data-testid={`comic-ref-empty-${slot.slotId}`}>
                    <p className="comic-ref-empty-title">暂无角色参考图</p>
                    <div className="comic-ref-actions">
                      <button
                        type="button"
                        className="app-btn app-btn-primary app-btn-sm"
                        disabled={refBusy}
                        data-testid={`comic-generate-ref-${slot.slotId}`}
                        onClick={() => props.onGenerateReference(character)}
                      >
                        生成参考图
                      </button>
                    </div>
                    <div className="comic-ref-actions">
                      <button
                        type="button"
                        className="app-btn app-btn-secondary app-btn-sm"
                        disabled={libraryBusy}
                        onClick={() => setLibraryView({ mode: 'select', slotId: slot.slotId })}
                      >
                        从演员库选择
                      </button>
                      <button
                        type="button"
                        className="app-btn app-btn-secondary app-btn-sm"
                        onClick={() => setPickerIntent({ kind: 'ref-swap', slotId: slot.slotId })}
                      >
                        从图库选择
                      </button>
                      <button
                        type="button"
                        className="app-btn app-btn-secondary app-btn-sm"
                        onClick={() => void uploadReferenceFor(character)}
                      >
                        上传参考图
                      </button>
                    </div>
                  </div>
                )}
                {character.referenceImage && !refBusy && !refFailed && (
                  <>
                    <div className="comic-ref-actions">
                      <button
                        type="button"
                        className="app-btn app-btn-secondary app-btn-sm"
                        disabled={refBusy || character.status === 'locked'}
                        title={character.status === 'locked' ? '已锁定角色不能更换参考图，先解锁' : undefined}
                        data-testid={`comic-regen-ref-${slot.slotId}`}
                        onClick={() => props.onGenerateReference(character)}
                      >
                        重新生成
                      </button>
                      <button
                        type="button"
                        className="app-btn app-btn-secondary app-btn-sm"
                        disabled={libraryBusy}
                        onClick={() => setLibraryView({ mode: 'select', slotId: slot.slotId })}
                      >
                        从演员库选择
                      </button>
                      <button
                        type="button"
                        className="app-btn app-btn-secondary app-btn-sm"
                        disabled={character.status === 'locked'}
                        title={character.status === 'locked' ? '已锁定角色不能更换参考图，先解锁' : undefined}
                        onClick={() => setPickerIntent({ kind: 'ref-swap', slotId: slot.slotId })}
                      >
                        从图库换图
                      </button>
                    </div>
                    <span className="comic-ref-meta">
                      来源：{refSourceLabel(character.referenceImage)}
                      {character.referenceImage.assetId ? ` · 资产 ${character.referenceImage.assetId.slice(0, 8)}` : ''}
                    </span>
                  </>
                )}
              </div>

              <div className="comic-character-facts">
                {/* §十一：默认只有 一句话设定 + 特征计数；其余进「查看角色设定详情」折叠 */}
                <p className="comic-hero-summary" title={character.description || character.appearance || undefined}>
                  {character.description || character.appearance || '还没有一句话设定，可在下方微调里补一句'}
                </p>
                {(character.immutableTraits.length > 0 || character.mutableTraits.length > 0) && (
                  <p className="comic-cast-traits" data-testid={`comic-cast-traits-${slot.slotId}`}>
                    固定特征 {character.immutableTraits.length} 项
                    {character.mutableTraits.length > 0 ? ` · 可变特征 ${character.mutableTraits.length} 项` : ''}
                  </p>
                )}
                <div className="form-group comic-character-patch">
                  <label htmlFor={`patch-${slot.slotId}`}>微调「{character.name}」</label>
                  <textarea
                    id={`patch-${slot.slotId}`}
                    rows={2}
                    placeholder="例：耳朵再圆一点，加一副圆框眼镜"
                    value={patchText[character.id] ?? ''}
                    onChange={e => setPatchText(prev => ({ ...prev, [character.id]: e.target.value }))}
                  />
                  {patchError[character.id] && (
                    <div className="comic-inline-error" data-testid={`comic-patch-error-${slot.slotId}`}>
                      <p>{patchError[character.id]}</p>
                    </div>
                  )}
                </div>
                <div className="comic-actions-row">
                  <button
                    type="button"
                    className="app-btn app-btn-secondary app-btn-sm"
                    disabled={patchBusy === character.id || character.status === 'locked'}
                    title={character.status === 'locked' ? '已锁定角色不能修改设定，先解锁' : undefined}
                    onClick={() => void runPatch(character)}
                  >
                    {patchBusy === character.id ? '调整中…' : '应用调整'}
                  </button>
                </div>

                {character.status !== 'locked' ? (
                  <div className="comic-character-lockrow">
                    <label className="comic-lock-pref">
                      <input
                        type="checkbox"
                        checked={savePref}
                        data-testid={`comic-save-pref-${slot.slotId}`}
                        onChange={e => setSavePrefs(prev => ({ ...prev, [character.id]: e.target.checked }))}
                      />
                      <span>保存到演员库，方便以后复用</span>
                    </label>
                    <p className="comic-lock-pref-hint">{savePref ? '锁定后写入演员库，新建漫画可以直接选 TA' : '不勾选则仅本项目锁定（不进演员库）'}</p>
                    <div className="comic-actions-row">
                      <button
                        type="button"
                        className="app-btn app-btn-primary app-btn-sm"
                        disabled={Boolean(lockDisabledReason)}
                        title={lockDisabledReason ?? (savePref ? '锁定并保存到演员库，以后的新漫画可以直接复用' : '只锁定当前漫画，不进演员库')}
                        data-testid={`comic-lock-${slot.slotId}`}
                        onClick={() => void tryLock(character, savePref)}
                      >
                        确认并锁定
                      </button>
                      {lockDisabledReason && (
                        <span className="comic-lock-reason" data-testid={`comic-lock-reason-${slot.slotId}`}>
                          {lockDisabledReason}
                        </span>
                      )}
                      <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => props.onPatch(draft => unbindSlot(draft, slot.slotId))}>
                        换人
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="comic-character-lockrow">
                    <p className="comic-locked-note" data-testid={`comic-locked-note-${slot.slotId}`}>
                      已锁定{savedNote || ' ✓'}
                    </p>
                    <div className="comic-actions-row">
                      <button
                        type="button"
                        className="app-btn app-btn-secondary app-btn-sm"
                        data-testid={`comic-unlock-${slot.slotId}`}
                        onClick={() => unlockAndExpand(slot.slotId, character)}
                      >
                        解锁修改
                      </button>
                      {character.referenceImage && (
                        <button
                          type="button"
                          className="app-btn app-btn-secondary app-btn-sm"
                          data-testid={`comic-save-library-${slot.slotId}`}
                          onClick={() => void saveToLibrary(character)}
                        >
                          保存到演员库
                        </button>
                      )}
                      <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => props.onPatch(draft => unbindSlot(draft, slot.slotId))}>
                        换人
                      </button>
                    </div>
                  </div>
                )}

                {/* §十二：固定特征 / 外观 Prompt / 负面约束默认折叠（要看得懂才展开） */}
                {(character.immutableTraits.length > 0 || character.mutableTraits.length > 0
                  || character.defaultClothing || character.negativeConstraints.length > 0 || character.appearance) && (
                  <details className="comic-advanced-card comic-character-advanced">
                    <summary>查看角色设定详情</summary>
                    {character.appearance && <p className="comic-muted">外观：{character.appearance}</p>}
                    {character.immutableTraits.length > 0 && <p className="comic-muted">跨格不变：{character.immutableTraits.join('、')}</p>}
                    {character.mutableTraits.length > 0 && <p className="comic-muted">可变：{character.mutableTraits.join('、')}</p>}
                    {character.defaultClothing && <p className="comic-muted">默认服装：{character.defaultClothing}</p>}
                    {character.negativeConstraints.length > 0 && <p className="comic-muted">禁止：{character.negativeConstraints.join('、')}</p>}
                  </details>
                )}
              </div>
            </div>

            {draftState.status !== 'idle' && (
              <AIPlanningSurface
                title="AI 正在起草角色"
                status={draftState.status}
                startedAt={draftState.startedAt}
                modelLabel={draftState.modelLabel}
                errorText={draftState.errorText}
                onRetry={draftState.status === 'failed' ? () => void runDraft(slot.slotId) : undefined}
                retryLabel="重新起草"
                inline
              />
            )}
          </>
        )}
      </section>
    );
  };

  return (
    <div className="comic-stage comic-cast-stage">
      {/* ===== §三：演员阵容总览（首屏即知 全员 / 进度 / 下一步） ===== */}
      <section className="comic-card comic-cast-overview" data-testid="comic-cast-overview">
        <header className="comic-cast-overview-head">
          <h3 className="comic-cast-title">本期演员阵容</h3>
          <div className="comic-cast-counts" data-testid="comic-cast-counts">
            <span>必选角色 {slotsSummary.requiredLocked}/{slotsSummary.requiredTotal} 已完成</span>
            {optionalSlots.length > 0 && <span>可选角色 {optionalDone}/{optionalSlots.length}</span>}
            <span>已锁定 {lockedCount}</span>
          </div>
        </header>
        <ul className="comic-cast-roster" data-testid="comic-cast-roster-strip">
          {skill.characterSlots.map(renderRosterRow)}
        </ul>
        {missingRefCharacters.length > 0 && (
          <div className="comic-cast-batch-refs" data-testid="comic-cast-batch-refs">
            <span className="comic-muted">
              {missingRefCharacters.length} 位演员还没有参考图（{missingRefCharacters.map(item => item.name).join('、')}）
            </span>
            <button
              type="button"
              className="app-btn app-btn-primary app-btn-sm"
              onClick={props.onGenerateMissingRefs}
            >
              生成全部缺失参考图
            </button>
          </div>
        )}
        {slotsSummary.charactersDone ? (
          <div className="comic-cast-ready" data-testid="comic-cast-ready">
            <strong>演员已就绪</strong>
            <span>可以继续进入分镜草稿。</span>
          </div>
        ) : (
          <div className="comic-cast-next" data-testid="comic-cast-next">
            <span className="comic-cast-next-title">还需要完成：</span>
            <ul>
              {slotsSummary.blockers.map(blocker => <li key={blocker}>· {blocker}</li>)}
            </ul>
          </div>
        )}
      </section>

      {/* ===== §十五：必选 / 可选分区 ===== */}
      <section className="comic-cast-section" data-testid="comic-cast-section-required">
        <header className="comic-cast-section-head">
          <h3 className="comic-cast-title">必选演员</h3>
          <span className="comic-muted">角色必须确认锁定后才能继续</span>
        </header>
        <div className="comic-cast-grid">
          {requiredSlots.map(renderCharacterCard)}
        </div>
      </section>

      {optionalSlots.length > 0 && (
        <section className="comic-cast-section" data-testid="comic-cast-section-optional">
          <header className="comic-cast-section-head">
            <h3 className="comic-cast-title">可选演员</h3>
            <span className="comic-muted">不影响下一步，可随时添加</span>
          </header>
          <div className="comic-cast-grid">
            {optionalSlots.map(renderCharacterCard)}
          </div>
        </section>
      )}

      {pickerIntent?.kind === 'ref-swap' && (
        <ImageLibraryPicker
          open
          title="选择角色参考图"
          onClose={() => setPickerIntent(null)}
          onPick={image => {
            const intent = pickerIntent;
            setPickerIntent(null);
            if (intent.kind !== 'ref-swap') return;
            const character = characterOfSlot(intent.slotId);
            if (!character) return;
            // §25：只引用现有 Asset ID / Local Path，不复制二进制
            props.onPatch(draft => upsertCharacterSnapshot(
              draft,
              attachCharacterReference(character, {
                path: image.local_path,
                assetId: image.id,
                label: character.name,
                imageId: image.id,
              }),
            ));
            toastSuccess('参考图已绑定');
          }}
        />
      )}

      {pickerIntent?.kind === 'library-add' && (
        <ImageLibraryPicker
          open
          title="从图库添加演员"
          onClose={() => setPickerIntent(null)}
          onPick={image => {
            setPickerIntent(null);
            // §22B：图库图片 → Library Character Draft（只引用，进命名弹窗）
            setDraftEntry({
              source: 'gallery',
              path: image.local_path,
              assetId: image.id,
              defaultName: fileNameOf(image.local_path),
            });
          }}
        />
      )}

      <ComicActorLibraryDialog
        open={libraryView !== null}
        mode={libraryView?.mode ?? 'select'}
        characters={props.libraryCharacters}
        busy={libraryBusy}
        onClose={() => setLibraryView(null)}
        onPick={item => void pickFromLibrary(item)}
        onQuickCreateAi={quickCreateAi}
        onAddFromGallery={addFromGallery}
        onUploadReference={() => void uploadReference()}
        savableCharacterName={lockedCharacter?.name ?? null}
        onSaveCurrent={() => {
          if (lockedCharacter) void saveToLibrary(lockedCharacter);
        }}
      />

      {draftEntry && (
        <ComicActorDraftDialog
          key={`${draftEntry.source}:${draftEntry.path}`}
          open
          title={draftEntry.source === 'gallery' ? '从图库添加演员' : '上传演员参考图'}
          preview={draftPreview}
          defaultName={draftEntry.defaultName}
          busy={draftBusy}
          onCancel={() => setDraftEntry(null)}
          onSave={input => void saveDraftEntry(input)}
        />
      )}
    </div>
  );
}
