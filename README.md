# Client Context Bridge (CCB)

CCGUI 市场插件。在不同 AI CLI 客户端（Claude Code / Codex CLI / Gemini CLI / OMP …）之间切换时，
自动维护当前任务的可执行上下文，并在目标客户端的新会话里以一次性内部提示注入，不需要手写交接说明。

- 插件 id：`ccgui.client-context-bridge`
- 交付形式：市场插件，不进 CCGUI 默认构建
- 默认状态：全局默认**关闭**，项目没有隐式启用；由用户主动开启全局默认或单独启用项目
- 上下文文件：`<ccgui-data>/plugin-data/ccgui.client-context-bridge/<workspace-id>.ccb`（UTF-8 JSON）
- 插件不引入 SQLite 或 Protobuf；宿主对各 CLI 原生历史格式的读取与 `.ccb` 存储独立。

## 硬性前提：需要 SDK 0.3.12 或更高版本的配套宿主

本插件 `manifest.json` 声明 `sdkVersion: ">=0.3.12"`，保留最低版本要求并允许 `0.3.16` 及后续更高版本宿主通过握手，不再精确 pin。低于 `0.3.12` 时插件管理会拒绝加载。
宿主仍须提供下列通用接口；版本范围放行不代表缺失的接口会自动补齐，仅升级 AI CLI 也不能补齐宿主接口。

需要配套的宿主构建：`desktop-cc-gui` 分支 `feat/client-context-bridge` 的 Windows 产物
（CI workflow `Build Windows artifact`，产物名 `ccgui-windows-x64`）。宿主侧新增的通用接口：

| 接口 | 用途 |
|---|---|
| `ctx.hooks.registerSessionHooks` | 观察会话新建、恢复与关闭 |
| `ctx.hooks.registerTurnHooks` | 观察运行时事实与回合结算；以稳定 `turnId` 关联 |
| `ctx.hooks.registerRuntimeSwitchHooks` | 以稳定 `switchId` 关联客户端切换，拒绝旧生命周期的迟到完成 |
| `TurnHooks.beforeTurn` 返回内部 `PromptContribution` | 启动成功后、回合结算前确认接纳，不把失败发送记为已消费 |
| `ctx.documentStorage` | 受控 UTF-8 JSON 文档存储（原子写、备份、CAS） |
| `ctx.workspace.getMetadata()` | 只读工作区身份与 Git 元数据 |
| `ctx.ui.registerWorkspaceMenuItem` | 在目标工作区右键菜单中单独启用或停用桥接 |
| `BeforeTurnResult.isCurrent` | 工作区停用后撤销未发送的提示、内部帧捕获与投递 |

这些都是领域通用接口，宿主里没有任何 CCB 专属类型或状态机。

## 安装（zip 包）

CCGUI 的插件安装走**目录选择**，不接受 zip 文件本身（`plugin_install_from_path` 只接受目录）。

1. 解压 `ccgui-plugin-client-context-bridge-1.0.0.zip`，得到一个文件夹，里面是 `manifest.json` + `main.js`
2. CCGUI → 设置 → 插件管理 → 安装插件 → **选中解压出来的那个文件夹**
3. 在插件管理里启用插件
4. 设置 → Client Context Bridge (CCB) → 按需调整存储位置与有效期；“全局启用跨客户端上下文桥接”默认关闭，只决定未单独设置项目的默认行为
5. 单个项目可在左侧工作区文件夹的右键菜单中选择“启用 CCB”或“停用 CCB”；项目选择优先于全局设置：全局关闭时单独启用仍会运行，全局开启时单独停用仍保持关闭

## 怎么验证它在干活

1. 打开一个已启用 CCB 的工作区，用任意客户端（如 Claude Code）跑一两轮真实对话，涉及改文件或跑命令
2. 在设置 → Client Context Bridge → 查看当前上下文中检查对应项目的已保存内容
3. 在同一工作区把客户端切到另一个（如 Codex CLI），开新会话
4. 新会话的第一条请求会带上一次性交接上下文：任务目标、已完成、待完成、关键决策、
   最近文件、已执行命令与真实结果、建议下一步
5. 目标客户端应当直接接着干，而不是反问"你要我做什么"

上下文文件可以直接看：`C:\Users\<你>\.ccgui-next\plugin-data\ccgui.client-context-bridge\<workspace-id>.ccb`

设置 → Client Context Bridge 的第一张卡片里有「桥接状态」一行，显示最近一次同步的结果：
已同步、等待同步、已降级、写入失败、已从其他客户端接续、已关闭。接续成功时它会显示
「已从其他客户端接续」，`.ccb` 的 `consumption` 也会同时多出一条记录。

已有会话（包括恢复的旧会话和已经聊过几轮的新会话）都可中途启用 CCB。下一次发送会提供完整的 patch 格式与本轮帧标记；只有宿主确认协议已送达后，后续回合才使用简短提醒。恢复会话、只观察到回合结束或发送失败都不会被当成已经完成协议初始化。

模型只返回语义 patch 帧，`.ccb` 的创建、读取和写入由插件完成，不需要模型寻找文件或了解磁盘格式。仅点击启用开关不会立即创建文件；插件在启用后跟踪到的回合结算时保存上下文，即使没有有效 patch 也可保存基础事实并标记降级。若启用时已有请求正在执行，完整协议从下一次发送起生效；不会回溯补采启用前的事件。

### 停用后的行为

- 单独停用工作区，或关闭全局默认且该工作区未单独设置时，该工作区不再追加自动维护提示，也不再开始自动上下文读写；已经发出的存储请求可能完成，但不会触发后续读取、重试或写入，也不会在设置页返回迟到的自动读取内容。手动查看、导出和清除仍可使用。
- 全局关闭不会停止单独启用的工作区；全局开启也不会覆盖单独停用的工作区。没有单独选择的工作区跟随全局默认。
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
