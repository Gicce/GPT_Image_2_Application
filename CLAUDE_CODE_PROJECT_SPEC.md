# Claude Code Project Spec

## 1. Project Overview

- Project name: `CyImagePro`
- Current app version: `3.0.4`
- App type: Windows desktop application
- Architecture: `Tauri 2 + React 18 + TypeScript + Rust`
- Build tooling: `Vite 6`, `TypeScript`, `Cargo`
- Frontend state management: `Zustand`
- Frontend-backend bridge: `Tauri invoke/event IPC`
- Main product purpose:
  - AI image generation
  - AI image editing
  - remove.bg background removal
  - image gallery management
  - task queue management
  - account, model, payment, token, and usage management
  - agent-style conversational workflow that can convert user chat into executable image tasks

This is not a simple chat UI. The project already contains a fairly deep task orchestration layer. Any fix in chat, task execution, settings, or account flows should be treated as cross-layer work.

## 2. Working Assumptions For Claude Code

- The git worktree is already dirty.
- Do not revert unrelated existing edits.
- Prefer minimal, local fixes.
- Before changing logic, read both frontend and backend paths that participate in the same feature.
- If changing storage or IPC shape, check both TypeScript and Rust models.
- If changing task flow, check:
  - `src/store/useChatStore.ts`
  - `src/store/useTaskStore.ts`
  - `src-tauri/src/commands.rs`
  - `src-tauri/src/task_runner.rs`
  - `src-tauri/src/models.rs`

## 3. Local Run / Build Commands

## Frontend dev

```bash
npm run dev
```

## Tauri desktop dev

```bash
npm run tauri dev
```

## Frontend build

```bash
npm run build
```

## Tauri production build

```bash
npm run tauri build
```

## 4. Root-Level Project Structure

```text
src/                 React + TypeScript frontend
src/components/      Shared UI components
src/pages/           Main application pages
src/store/           Zustand stores, core business state
src/services/        Tauri IPC layer + remote server API layer
src/utils/           Agent/task/helper utilities
src/types/           Frontend shared types

src-tauri/           Rust backend for Tauri
src-tauri/src/
  lib.rs             Tauri setup and command registration
  main.rs            Desktop entry
  commands.rs        IPC commands and backend service logic
  models.rs          Rust-side data models
  storage.rs         JSON + SQLite-backed persistence
  task_runner.rs     Background polling task executor

public/              Static frontend assets
dist/                Frontend build output
```

## 5. Tech Stack Details

## Frontend dependencies

From `package.json`:

- `react`
- `react-dom`
- `zustand`
- `marked`
- `highlight.js`
- `qrcode`
- `recharts`
- `@tauri-apps/api`
- `@tauri-apps/plugin-dialog`
- `@tauri-apps/plugin-process`
- `@tauri-apps/plugin-shell`
- `@tauri-apps/plugin-updater`

## Backend dependencies

From `src-tauri/Cargo.toml`:

- `tauri`
- `tauri-plugin-dialog`
- `tauri-plugin-shell`
- `tauri-plugin-updater`
- `tauri-plugin-process`
- `serde`
- `serde_json`
- `reqwest`
- `tokio`
- `futures-util`
- `base64`
- `uuid`
- `chrono`
- `opener`
- `once_cell`
- `image`
- `md5`
- `dirs`
- `rusqlite` with `bundled`

## 6. App Entry Points

## Frontend

- Entry: `src/main.tsx`
- Root app: `src/App.tsx`

`App.tsx` is responsible for:

- applying theme
- loading settings
- loading login state
- checking updates
- loading server model list after login
- setting `groupTypeMap`
- page switching
- auth modal gating

## Backend

- Tauri entry: `src-tauri/src/main.rs`
- Runtime setup: `src-tauri/src/lib.rs`

`lib.rs` does the following:

- registers Tauri plugins
- starts a background Rust thread
- creates a Tokio runtime inside that thread
- polls every `500ms`
- calls `task_runner::process_next_task(&app_handle)`
- registers all Tauri commands through `invoke_handler`

This means task execution is backend-driven and polling-based, not frontend-driven.

## 7. Main Frontend Pages

Pages are lazy-loaded in `src/App.tsx`.

### `src/pages/AgentChat.tsx`

