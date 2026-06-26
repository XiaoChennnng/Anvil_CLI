# Anvil

**AI-Driven CLI 编程助手** —— 在终端里锻造代码。

多提供商 AI 客户端 + 全屏 TUI + 自主 Agent + 工具系统 + MCP 扩展 + 团队协作，一站式终端开发环境。

## 特性

### AI 引擎

- **多提供商**：DeepSeek / Kimi ，支持添加OpenAI Chat Completions 与 Anthropic Messages API 协议模型
- **多模态**：Kimi K2.x 系列支持图片输入、截图分析、UI 元素识别
- **Computer Use**：截图、点击、输入、拖拽、滚动，AI 直接控制桌面
- **自主 Agent 循环**：自动规划 → 执行 → 验证 → 复盘，无需中间干预
- **思考模式**：DeepSeek (reasoning\_effort + thinking) / Kimi (thinking) / OpenAI (reasoning\_effort) / Anthropic (thinking + budget) 各家差异自动适配

### 上下文管理

- **6 层 Tier 架构**：Immutable → CacheFriendly → WorkingMemory → FileContext → Archive → Transient
- **5 级自适应压缩**：softWarn（>70%）→ light（>80%）→ medium（>90%）→ heavy（>95%）→ critical（>98%）
- **相位感知**：explore / implement / debug / review 阶段动态调整策略与 keepRounds
- **语义预算压缩**：调 LLM 生成结构化摘要，硬性约束到 1w-5w tokens
- **Tool 配对校验**：API 出口处过滤孤立 tool 消息
- **Memory 注入**：`.anvil/Memory.md` 自动加载到 Tier 1.5

### 工具系统

- **文件**：read / write / edit / glob / grep，全路径安全校验
- **代码分析**：符号、引用、定义、依赖（基于 LSP 语义）
- **Shell**：执行 + GBK 编码兼容（Windows 中文输出）
- **Computer Use**：截图、点击、输入、键盘、拖拽、滚动
- **联网搜索**：Bing / DuckDuckGo / SearXNG 三引擎，5 分钟 LRU 缓存，自动降级
- **网页抓取**：URL → 正文提取，三模式（article / text / html）
- **Todo 管理**：任务跟踪、列表、清空、完成检测
- **MCP 协议**：动态添加/移除外部工具
- **团队协作**：多 Agent 串行协作，自动任务分解与结果汇总
- **技能系统**：自定义 slash command，启动时扫描 `.anvil/skills/`

### 用户体验

- **统一状态符号**：`✓` / `[失败]` / `[暂停]` / `[列表]`，全局视觉规范
- **上下文使用率**：状态栏实时显示，>70% 警告，>98% 极限压缩
- **会话持久化**：`.anvil/sessions/`，`npm start -- -r <sessionId>` 恢复
- **日志系统**：日期轮转 `.anvil/logs/YYYY-MM-DD.log`
- **流式渲染**：32KB 反压限流 + 50ms 节流队列 + 差量屏幕缓冲

## 快速开始

### 安装

```bash
git clone <repo-url> && cd anvil
npm install
npm run install-global    # 一键全局安装
```

验证：

```bash
anvil --version
anvil --help
```

### 配置 API Key

按所选提供商设置环境变量：

```bash
export DEEPSEEK_API_KEY=sk-xxx       # DeepSeek
export MOONSHOT_API_KEY=sk-xxx       # Kimi
export OPENAI_API_KEY=sk-xxx         # OpenAI
export ANTHROPIC_API_KEY=sk-ant-xxx  # Anthropic
```

### 启动

```bash
anvil                       # 当前目录启动
anvil -d /path/to/project   # 指定工作目录
npx anvil -d ./project      # 临时使用（无需全局安装）
```

首次启动自动打开配置向导，引导设置工作目录、提供商、API Key、默认模型。

## 模型配置

### 内置提供商

| 提供商      | 模型        | 上下文  | 多模态 | 思考模式 |
| -------- | --------- | ---- | --- | ---- |
| DeepSeek | V4 Flash  | 1M   | -   | 支持   |
| DeepSeek | V4 Pro    | 1M   | -   | 支持   |
| Kimi     | K2.5      | 256K | 支持  | 支持   |
| Kimi     | K2.6      | 256K | 支持  | 支持   |
| Kimi     | K2.7 Code | 256K | 支持  | 支持   |

