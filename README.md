# Client Context Bridge (CCB)

CCGUI 市场插件。在不同 AI CLI 客户端（Claude Code / Codex CLI / Gemini CLI / OMP …）之间切换时，
自动维护当前任务的可执行上下文，并在目标客户端的新会话里以一次性内部提示注入，不需要手写交接说明。

- 插件 id：`ccgui.client-context-bridge`
- 交付形式：市场插件，不进 CCGUI 默认构建
- 默认状态：安装后**关闭**，由用户主动开启
- 上下文文件：`<ccgui-data>/plugin-data/ccgui.client-context-bridge/<workspace-id>.ccb`（UTF-8 JSON）
- 插件不引入 SQLite 或 Protobuf；宿主对各 CLI 原生历史格式的读取与 `.ccb` 存储独立。

## 硬性前提：需要 SDK 0.4.1 或更高版本的宿主

本插件 `manifest.json` 声明 `sdkVersion: ">=0.4.1"`。宿主 SDK 版本不足时，插件管理会拒绝加载；
仅升级 AI CLI 不能补齐宿主接口。

需要配套的宿主构建：`desktop-cc-gui` 分支 `feat/client-context-bridge` 的 Windows 产物
（CI workflow `Build Windows artifact`，产物名 `ccgui-windows-x64`）。宿主侧新增的通用接口：

| 接口 | 用途 |
|---|---|
| `ctx.hooks.registerSessionHooks` | 观察会话新建、恢复与关闭 |
| `ctx.hooks.registerTurnHooks` | 观察运行时事实与回合结算；以稳定 `turnId` 关联 |
| `ctx.hooks.registerRuntimeSwitchHooks` | 观察客户端切换前后生命周期 |
| `TurnHooks.beforeTurn` 返回内部 `PromptContribution` | 启动成功后才确认接纳，不把失败发送记为已消费 |
| `ctx.documentStorage` | 受控 UTF-8 JSON 文档存储（原子写、备份、CAS） |
| `ctx.workspace.getMetadata()` | 只读工作区身份与 Git 元数据 |
| `ctx.ui.registerWorkspaceMenuItem` | 在目标工作区右键菜单中单独启用或停用桥接 |
| `BeforeTurnResult.isCurrent` | 工作区停用后撤销已返回、尚未发送的协议与交接 |

这些都是领域通用接口，宿主里没有任何 CCB 专属类型或状态机。

## 安装（zip 包）

CCGUI 的插件安装走**目录选择**，不接受 zip 文件本身（`plugin_install_from_path` 只接受目录）。

1. 解压 `ccgui-plugin-client-context-bridge-1.0.0.zip`，得到一个文件夹，里面是 `manifest.json` + `main.js`
2. CCGUI → 设置 → 插件管理 → 安装插件 → **选中解压出来的那个文件夹**
3. 在插件管理里启用插件
4. 设置 → Client Context Bridge (CCB) → 打开“全局启用跨客户端上下文桥接”（默认关闭），按需调整存储位置与有效期
5. 单个项目可在左侧工作区文件夹的右键菜单中选择“启用 CCB”或“停用 CCB”；未单独设置的项目跟随全局，全局关闭时单独启用也不会运行

## 怎么验证它在干活

1. 打开一个工作区，用任意客户端（如 Claude Code）跑一两轮真实对话，涉及改文件或跑命令
2. 状态栏显示桥接状态，例如等待同步、已同步、已降级或已从其他客户端接续
3. 在同一工作区把客户端切到另一个（如 Codex CLI），开新会话
4. 新会话的第一条请求会带上一次性交接上下文：任务目标、已完成、待完成、关键决策、
   最近文件、已执行命令与真实结果、建议下一步
5. 目标客户端应当直接接着干，而不是反问"你要我做什么"

上下文文件可以直接看：`C:\Users\<你>\.ccgui-next\plugin-data\ccgui.client-context-bridge\<workspace-id>.ccb`

### 停用后的行为

- 工作区停用或全局关闭后，不再追加自动维护提示，也不再开始上下文读写；已经发出的存储请求可能完成，但不会触发后续读取、重试或写入。
- 单个项目的选择会保存，重载插件后仍生效；启用须保存成功后才运行，保存失败不会偷偷开启。
- 旧会话的原生历史仍可能带有之前的维护指令。配套宿主在停用后的下一次发送加入一次性撤销，明确要求模型停止按旧指令维护上下文或输出私有协议帧；不会自动发送一轮消息，也不删除既有任务事实。正在执行的 CLI 请求不会因关闭桥接而被中断。

## 边界

传递的是**当前任务的可执行状态**，不是完整聊天记录：不合并各 CLI 的原生会话历史、不转换工具调用记录、
不保存模型思维过程、不保存完整终端输出/文件正文/完整 diff、不联网同步、不执行 shell、不改项目源文件。

`.ccb` 与当前工作区冲突时，**以当前工作区为准**（权威性顺序：用户明确要求 > 工作区文件与 Git 状态 >
宿主观察到的运行时事实 > `.ccb` 摘要）。

## 开发

```bash
pnpm install
pnpm test        # vitest 行为回归
pnpm typecheck   # tsc --noEmit
pnpm build       # 产出 dist/main.js + dist/manifest.json
```

打分发包：把 `dist/main.js` 与 `manifest.json` 放进同一个文件夹压成 zip（见根目录 `pnpm build` 后的 `dist/`）。
