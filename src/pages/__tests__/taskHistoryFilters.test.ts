import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 任务队列 / 历史记录 筛选与双栏滚动守卫（源码文本断言，先例见 confirmButtons.test.ts）：
 * - 两页必须共用 utils/taskCategory 同一套分类函数（禁止各写一套判断规则）；
 * - 筛选条类型 chips 带真实数量；状态筛选与类型筛选可组合；
 * - History 双栏独立滚动：外层不随任务数增高、切任务详情 scrollTop 归零；
 * - 文案统一「视觉理解」，禁止「视图理解」。
 */

const queueSrc = readFileSync(resolve(__dirname, '../TaskQueue.tsx'), 'utf-8');
const historySrc = readFileSync(resolve(__dirname, '../History.tsx'), 'utf-8');
const historyCss = readFileSync(resolve(__dirname, '../History.css'), 'utf-8');
const categorySrc = readFileSync(resolve(__dirname, '../../utils/taskCategory.ts'), 'utf-8');
const filterBarSrc = readFileSync(resolve(__dirname, '../../components/TaskFilterBar.tsx'), 'utf-8');

describe('任务队列与历史记录共用同一套分类规则', () => {
  test('两页都从 utils/taskCategory 导入分类函数（同一事实源）', () => {
    expect(queueSrc).toContain("from '../utils/taskCategory'");
    expect(historySrc).toContain("from '../utils/taskCategory'");
    expect(queueSrc).toContain('getTaskCategoryCounts');
    expect(historySrc).toContain('getTaskCategoryCounts');
  });

  test('页面内不允许再各自定义分类判断函数', () => {
    expect(queueSrc).not.toContain('function getTaskTypeLabel');
    expect(historySrc).not.toContain('function getTaskTypeLabel');
  });

  test('分类模块只读 task_type，不读来源字段（来源≠类型）', () => {
    // 剥离块注释后检查代码（注释里说明"来源字段不参与分类"是允许的）
    const codeOnly = categorySrc.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toContain('source_task_kind');
    expect(codeOnly).not.toContain('source_task_id');
    // 来源链路展示保留在页面层
    expect(queueSrc).toContain('来源：视觉理解任务');
    expect(historySrc).toContain('来源：视觉理解任务');
  });
});

describe('筛选条（类型 + 状态组合）', () => {
  test('类型 chips 渲染真实数量', () => {
    expect(filterBarSrc).toContain('typeCounts[item.key]');
    expect(filterBarSrc).toContain('TASK_CATEGORY_FILTERS');
  });

  test('类型筛选：全部 / 文生图 / 图生图 / 视觉理解', () => {
    const labels = ['全部', '文生图', '图生图', '视觉理解'];
    for (const label of labels) {
      expect(categorySrc).toContain(`label: '${label}'`);
    }
  });

  test('状态筛选：全部 / 等待中 / 生成中 / 已完成 / 失败（任务队列启用第二行）', () => {
    for (const label of ['等待中', '生成中', '已完成', '失败']) {
      expect(categorySrc).toContain(`label: '${label}'`);
    }
    expect(queueSrc).toContain('activeStatus={activeStatus}');
    expect(queueSrc).toContain('onStatusChange={setActiveStatus}');
    // 历史记录只有类型筛选，不传状态行
    expect(historySrc).not.toContain('activeStatus');
  });

  test('任务队列组合过滤：先类型后状态', () => {
    expect(queueSrc).toContain('filterTasksByStatus(');
    expect(queueSrc).toContain('filterTasksByCategory(sorted, activeCategory)');
  });

  test('筛选后空结果有独立提示（不误报"暂无任务"）', () => {
    expect(queueSrc).toContain('没有符合筛选条件的任务');
    expect(historySrc).toContain('当前筛选条件下没有任务');
  });
});

describe('History 双栏独立滚动', () => {
  test('页面根节点使用固定高度工作区（外层不随任务数增高）', () => {
    expect(historySrc).toContain('page history-page');
    expect(historyCss).toContain('.history-page {');
    expect(historyCss.match(/\.history-page\s*\{[^}]*\}/)![0]).toContain('height: 100%');
    expect(historyCss.match(/\.history-page\s*\{[^}]*\}/)![0]).toContain('overflow: hidden');
  });

  test('列表与详情各自独立滚动', () => {
    expect(historyCss.match(/\.history-list\s*\{[^}]*\}/)![0]).toContain('overflow-y: auto');
    expect(historyCss.match(/\.history-detail\s*\{[^}]*\}/)![0]).toContain('overflow-y: auto');
    expect(historyCss.match(/\.history-layout\s*\{[^}]*\}/)![0]).toContain('flex: 1');
  });

  test('窄窗口退化为上下布局（详情可达）', () => {
    const media = historyCss.match(/@media \(max-width: 1100px\)\s*\{[\s\S]*?\n\}/)![0];
    expect(media).toContain('flex-direction: column');
    expect(media).toContain('height: auto');
  });

  test('对话历史图片区块已彻底删除（V4.0.7：与任务详情无关的图片区不再渲染）', () => {
    expect(historySrc).not.toContain('chatImages');
    expect(historySrc).not.toContain('对话历史图片');
    expect(historyCss).not.toContain('.history-chat-section');
    expect(historyCss).not.toContain('.history-chat-title');
  });
});

describe('切任务详情刷新与滚动重置', () => {
  test('详情容器挂在 selectedTaskId 派生的 selectedTask 上（切换即刷新）', () => {
    expect(historySrc).toContain('task={selectedTask}');
  });

  test('切换任务时详情 scrollTop 归零（不继承上一任务滚动位置）', () => {
    expect(historySrc).toContain('detailScrollRef');
    expect(historySrc).toContain('detailScrollRef.current.scrollTop = 0');
    expect(historySrc).toMatch(/useEffect\(\(\) => \{[\s\S]*?setPlanDrawerIndex\(null\);[\s\S]*?detailScrollRef\.current\.scrollTop = 0;[\s\S]*?\}, \[selectedTaskId\]\)/);
  });

  test('详情滚动容器 ref 绑定在右侧面板上', () => {
    expect(historySrc).toContain('className="history-detail" ref={detailScrollRef}');
  });
});

describe('产品文案：统一「视觉理解」', () => {
  test('源码中不存在「视图理解」', () => {
    for (const src of [queueSrc, historySrc, categorySrc, filterBarSrc]) {
      expect(src).not.toContain('视图理解');
    }
  });
});