> OpenAI / Anthropic 无预设模型，通过 `/model add` 自行添加。

### 自定义提供商

```bash
/provider add my-openai "My OpenAI" https://api.openai.com/v1 sk-xxx openai false
```

参数：`id` `名称` `baseURL` `apiKey` `format` `thinkingMode`

### 自定义模型

```bash
/model add gpt-4o "GPT-4o" true true 128000
```

参数：`id` `名称` `vision` `thinkingMode` `contextWindow`

## 使用

### 内置命令

| 命令                                   | 作用           |
| ------------------------------------ | ------------ |
| `/help`                              | 帮助信息         |
| `/keys`                              | 快捷键列表        |
| `/clear`                             | 清屏           |
| `/provider [id]`                     | 切换或查看提供商     |
| `/provider add ...`                  | 添加自定义提供商     |
| `/model [id]`                        | 切换或查看模型      |
| `/model add ...`                     | 添加自定义模型      |
| `/review [file]`                     | 代码审查         |
| `/todo add \| done \| list \| clear` | 任务管理         |
| `/plan`                              | 计划模式         |
| `/undo` / `/redo`                    | 撤销 / 重做      |
| `/mcp`                               | 查看 MCP 状态    |
| `/skills`                            | 查看已加载 Skills |
| `/team`                              | 团队协作模式（`/team status/dissolve/help`）|

### 快捷键

| 按键                    | 作用                              |
| --------------------- | ------------------------------- |
| `Enter`               | 发送                              |
| `Ctrl+J`              | 换行                              |
| `↑` / `↓`             | 浏览历史                            |
| `Ctrl+C`              | 中断回复                            |
| `Ctrl+D`              | 退出                              |
| `Ctrl+U`              | 清空输入                            |
| `Ctrl+T`              | 切换团队事件详情面板（Team Mode 运行时）         |
| `Home` / `End`        | 行首 / 行尾                         |
| `PageUp` / `PageDown` | 翻页（或在 Team Panel 内滚动事件）          |

## Computer Use

支持多模态模型直接控制电脑。

### 工作流

1. **截图观察**：AI 调用 `computer` 工具获取当前屏幕
2. **分析规划**：识别目标元素坐标（必要时用 `computer_get_screen_size` 换算）
3. **执行操作**：移动 / 点击 / 输入 / 拖拽 / 滚动
4. **验证结果**：再次截图确认

### 安全机制

- 所有动作需要 `requiresConfirm` 弹出确认
- AI 必须先截图分析坐标再执行（避免盲操作）
- 可随时 `Ctrl+C` 中断操作序列

## Team Mode（团队协作）

AI 主动评估任务复杂度，符合阈值时启动多 Agent 串行协作（按角色顺序逐个执行，避免文件冲突）。每个 Agent 独立上下文 + 工具调用，主 Agent 对执行过程透明。

### 触发方式

- **自动评估**：AI 根据 L5 Team Mode 规则判断任务复杂度，符合阈值时调用 `start_team_task` 工具启动。
- **手动控制**：通过 `/team` 命令随时查看状态 / 强制解散。

### `/team` 子命令

| 子命令 | 作用 |
|--------|------|
| `/team` 或 `/team status` | 显示当前团队状态（teamId / state / agentCount / 各 agent 详情） |
| `/team panel` | 打开团队事件详情面板（完整 thinking/content/tool_call 流） |
| `/team dissolve` | 强制解散当前团队（跳过状态机校验，立即终止所有子 Agent） |
| `/team help` | 显示帮助 |

### 三档可观测性（M1-M5）

团队运行过程中用户**绝对不丢失对子 Agent 进度的掌控**，按详细程度分三档：