- Currently re-exports `Chat.tsx`
- The actual chat UI behavior lives in `src/pages/Chat.tsx`

### `src/pages/Chat.tsx`

- Main AI conversation page
- Uses `useChatStore.ts`
- Supports normal chat and task-flow interactions
- Can create proposals, confirm tasks, and attach images/files

### `src/pages/TaskQueue.tsx`

- Reads task state from `useTaskStore.ts`
- Displays queue, progress, status, prompt, final prompt, sub-task results
- Can cancel, retry, edit-resend, and delete tasks

### `src/pages/Gallery.tsx`

- Reads image records from `useImageStore.ts`
- Loads thumbnails lazily
- Groups by input library vs output directory
- Can open file/folder and delete image records/files

### `src/pages/Settings.tsx`

- One of the most important pages
- Contains:
  - default generation settings
  - agent settings
  - endpoint self-check
  - post-process settings
  - appearance settings
  - template center modal
- Template center includes:
  - task templates
  - style templates
  - import/export
  - template hit logs

### `src/pages/Account.tsx`

- Account overview
- login-related account UI
- model and package retrieval
- payment QR flow
- usage records
- order query and refund
- token display and sync-related UI

## 8. Main Zustand Stores

## `src/store/useSettingsStore.ts`

Purpose:

- owns app settings state
- loads/saves settings via Tauri IPC
- performs queued saves to avoid overlapping writes

Important behavior:

- save is debounced/serialized through `queueSettingsSave`
- partially changed settings are merged into full settings snapshot
- contains normalization logic between agent/chat fields

Important risk:

- settings are not simple form state; they also affect downstream agent, chat, image, and server behavior

## `src/store/useAuthStore.ts`

Purpose:

- login state
- current user
- JWT storage
- token balances
- requested-page auth gating
- sync server tokens into local settings

Important behavior:

- stores JWT and user info in `localStorage`
- uses `groupTypeMap` from server model list
- syncs server-distributed tokens into local `settings.token`, `settings.agent_token`, `settings.chat_token`

Important risk:

- changes here can silently affect backend generation tokens because settings sync is automatic

## `src/store/useTaskStore.ts`

Purpose:

- load/update/delete/cancel task list
- report newly completed images to remote billing API

Important behavior:

- compares previous and next sub-task states
- reports newly completed images via `serverApi.reportImage`
- deduplicates reports with a process-level `reportedKeys` set

Important risk:

- if task loading or status transitions are changed incorrectly, billing report behavior can duplicate or skip usage

## `src/store/useImageStore.ts`

Purpose:

- image list state
- image rescan
- image delete

## `src/store/useChatStore.ts`

This is the most complex frontend module.

Purpose:

- conversation persistence
- active conversation switching
- user/assistant message flow
- agent intent classification
- image understanding flow
- task proposal generation
- batch planning
- proposal confirmation/cancellation
- task creation from chat
- free chat vs task flow routing

This file is effectively an orchestration engine, not just a store.

It contains logic for:

- identifying whether a user message is:
  - normal chat
  - gallery search
  - image understanding
  - image generation
  - image edit
  - remove background
  - upscale
- deciding whether a message starts a new task or follows up on an existing draft
- generating clarification questions
- building variant/batch plans
- matching templates
- composing final prompts
- managing proposal lifecycle

If a bug touches chat behavior, read this file first before changing UI components.

## 9. Frontend Service Layers

## `src/services/api.ts`

Purpose:

- frontend wrapper around Tauri commands
- one central invoke layer for local/backend operations

Includes methods for:

- settings
- templates
- tasks
- images
- file operations
- conversations
- remove background
- chat image generation/editing
- agent request
- endpoint self-check
- image understanding

If a feature is local-app-only or Rust-backed, it probably passes through here.

## `src/services/serverApi.ts`

Purpose:

- wrapper around remote HTTP API hosted at `zjcypc.com`

Includes:

- register/login/getMe
- usage reporting
- usage estimation
- packages
- order creation
- order query/close/refund
- notice retrieval
- model retrieval
- prompt retrieval
- password reset

Important behavior:

- tries multiple server base candidates
- uses `server_url` from local settings
- can fall back across:
  - `https://www.zjcypc.com`
  - `https://zjcypc.com`
  - `http://124.221.205.221`

