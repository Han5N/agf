# 命令参考

所有命令都接受 `--json` 输出机器可读结果。项目根默认取当前工作目录，可用 `--root <path>` 或环境变量 `AGF_ROOT` 覆盖。

| 命令 | 作用 |
| --- | --- |
| `agf check [root]` | 校验整个项目 |
| `agf audit [root]` | 资产与结构体检 |
| `agf extract <file>` | 分析单文件游戏，输出拆分计划 |
| `agf stats [root]` | 只看计数与最大模块 |
| `agf inspect <kind> <id> [root]` | 实体定义、引用者、最近候选 ID |
| `agf add <kind> <id> --root <path>` | 原子地追加一条 manifest 记录 |
| `agf init [root]` | 生成 `AGF.md` 与 `.agf/` |
| `agf log --task "<what>"` | 跑一次 check 并把结果写进账本 |
| `agf prompt <global\|local>` | 输出一层提示词 |
| `agf setup --client <id> [--yes]` | 注册 MCP 服务器并安装 Skill |
| `agf doctor [--client <id>]` | 检查安装与注册状态 |

`kind` 取值：`scene`、`widget`、`intent`、`asset`。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 无 error，或被检查项全部通过 |
| `1` | 存在 error |
| `2` | 用法错误 |

`audit` 只在出现 `bad` 级 finding 时返回 1，warning 和 info 不影响退出码。

## add

```bash
# 单条
agf add asset bg_menu --root . --asset-type image --src assets/bg_menu.svg

# 批量：一次写入，一次校验
agf add --from entities.json --root .
```

`entities.json` 是一个数组，每项字段与单条相同：

```json
[
  { "kind": "asset", "id": "bg_menu", "assetType": "image", "src": "assets/bg_menu.svg" },
  { "kind": "intent", "id": "move", "intentType": "axis2" },
  { "kind": "widget", "id": "hud", "module": "src/ui/hud.ts", "intents": ["move"] },
  { "kind": "scene", "id": "main", "module": "src/scenes/main.ts", "assets": ["bg_menu"], "widgets": ["hud"] }
]
```

批量里某一条失败不会影响其他条：成功的照写，失败的在 `failed` 里逐条列出原因。

| 选项 | 用于 |
| --- | --- |
| `--asset-type` | `image` \| `audio` \| `video` \| `font` \| `json` |
| `--src` | asset 的文件路径 |
| `--intent-type` | `axis2` \| `button` \| `pointer` \| `text` |
| `--module` | scene / widget 的模块路径 |
| `--intents` | widget 消费的 intent，逗号分隔 |
| `--assets` | scene 引用的资产，逗号分隔 |
| `--widgets` | scene 挂载的控件，逗号分隔 |

写入时按 key 排序，所以 diff 只落在真正改动的那几行。已存在的 ID 不会被覆盖。

## log

```bash
agf log --task "接通确认键" \
  --changed src/ui/button.ts,manifest.json \
  --next "验证按钮可触达" \
  --ruling "图标保持 128px — 与现有 HUD 比例一致 — 错了只换一个资源"
```

| 选项 | 说明 |
| --- | --- |
| `--task` | 必填，这一轮做了什么 |
| `--changed` | 改动的文件或实体，逗号分隔 |
| `--next` | 下一轮该做什么 |
| `--ruling` | 独自做的决定，格式 `<决定> — <理由> — <错了的代价>` |

check 结果由命令自己跑，不接收外部传入。日志保留最近 12 轮，更早的折叠成一行。

## setup

```bash
agf setup --client opencode          # 打印计划、路径和备份位置
agf setup --client opencode --yes    # 执行
```

支持的客户端：

| 客户端 | MCP 配置 |
| --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` 的 `mcp.agf` |
| `pi` | `~/.pi/agent/mcp.json` 的 `mcpServers.agf`，尊重 `PI_CODING_AGENT_DIR` |
| `claude-code` | `~/.claude.json` 的 `mcpServers.agf` |

Skill 统一装到 `~/.agents/skills/agf`——OpenCode 和 Pi 都从这个目录发现 skill，一份安装两边共用。

写入前备份原文件为 `<name>.bak-agf-<timestamp>`。第二次运行是幂等的，已匹配则不写。

## extract

```bash
agf extract index.html                 # 打印计划
agf extract index.html --out EXTRACT.md
agf extract index.html --json
```

读一个 HTML 文件，输出拆分施工图：内联资产清单、按职责归类的顶层函数、建议的模块路径、以及从低耦合到高耦合的拆分顺序。

不改任何文件，也不自动拆。闭包边界判断错了就会拆出跑不起来的代码，所以它只给计划，由模型一步一拆、每步 `check`。

## doctor

逐项报告 Node 版本、MCP 入口、Skill、各客户端配置，失败项附带修复命令。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `AGF_ROOT` | 默认项目根 |
| `AGF_HOME` | 安装目录，默认 `~/.local/share/agf` |
| `AGF_BIN_DIR` | 启动器目录，默认 `~/.local/bin` |
| `AGF_REPO` | 安装源，默认 `Han5N/agf` |
| `PI_CODING_AGENT_DIR` | Pi 的配置目录 |