1. **侧边栏常驻（基础）** — 团队运行时侧边栏自动展示每个活跃 Agent 的状态卡片：`▸ 0001 executor [thinking] 正在分析模块依赖...`，含角色 + 状态（◐thinking ●streaming ✓done ✗failed）+ 最近 30 字预览。Agent 卡片行数自适应（窄终端 2 行保底，宽终端按 viewport - 16 扩展）。
2. **状态栏临显（活动提示）** — 状态栏中间填充区显示 `▸ researcher [thinking 1.2s]`，1 行临时标识当前活跃 Agent。优先级：主 Agent thinking > 团队活动 > 系统 info 消息。3 秒 TTL 兜底。
3. **modal 详情面板（按需展开）** — 输入 `/team panel` 或按 `Ctrl+T` 打开全屏事件日志，含完整 thinking/content/tool_call 时间线，支持 ↑↓ 滚动 / PageUp PageDown / `1-9` 切换 agent 过滤 / `0` 清除过滤 / `Esc` 关闭。**主消息区"暂停滚动，保留显示"**——打开 modal 时不渲染但 `renderedLines` 保留，关闭后从断点继续无内容丢失。

### 团队角色

| 角色 | 职责 |
|------|------|
| `architect` | 方案设计 + 架构决策 |
| `executor` | 具体实现（可多个并行） |
| `reviewer` | 质量检查 + 代码审查 |
| `coordinator` | 整合协调 + 任务分发 |

复杂度阈值决定 Agent 数量：

- score < 25：不启动团队（主 Agent 直接处理）
- 25 ≤ score < 50：1 个 executor
- 50 ≤ score < 75：1 architect + 2 executor
- score ≥ 75：4 角色齐全（architect + 2 executor + reviewer + coordinator）

### UI 标识

- **状态栏**：团队运行时显示 `⫼ Team (N)` widget（N 为 agent 数量）+ 中间填充区显示当前活跃 Agent（`▸ researcher [thinking 1.2s]`），与 `⎔ Plan Mode` 标识并列
- **侧边栏**：Team Mode 状态区显示 ID 末 8 位 / Agents 数量 / State / 每个 agent 1 行状态卡片（角色 + 状态 + 最近 preview），agent 多于可视行数时显示 `+N more (Ctrl+T 展开)`
- **状态消息**：启动/解散时打印 `[团队模式] 已启动 (N 个 Agent)`
- **事件详情面板**：`/team panel` 或 `Ctrl+T` 打开全屏事件日志（含完整 thinking/content/tool_call 流，↑↓/PgUp/PgDn 滚动，1-9 过滤 agent，Esc 关闭，主消息区保留不丢内容）

### 关键事件

| 事件 | 触发时机 |
|------|----------|
| `team_mode_start` / `team_mode_end` | 团队模式生命周期 |
| `agent_started` / `agent_completed` | 子 Agent 任务开始/完成 |
| `state_changed` | 团队状态机转换（IDLE → PLANNING → EXECUTING → AGGREGATING → COMPLETE → DISSOLVED） |
| `subagent_usage` | 子 Agent token 计费归属主会话 |

### 中断与清理

- **Ctrl+C**：主 Agent 中断会强制解散团队，所有子 Agent 立即终止（不再后台烧 token）
- **空闲超时**：IDLE 状态下 5 分钟自动解散
- **单 Agent 超时**：30 分钟硬超时
- **错误恢复**：Agent 失败时 `errorHandler` 决策回退策略（重试 / 跳过 / 终止）

### 配置（`.anvil/config.json`）

```json
{
  "team": {
    "enabled": true,
    "complexityThreshold": { "low": 25, "medium": 50, "high": 75 },
    "dissolveIdleTimeout": 300000,
    "subagentTimeout": 1800000,
    "defaultSubagentModel": "deepseek-chat",
    "maxIterations": 50,
    "maxRetries": 3,
    "retryDelays": [1000, 3000, 10000],
    "heartbeat": { "interval": 30000, "timeout": 90000 }
  }
}
```

### 状态机

```
IDLE → PLANNING → EXECUTING → AGGREGATING → COMPLETE → DISSOLVED
  ↑                                              ↓
  └──────────── force dissolve (interrupt) ──────┘
```

COMPLETE 是必经节点，所有正常路径都会经过（修复前流程跳过 COMPLETE 是已知 bug）。

## 架构

### 分层结构