Important risk:

- fixes here can affect all account/payment/model/notice paths

## 10. Shared Frontend Types

Main shared TS models live in `src/types/index.ts`.

Critical data structures:

- `Settings`
- `Task`
- `SubTask`
- `TaskBatchItem`
- `ImageRecord`
- `ChatConversation`
- `ChatMessage`
- `AgentProposal`
- `AgentTaskDraft`
- `AgentTaskTemplate`
- `AgentStyleTemplate`
- `AgentTemplateLog`

If you change a field in TypeScript, check whether the same field also exists in:

- `src-tauri/src/models.rs`
- persisted JSON/DB usage
- any UI that renders it

## 11. Rust Backend Modules

## `src-tauri/src/commands.rs`

This is the main backend command layer.

It contains:

- settings read/write
- task CRUD
- image CRUD and rescanning
- conversation persistence
- file selection/opening
- image read/thumbnail read
- remove.bg processing
- chat image generation/edit
- agent request execution
- endpoint self-check
- release fetching

It also contains HTTP helper logic for:

- OpenAI-compatible chat completions
- Responses API parsing
- multimodal vision request paths
- upstream error classification

This file is large and mixes:

- IPC commands
- networking logic
- image file logic
- validation
- external API compatibility handling

Expect coupling.

## `src-tauri/src/task_runner.rs`

Purpose:

- background execution of queued tasks

Execution model:

1. Poll pending task
2. Mark task `running`
3. Iterate sub-tasks
4. Run one of:
   - `generate_single_image`
   - `edit_single_image`
   - `remove_background_single_image`
5. Save image record
6. Update task/sub-task status
7. Emit `task-updated` event

External APIs used here:

- `https://www.packyapi.com/v1/images/generations`
- `https://www.packyapi.com/v1/images/edits`
- `https://api.remove.bg/v1.0/removebg`

Important risk:

- this file controls actual execution and output saving
- wrong changes here can break queue behavior, duplicate execution, or corrupt status transitions

## `src-tauri/src/storage.rs`

Purpose:

- app data directory resolution
- JSON file path helpers
- SQLite-backed persistence
- migration of legacy JSON content into SQLite key-value records
- template and template-log persistence

Very important detail:

- this project uses hybrid persistence
- normal app objects like settings/tasks/images/conversations are still read/written via JSON-shaped functions
- but those functions also sync into `app.db`
- template data is stored directly in SQLite tables

Persisted JSON path concepts:

- `settings.json`
- `tasks.json`
- `images.json`
- `conversations.json`

SQLite DB:

- `app.db`

Important risk:

- do not assume storage is “only JSON”
- do not assume storage is “only SQLite”
- changing persistence code incorrectly can create subtle consistency bugs

## `src-tauri/src/models.rs`

Purpose:

- Rust-side data structures matching frontend shapes

Important note:

- some Rust models are not identical in strict type precision to TS
- for example some optional/union semantics are looser on Rust side
- if you add or rename fields, verify both sides still serialize/deserialize cleanly

## 12. Persistence Model

## Local application data

Managed through Tauri app data directory.

Primary persisted domains:

- settings
- tasks
- images
- conversations
- agent templates
- style templates
- template logs

## Current persistence split

### JSON-oriented app records

- settings
- tasks
- images
- conversations

### SQLite-oriented structured records

- `agent_task_templates`
- `agent_style_templates`
- `agent_template_logs`
- `kv_store`
- `migrations`

## Migration behavior

`storage.rs` attempts to:

- read from SQLite first
- if absent, read legacy JSON
- import legacy JSON into SQLite `kv_store`

This means persistence bugs can appear as:

- stale reads
- write mismatch
- migration duplication
- legacy JSON shadowing

## 13. Remote Systems / External APIs

## AI / image endpoints

- base: `https://www.packyapi.com/v1`
- image generation: `/images/generations`
- image edits: `/images/edits`
- responses API: `/responses`
- chat completions compatible path: `/chat/completions`

## Background removal

- `https://api.remove.bg/v1.0/removebg`

## App server

- `https://www.zjcypc.com`
- fallback domains possible in `serverApi.ts`

Used for:

- auth
- usage
- payment
- model catalog
- prompt catalog
- notice

## Updates

