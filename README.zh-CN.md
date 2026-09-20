# ompweb

[![npm version](https://img.shields.io/npm/v/@kahme247/ompweb.svg?logo=npm&color=e05d44)](https://www.npmjs.com/package/@kahme247/ompweb)
[![node version](https://img.shields.io/node/v/@kahme247/ompweb.svg?logo=node.js&color=44cc11)](https://nodejs.org)
[![license](https://img.shields.io/github/license/kahme247/ompweb.svg?color=44cc11)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kahme247/ompweb.svg?color=44cc11)](https://www.npmjs.com/package/@kahme247/ompweb)
[![GitHub stars](https://img.shields.io/github/stars/kahme247/ompweb.svg?logo=github)](https://github.com/kahme247/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kahme247/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

社区：[加入 OMPWEB Discord](https://discord.gg/evqgGzRfM5)

[oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) 编程智能体的现代 Web UI。它读取本地的 omp 会话，在浏览器中提供实时对话、项目会话浏览、配置管理和文件预览等功能。

![ompweb — 演示](docs/demo.gif)

<details>
<summary>截图（浅色 / 深色主题）</summary>

![ompweb — 浅色主题](docs/screenshot-light.png)

![ompweb — 深色主题](docs/screenshot-dark.png)

</details>

## 环境要求

- 已安装 [omp](https://github.com/can1357/oh-my-pi) 且在 `PATH` 中（或通过 `OMP_WEB_OMP_BIN` 指定路径）
- Node.js `>= 22.19.0`

## 快速开始

**免安装直接运行：**

```bash
npx @kahme247/ompweb@latest
```

**或全局安装：**

```bash
npm install -g @kahme247/ompweb
ompweb
```

在浏览器中打开 [http://127.0.0.1:30177](http://127.0.0.1:30177)。

### CLI 选项

```bash
ompweb --port 8080                         # 自定义端口
ompweb --hostname 0.0.0.0                  # 监听网络地址
ompweb --password "your-password"          # 启用密码保护
ompweb --no-open                           # 不自动打开浏览器
```

## 功能特性

- **实时对话**：与本地 `omp` 智能体进行低延迟流式交互。
- **队列删除确认**：从队列面板移除后续消息或引导消息前，先预览内容并确认。此操作不会取消 OMP 内部已排队消息的发送。
- **跨会话搜索与查找**：`⌘K` / `Ctrl+K` 面板的搜索模式可对全部会话做全文检索（按相关度排序、摘要自动脱敏、支持 `project:` 过滤）；会话内查找（`Ctrl+F` / `Cmd+F`）支持循环跳转与深链接定位。
- **会话管理**：按项目浏览历史会话，支持会话分叉与分支回溯。
- **消息书签**：收藏任意消息，之后可从书签面板通过深链接一键回跳。
- **全局提示词历史**：跨会话回看并重发历史提示词。
- **草稿恢复**：未发送的文本按会话或新会话的工作区分别保存；浏览器存储可用时，在同一标签页后退、前进或重新加载后可恢复（最多 50 份草稿）。图片和文件附件仅保留在内存中。
- **实时任务与子智能体**：可折叠面板实时展示任务清单（todo）与子智能体进度，并支持查看完整转录。
- **运行看板**：跨项目实时总览所有运行中/已结束的会话（`Ctrl+Shift+U` / `Cmd+Shift+U`），支持中断与一键跳转。
- **分屏视图**：再开一个对话窗格（`Ctrl+\` / `Cmd+\`），并排对比分支或并行运行两个会话。
- **文件管理与预览**：与对话并排浏览文件，支持代码、Markdown、图片、音频及 PDF 预览。
- **文件编辑**：直接在查看器中编辑文件，支持未保存标记、`Ctrl+S` 保存与差异对照。
- **Markdown 导出**：将任意会话导出为 Markdown（下载或复制），与现有 HTML 导出并存。
- **终端标签页**：右侧面板内置终端——默认为纯管道 Shell，可选接入 `herdr` 面板获得完整 TUI 支持（需手动开启）。
- **Git Worktree 支持**：直接在侧边栏切换与管理 Git 工作树。
- **Git 检查点**：按消息自动快照工作树，支持预览与按文件选择性还原——不动 `HEAD` 即可回退单个文件。
- **会话洞察**：从 omp 原生统计数据库读取单会话的首字耗时、时长、费用与工具统计。
- **上下文检查器**：查看会话的原始条目树，预览分支并跳转到任意叶子节点。
- **通知与 Webhook**：浏览器通知之外，还可通过 ntfy / Discord / Telegram webhook 推送任务完成、待审批与失败事件，支持免打扰时段。
- **语音朗读（TTS）**：通过 OpenAI 兼容的语音接口朗读助手回复（可选）。
- **PWA 安装**：可作为渐进式 Web 应用安装，应用外壳支持离线缓存。
- **可视化设置**：在 Web 界面中直接配置模型、API 密钥、MCP 服务器、技能、插件及 OMP 原生设置。
- **快捷指令与命令面板**：内置常用指令（`/plan`、`/review`、`/fix`、`/test` 等）及 `⌘K` / `Ctrl+K` 全局面板。
- **提示词与片段库**：保存带 `$PLACEHOLDER` 占位符的常用提示词，从输入框或斜杠面板触发，支持 JSON 导入导出。
- **定时提示词**：为项目配置周期性提示词（每日或指定星期几），支持错过补跑策略、立即运行与全部暂停。
- **主题与多语言**：温暖纸感深浅主题，完整支持英语、简体中文及日本語。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务端口 | `30177` |
| `OMP_WEB_HOSTNAME` | 绑定主机名 | `127.0.0.1` |
| `OMP_WEB_PASSWORD` | 可选的 Web 访问密码 | _无（未启用验证）_ |
| `OMP_WEB_NO_OPEN` | 设为 `1` 时禁止自动打开浏览器 | `0` |
| `OMP_WEB_OMP_BIN` | `omp` 二进制路径（未在 PATH 时使用） | _自动检测_ |
| `PI_CODING_AGENT_DIR` | 自定义 omp agent 目录 | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI 兼容的语音转文字接口 URL | _无（默认禁用）_ |
| `OMP_WEB_STT_KEY` | STT 接口对应的 API Key | _无_ |
| `OMP_WEB_STT_MODEL` | STT 接口的模型名称 | _无_ |
| `OMP_WEB_TTS_ENDPOINT` | OpenAI 兼容的语音合成接口 URL（朗读助手回复） | _无（默认禁用）_ |
| `OMP_WEB_TTS_KEY` | TTS 接口对应的 API Key | _无_ |
| `OMP_WEB_TTS_MODEL` | TTS 接口的模型名称 | _无_ |
| `OMP_WEB_TTS_VOICE` | TTS 接口的音色 | _无_ |
| `OMP_WEB_HERDR_BIN` | `herdr` 二进制路径；设置后可在终端面板中接入 herdr 会话 | _无（关闭）_ |
| `OMP_WEB_SHELL` | 终端标签页使用的 Shell | _自动检测_ |
| `OMP_WEB_DISABLE_TERMINAL` | 设为 `1` 时移除终端标签页 | `0` |
| `OMP_WEB_FLAGS` | 可选的逗号分隔功能开关 | _无_ |

## 本地开发

```bash
git clone https://github.com/kahme247/ompweb.git
cd ompweb
npm install
npm run dev
```

本地开发服务器运行在 [http://127.0.0.1:30178](http://127.0.0.1:30178)。

### 代码检查

```bash
npm run typecheck   # TypeScript 类型检查
npm run lint        # ESLint 检查
npm test            # 运行测试套件
```

> **注意**：本地开发期间请勿运行 `npm run build`，以免污染 `.next/` 导致开发服务器异常。

## 致谢与许可证

- 分叉自 [agegr/pi-web](https://github.com/agegr/pi-web)（MIT），针对 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 进行适配。
- 采用 [MIT 许可证](./LICENSE) 开源。
