# ⚒ Anvil

**AI-Driven CLI Programming Assistant** — 在终端里锻造代码。

基于多模态 AI 的全屏 TUI 编程助手，支持 DeepSeek、Kimi、OpenAI、Anthropic 等多家模型提供商，具备自主 Agent 模式、多轮对话、工具调用、MCP 扩展、Computer Use 电脑控制等能力。

## 特性

### 多模型提供商支持

支持多家 AI 提供商，灵活切换：

| 提供商 | 模型 | 特点 |
|--------|------|------|
| DeepSeek | V4 Flash / V4 Pro | 中文优秀、支持思考模式 |
| Kimi | K2.5 / K2.6 / K2.7 | 超长上下文 (256K)、支持多模态 |
| OpenAI | GPT-4o / o1 / o3 | 需自行添加模型配置 |
| Anthropic | Claude 3.5/3.7 Sonnet | 需自行添加模型配置 |

支持自定义提供商和模型，兼容 OpenAI Chat Completions 和 Anthropic Messages API 格式。

### Computer Use 电脑控制

支持多模态模型（如 Kimi K2.5）控制电脑：

- **截图** - 获取屏幕状态供 AI 分析
- **点击** - 在指定坐标点击鼠标
- **输入** - 键盘输入文本
- **移动** - 移动鼠标到目标位置
- **拖拽** - 拖拽操作
- **滚动** - 滚动页面内容

使用场景：自动化操作、界面测试、流程演示等。

### 多模态支持

支持图片输入，可以：
- 分析截图内容
- 识别 UI 元素位置
- 理解视觉信息并执行相应操作

### 自主 Agent 循环

接收任务后自动规划、执行、验证、检查，直到任务完成，无需中间干预。

### 上下文管理

多层级上下文窗口（支持 1M tokens），支持自适应渐进压缩：

- **6 层架构**：System Prompt → 项目概览 → 工作记忆 → 文件上下文 → 压缩存档 → 瞬时结果
- **5 级压缩**：从轻度警告到极限压缩，自动触发
- **相位感知**：根据探索/实现/调试/审查阶段动态调整策略

### MCP 扩展

支持 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，AI 可在对话中动态添加/移除外部工具。

### 团队协作模式

支持多 Agent 并行工作，自动分解任务并协同完成。

### 技能系统

支持自定义技能（slash commands），放在 `.anvil/skills/` 目录下自动加载。

### 联网搜索

内置 `web_search` 工具，AI 可主动联网查最新版本、官方文档、新闻等实时信息。

## 安装

```bash
node >= 18.0.0

git clone <repo-url> && cd anvil
npm install
```

## 启动

```bash
# 设置 API Key（根据所选提供商）
export DEEPSEEK_API_KEY=sk-your-key-here   # DeepSeek
export MOONSHOT_API_KEY=sk-your-key-here   # Kimi
export OPENAI_API_KEY=sk-your-key-here     # OpenAI
export ANTHROPIC_API_KEY=sk-ant-...        # Anthropic

# 启动
npm start
```

首次启动自动打开配置向导，引导设置：
- 项目工作目录
- 模型提供商
- API Key
- 默认模型

## 使用

### 对话

直接输入自然语言指令即可：

- `写一个二分查找函数`
- `创建一个 Vue 组件`
- `审查 src/index.js 的代码质量`
- `帮我看看这个报错`
- `打开浏览器访问 example.com` (Computer Use)

### 快捷键

| 按键 | 作用 |
|------|------|
| `Enter` | 发送 |
| `Ctrl+J` | 换行 |
| `↑/↓` | 浏览历史 |
| `Ctrl+C` | 中断回复 |
| `Ctrl+D` | 退出 |
| `Ctrl+U` | 清空输入 |
| `←/→` | 移动光标 |
| `Home/End` | 行首/行尾 |
| `PageUp/Down` | 翻页 |

### 内置命令

| 命令 | 作用 |
|------|------|
| `/help` | 帮助信息 |
| `/keys` | 快捷键列表 |
| `/clear` | 清屏 |
| `/provider [id]` | 切换或查看提供商 |
| `/provider add <id> <name> <url> <key>` | 添加自定义提供商 |
| `/model [id]` | 切换或查看模型 |
| `/model add <id> <name>` | 添加自定义模型 |
| `/review [file]` | 代码审查 |
| `/todo add \| done \| list \| clear` | 任务管理 |
| `/plan` | 计划模式 |
| `/compact` | 手动压缩上下文 |
| `/undo /redo` | 撤销/重做 |
| `/mcp` | 查看 MCP 状态 |
| `/skills` | 查看已加载 Skills |
| `/team` | 团队协作模式 |

## 模型配置

### 内置模型

| 模型 | 上下文窗口 | 多模态 | 思考模式 |
|------|------------|--------|----------|
| DeepSeek V4 Flash | 1M | ✗ | ✓ |
| DeepSeek V4 Pro | 1M | ✗ | ✓ |
| Kimi K2.5 | 256K | ✓ | ✓ |
| Kimi K2.6 | 256K | ✓ | ✓ |
| Kimi K2.7 Code | 256K | ✓ | ✓ |

### 自定义提供商

```bash
/provider add my-openai "My OpenAI" https://api.openai.com/v1 sk-xxx openai false
```