```
入口层    bin/anvil.js              启动入口 + cwd 修正（npm start 场景）

CLI 层    src/cli/                  主流程 + 事件总线 + 命令
  index.js                              事件总线、输入循环
  commands.js                            内置命令（/help /provider /model /todo ...）
  options.js                             命令行参数解析

引擎层    src/core/                 核心引擎
  chat.js                                ChatEngine（EventEmitter），状态机
  context.js                             6 层 Tier + 5 级压缩 + Memory 注入
  session.js                             会话持久化
  todo.js                                Todo 管理
  web_search/                            联网搜索（Bing / DuckDuckGo / SearXNG）
  team/                                  多 Agent 并行协作

AI 层     src/ai/                  AI 客户端
  client.js                              双协议（OpenAI / Anthropic）+ 流式 + 重试
  providers.js                           多提供商配置 + 模型上下文窗口探测
  models.js                              模型定义 + 定价
  prompts.js                             6 级分层 System Prompt（L0-L4）
  cache.js                               会话级 LRU 缓存

工具层    src/tools/               工具注册
  registry.js                            统一注册中心 → OpenAI schema
  file.js / code.js / command.js         文件 / 代码分析 / Shell
  computer_use.js / web_search.js        Computer Use / 联网搜索
  web_fetch.js / todo.js                 网页抓取 / Todo
  context.js / memory.js                 上下文压缩 / Memory 工具
  plan_mode.js / team_tools.js           计划模式 / 团队工具
  mcp.js / skill.js                      MCP / 技能
  question.js / task_complete.js         用户提问 / 任务完成

MCP 层    src/mcp/                 MCP 服务器管理
  manager.js                             连接 / 断开 / 重试 / 状态
  transport.js                           stdio / SSE / HTTP 传输
  integration.js                         工具桥接热挂载

配置层    src/config/              配置系统
  loader.js                              加载 + 合并（命令行 > 环境变量 > 项目 > 全局 > 默认）
  defaults.js                            默认配置 + i18n
  setup.js                               首次启动向导
  logger.js                              日期轮转日志
  proxy.js                               代理解析

UI 层     src/ui/                  TUI 自绘
  tui.js                                 组件容器 + 光标控制 + 32KB 反压限流
  render-queue.js                        20ms 节流队列
  ansi.js / theme.js / markdown.js       CJK 宽度截断 / 主题 / Markdown 渲染
  diff.js / tokens.js                    Diff 展示 / Token 统计
  tool-renderer.js                       工具调用渲染
  components/                            布局 / 消息 / 侧边栏 / 编辑器 / 状态栏
```

### 数据流

```
用户输入
    |
    v
CLI 事件总线 (src/cli/index.js)
    |
    v
ChatEngine (src/core/chat.js)
    |                            上行事件: thinking / content / tool_calls
    |                            tool_result / usage / complete / error
    |                            下行事件: processInput / interrupt
    |                                       approvePlan / resolveQuestion
    v
AI Client (src/ai/client.js) --- 协议适配 --- 提供商 API
    |                                     (DeepSeek / Kimi / OpenAI / Anthropic)
    v
工具执行
    |    文件 / Shell / Computer / 联网 / Todo / Memory / MCP
    v
结果回流 + 上下文管理
    |    6 层 Tier + 5 级压缩 + Memory 注入 + 工具配对校验
    v
TUI 渲染 (src/ui/)
```

### 关键模块

**ChatEngine**（src/core/chat.js）

- 状态机：`_planMode` / `_awaitingPlanApproval` / `teamManager`
- 事件总线：上行 (AI→UI) 与下行 (UI→Engine) 完全双向
- Tool 配对校验：API 出口处自动过滤孤立 tool 消息，杜绝 OpenAI 400
- 工具执行 + 中断恢复 + 上下文压缩集成

**ContextManager**（src/core/context.js）

- 6 层 Tier：System / Project / Working / File / Archive / Transient
- 5 级压缩：从软警告到极限压缩自动触发
- 相位感知：根据 explore / implement / debug / review 动态调整 keepRounds
- Memory 注入：`.anvil/Memory.md` 启动时自动加载到 Tier 1.5
- Token 校准：根据实际 API usage 反馈修正估算

**AI Client**（src/ai/client.js）

