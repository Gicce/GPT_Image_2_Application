# Changelog

## v4.0.1（2026-08-18）

### Fixed

- 修复 DeepSeek Planner 长 JSON 输出被截断时无法正确识别的问题
- 增加 Planner 输出截断分类和自动重试
- 修复 Planner transport 日志错误
- 修复"重新规划"需要点击两次的问题
- 修复修改后的任务内容没有正确传入 Planner
- 修复长对话中图生图源图片发生漂移
- Task 源图片创建后固定，不再受后续图片影响
- 修复旧任务更新导致当前活动图片回退
- 增加当前对话历史图片切换
- 增加任务 Source Image 状态和缩略图提示
- 增加图生图源图片执行前校验

### Improved

- Planner 诊断信息更加完整
- 图生图 Source Image 管理统一
- 任务卡图片引用状态更加清晰
- 提升 AI Agent 长对话连续编辑稳定性
