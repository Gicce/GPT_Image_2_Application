/**
 * 《鸭梨山大 · 第一期》真实文字层 fixture（V4.2.13 §26/§49/§32）。
 *
 * 来源：本机 app.db `comic_projects`（id 2761e3d3-9643-4537-bddf-99602d5c6d50）
 * `data_json.dialogues` 逐字只读导出（2026-09-02）——V4.2.11 旧 schema：
 * 无 size / 无 fontFamily；position 已是 0..1（含 (1,1)/(1,0)/(0,0) 角点实测值）。
 * 绝不改写、不清洗——单元测试不许代替真实旧数据（§49），回归必须以这份原样数据为准。
 */

/** raw DB 对白形状（旧 schema 字段原样，unknown 化防类型偷渡）。 */
export interface DuckpearRawDialogue {
  id: string;
  panelId: string;
  speakerId: string;
  type: string;
  text: string;
  position: { x: number; y: number };
  alignment: string;
  fontStyle: { size: number; weight: number };
  bubbleStyle: string;
  tail: string;
}

export const DUCKPEAR_RAW_DIALOGUES: readonly DuckpearRawDialogue[] = [
  {
    id: 'e2e-dlg-1',
    panelId: 'panel-0',
    speakerId: '5efcb13f-692a-484b-a52e-497df43d6b8a',
    type: 'speech',
    text: '妈妈，功课好多呀……（终稿）',
    position: { x: 0.3575, y: 0.06 },
    alignment: 'center',
    fontStyle: { size: 22, weight: 500 },
    bubbleStyle: 'none',
    tail: 'auto',
  },
  {
    id: 'e2e-dlg-2',
    panelId: 'panel-1',
    speakerId: '0009259d-bcf7-4d00-87e5-b66a67406e48',
    type: 'speech',
    text: '鸭老师，今天的课表又满啦？',
    position: { x: 0.25625, y: 0.10500000000000001 },
    alignment: 'center',
    fontStyle: { size: 16, weight: 500 },
    bubbleStyle: 'none',
    tail: 'auto',
  },
  {
    id: 'e2e-dlg-3',
    panelId: 'panel-2',
    speakerId: 'b26c3f86-7c72-4f17-b635-c21360192f83',
    type: 'speech',
    text: '肚子怎么越来越圆了……',
    position: { x: 1, y: 1 },
    alignment: 'center',
    fontStyle: { size: 16, weight: 500 },
    bubbleStyle: 'rounded',
    tail: 'auto',
  },
  {
    id: 'e2e-dlg-4',
    panelId: 'panel-3',
    speakerId: '5efcb13f-692a-484b-a52e-497df43d6b8a',
    type: 'speech',
    text: '妈妈，我怎么长得像颗梨？',
    position: { x: 1, y: 0 },
    alignment: 'center',
    fontStyle: { size: 16, weight: 500 },
    bubbleStyle: 'rounded',
    tail: 'auto',
  },
  {
    id: 'e2e-dlg-caption',
    panelId: 'panel-3',
    speakerId: 'narrator',
    type: 'thought',
    text: '这叫鸭梨，谁长大都得背上一点。',
    position: { x: 0, y: 0 },
    alignment: 'center',
    fontStyle: { size: 16, weight: 500 },
    bubbleStyle: 'box',
    tail: 'auto',
  },
];
