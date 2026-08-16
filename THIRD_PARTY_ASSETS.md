# 第三方品牌资产记录（THIRD_PARTY_ASSETS）

CyImagePro 内置的 Provider 品牌 Logo 本地资产来源与许可记录。
所有 Logo 均为本地打包（`src/assets/providers/`），**禁止运行时外链加载**。

| 文件 | 名称 | Provider | 来源（官方页面） | 获取日期 | 用途 | 许可 / Brand Guideline |
| --- | --- | --- | --- | --- | --- | --- |
| `src/assets/providers/deepseek.svg` | DeepSeek Whale Mark | `deepseek_official` | https://api-docs.deepseek.com/zh-cn/img/favicon.svg （DeepSeek 官方 API 文档站 favicon.svg，单路径鲸鱼标志，品牌色 #4D6BFE，透明底） | 2026-08-15 | AI 智能体列表 / 编辑页 / Chat Header / 模型选择器中的 Provider 品牌识别 | DeepSeek 名称与 Logo 属 DeepSeek 商标；此处仅用于标识 DeepSeek 官方服务的互操作性展示（nominative fair use），不用于暗示任何背书关系 |
| `src/assets/providers/glm.png` | 智谱开放平台 Mark | `glm_official` | https://static.bigmodel.cn/wd-paas-front/static/images/favicon.png （智谱 AI 开放平台 www.bigmodel.cn 官方站点 favicon，32×32） | 2026-08-15 | 同上：标识智谱 GLM 官方服务 | 「智谱」「GLM」及标志属北京智谱华章科技股份有限公司商标；仅用于标识智谱官方服务的互操作性展示 |
| `src/assets/providers/generic-api.svg` | 通用 API 标识 | `openai_compatible`（所有第三方 Provider 共用） | CyImagePro 自绘（非任何厂商商标）：圆角框 + 接口节点连线 | 2026-08-15 | 未收录 Provider 的通用 fallback 标识 | 项目自有资产，可自由使用 |

## 使用原则

1. Logo 只通过 `src/features/aiProviders/registry/registry.ts` 的 `PROVIDER_LOGOS` 映射进入 UI，
   禁止在组件里按 provider id 硬编码 `<img src={glmLogo}>`。
2. 新增官方 Provider 时：优先使用官方开发者文档 / 官方 Brand Assets 提供的 SVG，
   禁止使用第三方 icon 站或图库搜索结果；并在本文件补录来源与许可。
3. Provider Logo 与 Agent Avatar 是两个概念：前者代表底层模型服务商，后者代表用户创建的智能体。
   Agent 未设置头像时使用默认 Agent 图标，**不得**默认套用 Provider Logo。
