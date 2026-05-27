# ⚒ Anvil

**AI-Driven CLI Programming Assistant** — 在终端里锻造代码。

基于 DeepSeek V4 API 的全屏 TUI 编程助手，支持自主 Agent 模式、多轮对话、工具调用、MCP 扩展。

## 安装

```bash
node >= 18.0.0

git clone <repo-url> && cd anvil
npm install
```

## 启动

```bash
# 设置 API Key（二选一）
export DEEPSEEK_API_KEY=sk-your-key-here   # Linux/macOS
$env:DEEPSEEK_API_KEY="sk-your-key-here"   # Windows PowerShell

# 启动
npm start
```

首次启动自动打开配置向导，引导设置 API Key 和默认模型。

## 使用

### 对话

直接输入自然语言指令即可：

- `写一个二分查找函数`
- `创建一个 Vue 组件`
- `审查 src/index.js 的代码质量`
- `帮我看看这个报错`

### 快捷键

| 按键         | 作用    |
| ---------- | ----- |
| `Enter`    | 发送    |
| `Ctrl+J`   | 换行    |
| `↑/↓`      | 浏览历史  |
| `Ctrl+C`   | 中断回复  |
| `Ctrl+D`   | 退出    |
| `Ctrl+U`   | 清空输入  |
| `←/→`      | 移动光标  |
| `Home/End` | 行首/行尾 |

### 内置命令

| 命令               | 作用        | <br /> | <br />  | <br /> |
| ---------------- | --------- | :----- | :------ | :----- |
| `/help`          | 帮助信息      | <br /> | <br />  | <br /> |
| `/keys`          | 快捷键列表     | <br /> | <br />  | <br /> |
| `/clear`         | 清屏        | <br /> | <br />  | <br /> |
| `/model <name>`  | 切换模型      | <br /> | <br />  | <br /> |
| `/review [file]` | 代码审查      | <br /> | <br />  | <br /> |
| \`/todo add      | done      | list   | clear\` | 任务管理   |
| `/plan`          | 计划模式      | <br /> | <br />  | <br /> |
| `/compact`       | 手动压缩上下文   | <br /> | <br />  | <br /> |
| `/undo /redo`    | 撤销/重做     | <br /> | <br />  | <br /> |
| `/mcp`           | 查看 MCP 状态 | <br /> | <br />  | <br /> |
| `/skill [name]`  | 技能系统管理   | <br /> | <br />  | <br /> |

## 模型

| 模型                | 用途        | 定价（元/千tokens）       |
| ----------------- | --------- | ------------------- |
| DeepSeek V4 Flash | 日常开发、快速生成 | 输入 0.001 / 输出 0.002 |
| DeepSeek V4 Pro   | 复杂推理、深度分析 | 输入 0.003 / 输出 0.006 |

## 配置

优先级：**命令行 > 环境变量 > 项目配置 > 全局配置 > 默认值**

```bash
# 命令行参数
node bin/anvil.js -d /path/to/project -m deepseek-v4-pro --no-thinking

