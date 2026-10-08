# Client Context Bridge (CCB)

CCGUI 市场插件。在不同 AI CLI 客户端（Claude Code / Codex CLI / Gemini CLI / OMP …）之间切换时，
自动维护当前任务的可执行上下文，并在目标客户端的新会话里以一次性内部提示注入，不需要手写交接说明。

- 插件 id：`ccgui.client-context-bridge`
- 交付形式：市场插件，不进 CCGUI 默认构建
- 默认状态：全局默认**关闭**，项目没有隐式启用；由用户主动开启全局默认或单独启用项目
- 上下文文件：`<ccgui-data>/plugin-data/ccgui.client-context-bridge/<workspace-id>.ccb`（UTF-8 JSON）
- 插件不引入 SQLite 或 Protobuf；宿主对各 CLI 原生历史格式的读取与 `.ccb` 存储独立。
- 主分支：`main`。原 `fix/sdk-03-compat` 已迁入，后续开发与分发均以 `main` 为准。

## 宿主兼容与权限

上游 `desktop-cc-gui` 的 SDK **0.3.20** 已包含 CCB 所需通用接口，不再要求使用旧的
`feat/client-context-bridge` 专用分支。已核对的上游源码为
[`9c147cb3e`](https://github.com/zhukunpenglinyutong/desktop-cc-gui/tree/9c147cb3e2b2ecb55336e776b51ce84594c98919)。

`manifest.json` 保留 `sdkVersion: ">=0.3.17"`，继续兼容已提供这些接口的旧配套宿主。
这不是所有同版本上游构建都具备 CCB 能力的保证：版本握手通过后，宿主仍须提供下列接口。
仅升级 AI CLI 不能补齐宿主接口。

| 接口 | 必需权限 | 用途 |
|---|---|---|
| `ctx.hooks.registerSessionHooks` | `session.lifecycle.read` | 观察会话新建、恢复与关闭 |
| `TurnHooks.onRuntimeEvent` / `afterTurn` | `runtime.events.read` | 观察运行时事实与回合结算；以稳定 `turnId` 关联 |
| `ctx.hooks.registerRuntimeSwitchHooks` | `runtime.switch.observe` | 以稳定 `switchId` 关联客户端切换，拒绝迟到完成 |
| `TurnHooks.beforeTurn` / `onInternalMessage` | `prompt.contribute.internal` | 提供内部提示并接收内部消息；启动成功后确认接纳，不把失败发送记为已消费 |
| `ctx.documentStorage` | `plugin.storage` | 受控 UTF-8 JSON 文档存储（原子写、备份、CAS、位置选择） |
| `ctx.workspace.getMetadata()` | `workspace.metadata.read` | 只读当前工作区身份与 Git 元数据 |
| `ctx.workspaces.list()` | `host:workspace` | 读取已登记工作区快照，为设置页中的上下文显示项目名 |
| `ctx.ui.registerWorkspaceMenuItem` | `ui:workspace-menu` | 在右键目标工作区单独启用或停用桥接 |
| `ctx.ui.registerSettingsSection` | `ui:settings-section` | 挂载插件设置页 |
| `ctx.storage.get/set` | `storage` | 保存全局设置与逐项目开关 |
| `ctx.i18n.addBundle` / `ctx.events.emit` | `i18n` / `events` | 注册文案、广播桥接状态 |
| `BeforeTurnResult.isCurrent` | 随内部提示贡献授权 | 工作区停用后撤销未发送的提示、内部帧捕获与投递 |

这些都是领域通用接口，宿主里没有任何 CCB 专属类型或状态机。

当前 manifest 已包含 `host:workspace`；`workspace.metadata.read` **不能替代**它。
`network:none` 仅声明不联网，不授予网络访问。本插件不需要额外的 `assets:*`、`exec:*`
或 `host:workspace:remote` 权限；自定义文档目录由 `plugin.storage` 的宿主选择器授权。

完整功能面向桌面 Tauri 客户端。当前上游 Web/LAN 插件桥未开放 KV 写入、工作区元数据与文档存储命令，
因此不能把桌面兼容结论推广到浏览器客户端；补 manifest 权限不会补出这些路由。

## 安装（zip 包）

CCGUI 的插件安装走**目录选择**，不接受 zip 文件本身（`plugin_install_from_path` 只接受目录）。

1. 解压 `ccgui-plugin-client-context-bridge-<version>.zip`，得到一个文件夹，里面是 `manifest.json` + `main.js`
2. CCGUI → 设置 → 插件管理 → 安装插件 → **选中解压出来的那个文件夹**
3. 在插件管理里启用插件
4. 设置 → Client Context Bridge (CCB) → 按需调整存储位置与有效期；“全局启用跨客户端上下文桥接”默认关闭，只决定未单独设置项目的默认行为
5. 单个项目可在左侧工作区文件夹的右键菜单中选择“启用 CCB”或“停用 CCB”；项目选择优先于全局设置：全局关闭时单独启用仍会运行，全局开启时单独停用仍保持关闭

升级时重新安装新包解压后的同 ID 目录：宿主会更新插件文件与保存的权限记录，再热重载。
仅点重载不会把源码目录或新 ZIP 的内容复制到安装目录。

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

## 开发与分发

```bash
npm ci
npm run check:sdk  # 本地 SDK 镜像契约检查
npm test           # vitest 行为回归
npm run typecheck  # tsc --noEmit
```

构建与打包由 GitHub Actions 的 **Test and package plugin** 工作流执行：推送 `main` 自动触发，
也可手动选择 `main` 运行。成功后在该次运行的 Artifacts 下载 `ccgui-plugin-client-context-bridge`，
其中包含安装 ZIP 与 `SHA256SUMS`。ZIP 版本取自 `manifest.json` 的 `version`；解压后的
`ccgui-plugin-client-context-bridge/` 插件目录包含 `manifest.json`、`main.js` 和本文档。

该工作流只生成 CI 产物，不会自动创建 GitHub Release；正式发布时再使用已验证的安装包。