参数：`id` `名称` `baseURL` `apiKey` `format(openai/anthropic)` `thinkingMode`

### 自定义模型

```bash
/model add gpt-4o "GPT-4o" true true 128000
```

参数：`id` `名称` `vision(true/false)` `thinkingMode(true/false)` `contextWindow`

## 配置

优先级：**命令行 > 环境变量 > 项目配置 > 全局配置 > 默认值**

```bash
# 命令行参数
node bin/anvil.js -d /path/to/project -m kimi-k2.5 --no-thinking

# 环境变量
DEEPSEEK_API_KEY       # DeepSeek API Key
MOONSHOT_API_KEY       # Kimi API Key
OPENAI_API_KEY         # OpenAI API Key
ANTHROPIC_API_KEY      # Anthropic API Key
HTTP_PROXY             # HTTP 代理
HTTPS_PROXY            # HTTPS 代理
ANVIL_PROJECT_DIR      # 默认工作目录
WEB_SEARCH_TIMEOUT     # 联网搜索超时（毫秒）
WEB_SEARCH_DISABLED    # =1 禁用联网搜索
```

配置文件（JSON）：

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

## Computer Use 使用指南

Computer Use 功能允许 AI 控制你的电脑，**仅在使用支持多模态（vision）的模型时可用**（如 Kimi K2.5）。

### 操作流程

1. **截图观察** - AI 调用 `computer` 工具获取屏幕截图
2. **分析规划** - AI 分析截图内容，确定目标元素位置
3. **执行操作** - 移动鼠标、点击、输入等
4. **验证结果** - 再次截图确认操作成功

### 示例任务

```
用户：打开计算器计算 123+456

AI 执行步骤：
1. computer (截图看桌面)
2. computer_click x=50 y=50 (点击开始菜单)
3. computer_wait seconds=1 (等待菜单弹出)
4. computer (截图验证菜单打开)
5. computer_type text="计算器" (输入搜索词)
6. computer_key key="enter" (确认搜索)
7. computer_wait seconds=2 (等待计算器打开)
8. computer (截图验证计算器已打开)
9. computer_click x=... (依次点击 1, 2, 3, +, 4, 5, 6, =)
10. computer (截图查看计算结果)
```

### 坐标换算

截图分辨率可能与实际屏幕不同，使用 `computer_get_screen_size` 获取实际分辨率后换算：

```
实际坐标 = 截图坐标 × (实际分辨率 / 截图分辨率)
```

### 安全提示

- Computer Use 工具需要用户确认后才能执行
- 涉及点击、输入的操作会询问用户批准
- 可随时按 `Ctrl+C` 中断正在执行的操作序列

## 架构

```
bin/anvil.js             入口
src/
├── cli/                 主流程 + 命令处理
│   ├── index.js         启动、事件总线、输入循环
│   ├── commands.js      内置命令（/provider /model /todo 等）
│   └── options.js       命令行参数解析
├── ai/                  AI 客户端
│   ├── client.js        多提供商 API 客户端（OpenAI/Anthropic 格式）
│   ├── providers.js     多提供商配置（DeepSeek/Kimi/OpenAI/Anthropic）
│   ├── models.js        模型定义和定价
│   ├── prompts.js       分层 System Prompt（L0-L4）
│   ├── cache.js         会话级 LRU 缓存
│   └── sensitive.js     输出敏感内容过滤
├── core/                核心引擎
│   ├── chat.js          对话引擎 + 自主 Agent 循环
│   ├── context.js       智能上下文管理（1M tokens 窗口）
│   ├── session.js       会话持久化
│   ├── todo.js          Todo 管理器
│   ├── web_search/      联网搜索多引擎实现
│   │   ├── index.js     统一入口 + 引擎调度
│   │   ├── bing.js      Bing 搜索
│   │   ├── duckduckgo.js DuckDuckGo 搜索
│   │   └── searxng.js   SearXNG 私有实例
│   └── team/            团队协作模式
├── tools/               工具系统
│   ├── registry.js      工具注册中心
│   ├── file.js          文件读写/编辑/删除
│   ├── code.js          代码分析（符号/引用/定义）
│   ├── command.js       命令执行
│   ├── computer_use.js  Computer Use 电脑控制（截图/点击/输入）
│   ├── web_search.js    联网搜索
│   ├── web_fetch.js     网页内容获取
│   ├── todo.js          Todo 工具
│   ├── question.js      用户提问工具
│   ├── task_complete.js 任务完成声明
│   ├── plan_mode.js     计划模式工具
│   ├── team_tools.js    团队协作工具
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
    ├── components/      UI 组件
    └── ...
```

## 开发

```bash
npm test              # 运行测试
npm run test:unit     # 单元测试
npm run test:integration # 集成测试
npm run lint          # 代码检查
npm run format        # 格式化
```

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 18+ (CommonJS) |
| AI | DeepSeek / Kimi / OpenAI / Anthropic |
| CLI | Commander.js |
| UI | Chalk + marked-terminal |
| 自动化 | robotjs + screenshot-desktop |
| MCP | @modelcontextprotocol/sdk |
| 测试 | Jest |

## 许可

[Apache-2.0 license](https://github.com/XiaoChennnng/Anvil_CLI#Apache-2.0-1-ov-file)