- updater JSON:
  - `https://github.com/Gicce/GPT_Image_2_Application/releases/latest/download/latest.json`
- release history:
  - GitHub Releases API from `fetch_releases`

## 14. Core User Flows

## Flow A: Standard task creation from UI

1. Frontend builds `CreateTaskParams`
2. `api.createTask()` invokes Rust command
3. Task record is persisted
4. Background poller finds pending task
5. Runner executes API request
6. Result image is saved to disk
7. Image record is persisted
8. `task-updated` event is emitted
9. Frontend reloads task state

## Flow B: Task creation from chat / agent

1. User sends chat message
2. `useChatStore.ts` classifies intent
3. If needed, runs image understanding
4. If needed, matches task/style templates
5. Builds final prompt and proposal
6. User confirms proposal
7. Store converts proposal into task
8. `api.createTask()` calls backend
9. Background task runner executes it

## Flow C: Settings-driven token sync

1. User logs in via remote server
2. Server returns token groups and balances
3. `useAuthStore.ts` maps groups using `groupTypeMap`
4. Matching tokens are copied into local settings
5. Rust backend later reads those settings for actual image/agent execution

This means account fixes can indirectly break generation if settings sync is damaged.

## Flow D: Gallery synchronization

1. App reads configured directories from settings
2. Rust scans files recursively
3. Existing image records are marked present/missing
4. New files are inserted as image records
5. Frontend gallery loads and displays grouped results

## 15. Important Configuration Fields

From `Settings`:

- `token`
  - main image generation token
- `default_size`
- `default_quality`
- `default_format`
- `default_output_dir`
- `library_input_dir`
- `agent_name`
- `agent_token`
- `agent_model`
- `agent_base_url`
- `agent_system_prompt`
- `agent_context_window`
- `removebg_api_key`
- `upscale_provider`
- `topaz_api_key`
- `vision_model`
- `chat_token`
- `chat_model`
- `chat_base_url`
- `chat_system_prompt`
- `server_url`
- `notice_enabled`
- `theme`

Important internal rule:

- `useSettingsStore.ts` normalizes agent/chat settings and can mirror values between them

## 16. Template System

The app has a built-in template engine for the agent workflow.

## Task templates

Stored in SQLite table `agent_task_templates`.

Used for:

- intent-specific task shaping
- clarification rules
- prompt templates
- recommended action templates

## Style templates

Stored in SQLite table `agent_style_templates`.

Used for:

- style prompt fragments
- negative prompt fragments
- intent/scene compatibility

## Template logs

Stored in SQLite table `agent_template_logs`.

Used for:

- debugging which templates matched
- inspecting final prompt output

If fixing agent proposal quality, read both:

- `src/store/useChatStore.ts`
- `src/utils/agent/*`
- `src/pages/Settings.tsx`
- `src-tauri/src/storage.rs`

## 17. Known High-Risk Areas

These files are the most likely to create regressions if edited casually:

- `src/store/useChatStore.ts`
- `src/store/useAuthStore.ts`
- `src/store/useSettingsStore.ts`
- `src/services/serverApi.ts`
- `src-tauri/src/commands.rs`
- `src-tauri/src/task_runner.rs`
- `src-tauri/src/storage.rs`
- `src-tauri/src/models.rs`

## Why these are risky

- heavy coupling
- hidden side effects
- persistence shape dependencies
- mixed frontend/backend ownership
- billing/token implications
- account state impacts generation state

## 18. Current Observable Codebase Characteristics

- The project is mid-evolution, not a clean greenfield codebase.
- Several files are already modified and uncommitted.
- Some modules are very large and mix concerns.
- The app uses both local persistence and remote business APIs.
- The chat/agent system already contains custom heuristics and rule-based fallbacks.

## 19. Practical Read Order For Claude Code

If the issue is unknown, read in this order:

1. `src/App.tsx`
2. `src/types/index.ts`
3. `src/services/api.ts`
4. `src/services/serverApi.ts`
5. `src/store/useSettingsStore.ts`
6. `src/store/useAuthStore.ts`
7. `src/store/useTaskStore.ts`
8. `src/store/useChatStore.ts`
9. `src-tauri/src/lib.rs`
10. `src-tauri/src/models.rs`
11. `src-tauri/src/commands.rs`
12. `src-tauri/src/storage.rs`
13. `src-tauri/src/task_runner.rs`

