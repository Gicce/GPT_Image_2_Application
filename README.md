# AI 图片批量生成工具

Windows 桌面版 AI 图片批量生成工具，基于 GPT Image 2 API，支持批量创建、任务队列、图片库管理和历史记录。

## 技术栈

- **桌面框架**: Tauri 2
- **前端**: React 18 + TypeScript
- **后端**: Rust (Tauri)
- **构建工具**: Vite
- **状态管理**: Zustand
- **本地存储**: JSON 文件（Tauri userData 目录）

## 安装依赖

### 前置条件

1. **Node.js** >= 18
2. **Rust** >= 1.70（通过 [rustup](https://rustup.rs/) 安装）
3. **C 编译工具链**（以下任选其一）：
   - Visual Studio Build Tools（C++ 桌面开发工作负载）→ Rust 使用 `x86_64-pc-windows-msvc` 目标
   - MinGW-w64 GCC（如 [WinLibs](https://winlibs.com/)）→ Rust 使用 `x86_64-pc-windows-gnu` 目标

### 安装步骤

```bash
# 1. 安装前端依赖
npm install

# 2. 确认 Rust 目标（GNU 工具链）
rustup default stable-x86_64-pc-windows-gnu

# 3. 确保 GCC 在 PATH 中
gcc --version

# 4. Rust 依赖会在首次构建时自动安装
```

## 本地开发运行

```bash
# 开发模式（前端热更新 + Tauri 窗口）
npm run tauri dev
```

首次运行会自动编译 Rust 后端，耗时较长（约 5-10 分钟），后续增量编译很快。

## Windows 打包

```bash
# 构建生产版本
npm run tauri build
```

打包产物在 `src-tauri/target/release/bundle/` 目录下，包括 NSIS 安装程序。

## 配置说明

1. 首次使用请进入「设置」页面填写 API Token
2. 可设置默认图片尺寸、质量、输出格式和输出目录
3. 所有配置保存在本地 `%APPDATA%/gpt-image-batch-generator/` 目录

## 主要目录结构

```
├── src/                          # React 前端
│   ├── main.tsx                  # 入口
│   ├── App.tsx                   # 根组件
│   ├── App.css                   # 全局样式
│   ├── types/                    # 类型定义
│   ├── services/                 # API 服务层
│   │   └── api.ts                # Tauri IPC 封装
│   ├── store/                    # Zustand 状态管理
│   │   ├── useSettingsStore.ts
│   │   ├── useTaskStore.ts
│   │   └── useImageStore.ts
│   ├── components/               # 通用组件
│   │   └── Sidebar.tsx
│   └── pages/                    # 页面
│       ├── CreateTask.tsx        # 创建批量任务
│       ├── TaskQueue.tsx         # 任务队列
│       ├── Gallery.tsx           # 图片库
│       ├── History.tsx           # 历史记录
│       └── Settings.tsx          # 设置
├── src-tauri/                    # Tauri Rust 后端
│   ├── src/
│   │   ├── lib.rs                # 应用入口
│   │   ├── main.rs               # main 函数
│   │   ├── commands.rs           # IPC 命令
│   │   ├── models.rs             # 数据模型
│   │   ├── storage.rs            # JSON 文件存储
│   │   └── task_runner.rs        # 任务执行引擎
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
├── vite.config.ts
└── index.html
```

## 已实现功能

- [x] 创建批量生成任务（支持自定义数量 1-50）
- [x] 任务队列实时进度展示
- [x] 图片库网格展示 + 大图预览
- [x] 历史记录（按任务查看结果）
- [x] 设置页（Token、默认参数、输出目录）
- [x] 本地 JSON 持久化存储
- [x] 图片打开/打开目录/删除
- [x] 任务取消
- [x] 异常处理（Token 为空、提示词为空、网络错误、API 错误、Base64 解码失败）
- [x] 单张失败不影响整个批量任务
- [x] Windows 11 风格 UI

## 后续可扩展项

- [ ] 登录注册、账号体系
- [ ] 点数套餐、支付集成
- [ ] 会员权限控制
- [ ] 云同步
- [ ] SQLite 存储（替换 JSON）
- [ ] 负面提示词支持（待 API 支持）
- [ ] 图片批量删除
- [ ] 任务暂停/恢复
- [ ] 并发请求控制
- [ ] 自动重试失败任务
- [ ] 系统托盘
- [ ] 多语言支持
