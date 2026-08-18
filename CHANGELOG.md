# Changelog

## v4.0.2（2026-08-18）

### Fixed

- 修复应用内更新检测失效的问题：更新接口请求失败（latest.json 缺失/网络错误）曾被静默当作「已是最新版本」，现明确区分「已是最新」与「检查失败」并支持重新检查
- 修复更新流程缺失下载/安装状态的问题：现在显示真实下载进度，下载完成后由用户确认重启安装
- 修复 v4.0.1 起安装包未附带 updater 签名产物（latest.json/.sig）导致老版本客户端无法在线升级的问题
- 修复客户端心跳必须手动点击「立即上报」才生效的问题：登录成功、会话恢复、连接建立/恢复时自动立即上报
- 修复登出后心跳调度器未停止的问题；重新登录自动重启调度器并切换账户上下文
- 修复心跳调度器重复启动问题：App 级单例，多次导航不再产生多个定时器
- 修复启动时序问题：等待本地设置（server_url/device_id）加载完成后再启动心跳，避免首次上报被跳过
- 修复 device_id 持久化失败被静默吞掉的问题：失败重试并记录告警
- 心跳失败不再影响连接状态与创作功能，仅记录状态并在下一周期自动重试

### Improved

- 更新状态机重构：idle / checking / update_available / latest / check_failed / downloading / restart_required / installing 八态互斥；自动检查与手动检查共用同一逻辑并防重入
- 版本比较改用数值 SemVer 工具（4.0.9 < 4.0.10），更新判断以 Updater Release 为准，更新日志仅作展示
- 发布链路加固：CI 与 Release 均校验四处版本来源（package.json / tauri.conf.json / Cargo.toml / release.ts）一致，Release 完成后自动验证 latest.json 版本与签名完整性
- 设置页心跳状态展示「最后成功心跳」时间；「立即上报」重新定位为手动诊断入口
- 心跳平台字段按实际系统检测（windows/macos/linux），不再硬编码
- 清理 serverApi 临时诊断日志（含响应体输出，避免敏感信息进入控制台）

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