# 环境变量
DEEPSEEK_API_KEY     # API Key
HTTP_PROXY           # HTTP 代理
HTTPS_PROXY          # HTTPS 代理
ANVIL_PROJECT_DIR    # 默认工作目录
```

配置文件（JSON）：

- 项目级：`.anvil/config.json`
- 全局级：`~/.anvil/config.json`

```json
{
  "apiKey": "sk-xxx",
  "defaultModel": "deepseek-v4-flash",
  "thinkingMode": true,
  "theme": "auto",
  "mcpServers": {}
}
```

## 特性

### 自主 Agent 循环

接收任务后自动规划、执行、验证、检查，直到任务完成，无需中间干预。

### 上下文管理

多层级上下文窗口（默认 1M tokens），支持自适应渐进压缩：

- **6 层架构**：System Prompt → 项目概览 → 工作记忆 → 文件上下文 → 压缩存档 → 瞬时结果
- **5 级压缩**：从轻度警告到极限压缩，自动触发
- **相位感知**：根据探索/实现/调试/审查阶段动态调整策略

### MCP 扩展

支持 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，AI 可在对话中动态添加/移除外部工具：

```
/mcp 查看状态
AI 自动调用 mcp_add_server / mcp_remove_server
```

### 团队协作模式

支持多 Agent 并行工作，自动分解任务并协同完成：

- **自动任务分解**：复杂任务自动拆分为子任务，分配给多个 Agent 并行执行
- **结果聚合**：各 Agent 结果自动汇总，形成完整解决方案
- **错误处理**：支持重试和降级策略，保证任务可靠性
- **使用方式**：输入 `/team` 命令开启团队模式

### 技能系统

支持自定义技能（slash commands）：

- **技能文件**：放在 `.anvil/skills/` 目录下
- **独立文件**：每个技能是独立的 JS 文件
- **注册机制**：启动时自动扫描并注册可用技能
- **使用方式**：输入 `/skill` 查看可用技能列表

## 架构

```
bin/anvil.js             入口
src/
├── cli/                 主流程 + 命令处理
│   ├── index.js         启动、事件总线、输入循环
│   ├── commands.js      内置命令（/model /todo 等）
│   └── options.js       命令行参数解析
├── ai/                  AI 客户端
│   ├── client.js        DeepSeek API（流式 + 思考模式 + 自动重试）
│   ├── cache.js         会话级 LRU 缓存
│   ├── models.js        模型定义
│   └── sensitive.js     输出敏感内容过滤
├── core/                核心引擎
│   ├── chat.js          对话引擎 + 自主 Agent 循环
│   ├── context.js       智能上下文管理（压缩 + 相位检测）
│   ├── session.js       会话持久化
│   ├── todo.js          Todo 管理器
│   └── team/            团队协作模式
├── tools/               工具系统
│   ├── registry.js      工具注册中心
│   ├── file.js          文件读写/编辑/删除
│   ├── code.js          代码分析（符号/引用/定义）
│   ├── command.js       命令执行
│   ├── todo.js          Todo 工具
│   ├── question.js      用户提问工具
│   ├── task_complete.js 任务完成声明
│   ├── context.js       上下文压缩工具
│   ├── mcp.js           MCP 管理工具
│   └── skill.js         技能系统
├── mcp/                 MCP 服务器管理
│   ├── manager.js       连接/断开/重试
│   ├── transport.js     传输层（stdio/SSE/HTTP）
│   └── integration.js   工具桥接
├── config/              配置系统
│   ├── loader.js        加载/合并配置
│   ├── defaults.js      默认值
│   ├── setup.js         首次启动向导
│   ├── logger.js        日期轮转日志
│   └── proxy.js         代理解析
└── ui/                  TUI 全屏界面
    ├── tui.js           主入口
    ├── components/
    │   ├── layout.js    分栏布局（消息区/编辑器/状态栏）
    │   ├── message-box.js  消息渲染
    │   ├── message.js   消息行渲染
    │   ├── sidebar.js   侧边栏（Todo/上下文/缓存）
    │   ├── editor.js    输入编辑器
    │   ├── status-bar.js  状态栏
    │   └── question-panel.js  问答面板
    ├── markdown.js      Markdown 渲染
    ├── diff.js          Diff 展示
    ├── theme.js         暗色/亮色主题
    ├── tokens.js        Token 统计
    ├── renderer.js      备用渲染器
    └── ...
```

## 开发

```bash
npm test          # 运行测试
npm run lint      # 代码检查
npm run format    # 格式化
```

## 技术栈

| 层   | 技术                        |
| --- | ------------------------- |
| 运行时 | Node.js 18+ (CommonJS)    |
| AI  | DeepSeek V4 (OpenAI SDK)  |
| CLI | Commander.js              |
| UI  | Chalk + marked-terminal   |
| MCP | @modelcontextprotocol/sdk |
| 测试  | Jest                      |

## 许可

[Apache-2.0 license](https://github.com/XiaoChennnng/Anvil_CLI#Apache-2.0-1-ov-file)
