# ImagePro 技能工坊架构（v4.2.2）

## 定位

技能工坊是现有自由生成页之上的专业工作流层，不替代图片生成、视觉理解或内部 Runtime Skill。首版只有 `professional_desk_setup@1.0.0` 标记为正式可用，其余领域保留可扩展目录项并明确显示“测试中”。

## 数据层

- `SkillPackage`：服务端发布、不可变的版本化领域合同，包括 Core Rules、Profiles、素材角色、向导步骤和质检维度。
- `SkillProject`：客户端本地 SQLite 项目，保存语义状态、素材引用、确认卡、编译结果和生成任务引用；视图步骤、折叠状态等不进入语义合同。
- `BrandCard`：Logo 分析结果与源文件 SHA-256 指纹绑定。AI 推断和用户补充规则分开保存，只有用户确认后才能进入 Prompt。
- `Profile`：Base、Style、Theme、Platform 是可组合配置，不复制领域 Core Skill。

## Prompt 合同

确定性装配顺序：

1. 安全与素材限制
2. 已确认素材卡
3. 领域硬规则
4. 用户本次覆盖
5. Style / Theme / Platform Profiles
6. Base Profile
7. 输出默认值

未确认 Logo、自定义主题无参考素材等硬冲突直接进入 `blockers`，报价与生成按钮不可用。生成任务保存提交时的完整 Prompt，界面显示内容与实际提交内容一致。

## 模型与计费

Logo 分析使用统一的 `vision_analysis` 模型路由，图片质检使用 `image_evaluation` 路由。分析与质检均只在用户点击后执行。图片生成和修正提案走原有服务端报价、授权、任务登记与失败释放链路。

## 离线与兼容

客户端优先读取服务端 Catalog，失败时使用本地缓存，首次离线使用内置专业桌搭包。旧任务模板与风格模板保持原位置；后续适配器可将其投影为 Profile/Prompt 片段。