- 双协议：OpenAI Chat Completions / Anthropic Messages API 自动识别
- 流式输出：thinking / content / tool\_calls 实时回流
- 思考模式：四家提供商参数差异统一封装
- 缓存命中：DeepSeek `prompt_cache_hit_tokens` / Anthropic `prompt_caching_tokens` / OpenAI `cached_tokens` 统一转换
- 错误重试：网络错误 + 5xx 自动重试，4xx 透传

**ToolRegistry**（src/tools/registry.js）

- 统一注册：`register({ name, description, parameters, execute, requiresConfirm })`
- OpenAI Schema 转换：`getOpenAITools()`
- 热挂载：MCP 工具动态注册
- 路径安全：所有文件工具过 `isPathSafe()` 校验

## 配置

### 优先级

命令行参数 > 环境变量 > 项目配置 > 全局配置 > 默认值

### 环境变量

| 变量                           | 说明                |
| ---------------------------- | ----------------- |
| `DEEPSEEK_API_KEY`           | DeepSeek API Key  |
| `MOONSHOT_API_KEY`           | Kimi API Key      |
| `OPENAI_API_KEY`             | OpenAI API Key    |
| `ANTHROPIC_API_KEY`          | Anthropic API Key |
| `HTTP_PROXY` / `HTTPS_PROXY` | 代理                |
| `ANVIL_PROJECT_DIR`          | 默认工作目录            |
| `WEB_SEARCH_TIMEOUT`         | 联网搜索超时（毫秒）        |
| `WEB_SEARCH_DISABLED`        | `=1` 禁用联网搜索       |

### 配置文件

- 项目级：`.anvil/config.json`
- 全局级：`~/.anvil/config.json`

```json
{
  "provider": "deepseek",
  "apiKey": "sk-xxx",
  "defaultModel": "deepseek-v4-flash",
  "baseURL": "https://api.deepseek.com",
  "thinkingMode": true,
  "theme": "auto",
  "mcpServers": {},
  "webSearch": {
    "enabled": true,
    "maxResults": 8,
    "timeout": 15000,
    "locale": "zh-CN"
  }
}
```

### .anvil 目录结构

```
.anvil/
├── config.json         # 项目级配置
├── logs/               # 日期轮转日志 (YYYY-MM-DD.log)
├── sessions/           # 会话持久化 (<sessionId>.json)
├── checkpoints/        # 异常恢复检查点
├── Memory.md           # 用户长期记忆（自动加载到 Tier 1.5）
└── skills/             # 自定义技能目录
    ├── my-skill.md
    └── my-skill-pack/SKILL.md
```

## 开发

```bash
npm start              # 开发模式启动
npm test               # 全部 Jest 测试
npm run test:unit      # 单元测试
npm run test:integration  # 集成测试（需 WEB_SEARCH_INTEGRATION=1）
npm run lint           # ESLint 检查 src/
npm run format         # Prettier 格式化 src/**/*.js
```

测试覆盖率门槛：branches 60% / functions 70% / lines 70% / statements 70%。

## 调试

- **实时日志**：`.anvil/logs/YYYY-MM-DD.log`
- **会话恢复**：`npm start -- -r <sessionId>`
- **技能目录**：`.anvil/skills/` 放自定义 skill（`.md` 文件或含 `SKILL.md` 的子目录）
- **TUI 渲染卡顿**：检查 `src/ui/tui.js` 的 `MAX_RENDER_OUTPUT`（32KB）是否被超长输出打爆
- **联网搜索调试**：`node -e "require('./src/core/web_search').search('关键词', {maxResults:3}, {config:{webSearch:{}}}).then(console.log)"`

## 技术栈

| 层    | 技术                                        |
| ---- | ----------------------------------------- |
| 运行时  | Node.js 18+ (CommonJS)                    |
| AI   | DeepSeek / Kimi / OpenAI / Anthropic      |
| CLI  | Commander.js                              |
| UI   | Ink + Chalk + marked-terminal             |
| 自动化  | @hurdlegroup/robotjs + screenshot-desktop |
| MCP  | @modelcontextprotocol/sdk                 |
| 测试   | Jest                                      |
| 代码检查 | ESLint (Flat Config) + Prettier           |

## 许可

[Apache-2.0 license](https://github.com/XiaoChennnng/Anvil_CLI#Apache-2.0-1-ov-file)