If the bug is scoped, use these shortcuts:

### Chat / proposal / agent behavior

- `src/pages/Chat.tsx`
- `src/store/useChatStore.ts`
- `src/utils/agentIntent.ts`
- `src/utils/agentConfig.ts`
- `src/utils/agent/*`
- `src-tauri/src/commands.rs`

### Task queue / execution / output file issues

- `src/pages/TaskQueue.tsx`
- `src/store/useTaskStore.ts`
- `src-tauri/src/task_runner.rs`
- `src-tauri/src/models.rs`
- `src-tauri/src/storage.rs`

### Gallery / local file / thumbnail issues

- `src/pages/Gallery.tsx`
- `src/store/useImageStore.ts`
- `src-tauri/src/commands.rs`
- `src-tauri/src/storage.rs`

### Settings / model config / endpoint self-check

- `src/pages/Settings.tsx`
- `src/store/useSettingsStore.ts`
- `src/services/serverApi.ts`
- `src-tauri/src/commands.rs`

### Login / account / payment / token sync

- `src/pages/Account.tsx`
- `src/store/useAuthStore.ts`
- `src/services/serverApi.ts`
- `src/store/useSettingsStore.ts`

## 20. Recommended Fix Strategy

When making a change:

1. Identify whether the bug is frontend-only, backend-only, or data-contract-related.
2. If any field is passed through Tauri IPC, inspect both TS and Rust definitions.
3. If a fix touches tasks or conversations, inspect persistence and reload logic.
4. Make the smallest possible change.
5. Verify whether remote billing/reporting behavior is affected.
6. Avoid refactoring large orchestration files unless required by the bug.

## 21. Things To Check Before Declaring A Fix Complete

- Does the UI state update correctly after action completion?
- Does data persist after app reload?
- If task-related, does `task-updated` still refresh frontend state?
- If image-related, are file paths still valid on Windows?
- If settings-related, are agent/chat/token mirror rules still correct?
- If auth-related, is `localStorage` state still consistent?
- If remote server related, does fallback base URL logic still behave reasonably?
- If template-related, does import/export remain valid JSON?
- If backend model fields changed, do TS types still match?

## 22. Explicit Warnings

- Do not assume the issue is only in the UI if symptoms appear in UI.
- Do not change `Settings`, `Task`, `ImageRecord`, or conversation structures on one side only.
- Do not break `groupTypeMap` token classification unless intentionally redesigning account-token behavior.
- Do not remove queued save logic in `useSettingsStore.ts` casually.
- Do not rewrite `useChatStore.ts` wholesale just to fix one branch.
- Do not treat storage as only JSON or only SQLite.

## 23. Suggested Prompt To Start Claude Code Work

Use this prompt as the first operational instruction for Claude Code:

```text
Read this project spec first, then inspect the relevant files before editing.

Project constraints:
- Tauri 2 desktop app
- React + TypeScript frontend
- Rust backend
- Zustand state
- JSON + SQLite hybrid persistence
- Dirty git worktree, do not revert unrelated changes

Your task:
1. Read the relevant code paths for the bug.
2. Explain the likely root cause briefly.
3. Make the smallest safe fix.
4. Verify that frontend/backend data contracts still match.
5. Summarize exactly which files were changed and why.
```

## 24. Suggested Prompt Template For A Specific Bug

```text
Read `CLAUDE_CODE_PROJECT_SPEC.md` first.

Bug to fix:
[describe the bug here]

Required approach:
- inspect the existing implementation first
- do not refactor unrelated code
- preserve existing behavior outside the bug scope
- if a TS/Rust contract is involved, update both sides
- if storage fields are involved, verify persistence impact

After the fix:
- explain root cause
- list changed files
- mention any residual risk
```

## 25. Final Notes

This project is already beyond a CRUD desktop shell. The most important fact for any future fix is that chat, agent templates, local settings, backend task execution, and remote token/account state are interconnected.

If behavior looks inconsistent, the root cause is often one of these:

- store state not persisted or reloaded correctly
- TS/Rust model drift
- automatic token sync side effect
- task runner status transition mismatch
- remote API compatibility handling in `commands.rs`
- template/proposal logic in `useChatStore.ts`
