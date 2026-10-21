# agf

**AI 生成的游戏项目，需要一道能执行的护栏。**

agf 不是一个引擎，也不是一个 Agent 框架。它给游戏项目定义一份 manifest 契约，然后检查这份契约还成不成立、这个项目是不是越来越难维护，并把每一轮改动记成 Agent 自己下次能读到的记忆。

它面向一个具体的失败场景：AI 生成游戏的主流形态是一个几千行的 HTML 单页。能跑，但每改一次就得整份重写，于是每次迭代都是一次全量回归，版本维护形同虚设。agf 让改动可以只落在一个文件里，并且改错了当场发现。

```
$ agf check
error AGF006  asset "bg" is inlined as a data: URI
       file: manifest.json  path: /assets/bg/src
       fix : Write the contents to a standalone file under assets/, then set src to
             that relative path, for example "assets/bg.svg".
```

## 安装

需要 Node.js 20 或更新版本。不需要 npm 账号，不依赖任何 registry。

```bash
curl -fsSL https://raw.githubusercontent.com/Han5N/agf/main/install.sh | bash -s -- --client opencode
```

脚本会 clone 仓库到 `~/.local/share/agf`、本地安装依赖、构建、在 `~/.local/bin/agf` 放一个启动器，然后注册 MCP 服务器并安装 Skill。`--client` 可换 `pi` 或 `claude-code`，省略则只安装，不注册。

不想用管道执行的话，脚本只有 clone、`npm install`、`npm run build` 和几处 `$HOME` 下的写入，可以先下载检查再跑：

```bash
curl -fsSL https://raw.githubusercontent.com/Han5N/agf/main/install.sh -o install.sh
less install.sh
bash install.sh --client opencode
```

重跑同一条命令即更新。卸载就是删掉 `~/.local/share/agf`、`~/.local/bin/agf`、`~/.agents/skills/agf`。

## 快速开始

```bash
agf init                 # 从模板生成 AGF.md 契约，并建好 .agf/ 日志目录
agf check                # 校验项目
agf audit                # 资产与结构体检
agf log --task "接通确认键" --changed src/ui/button.ts --next "验证按钮可触达"
```

`agf check` 退出码：`0` 无 error，`1` 有 error，`2` 用法错误。

## 它做什么

### check：契约还成不成立

15 条规则，覆盖 manifest 结构、ID 命名、跨实体引用、资产文件存在性与内联、模块缺失与体积上限、孤儿与未声明资产。每条诊断都带 `file`、`path`（JSON Pointer）、`message` 和一个可直接执行的 `fix`。

规则集是封闭的，有 error 就阻断。它不评价代码风格，只回答"这个项目还守不守自己的约定"。

### audit：项目是不是在变坏

check 之外的另一个问题：可维护性。check 阻断，audit 从不阻断——重构期间 fan-out 上升、重复块暂时增加是正常代价，不该卡住当前这一轮。

audit 报告字节级重复资产、代码里用到但 manifest 没声明的资产 ID、依赖环、重复代码块、孤儿模块、死导出、平均扇出，以及日志里的历史趋势。每项指标给数值和等级，不给合成总分：一个好看的数字会诱导优化那个数字本身。

指标不是拍脑袋定的。扇出用 TIOBE 可维护性模型的分档（A ≤ 3.04，B ≤ 6.44），循环依赖和孤儿模块的阈值是"必须为零"，资产总量只报数值不评级——没有普适预算。代码字符串引用检测来自 Unity 依赖图工具反复强调的盲区：靠字符串加载的资产不会在静态引用图里留下任何边，所以只做 manifest 校验永远抓不到它。

### 三层上下文

Agent 的上下文按尺寸切三层，只有两层是文件。

| 尺寸 | 载体 | 加载时机 | 生命周期 |
| --- | --- | --- | --- |
| Global Environment | `prompts/global.md` | 会话开始或上下文重置后 | 整个会话 |
| Local Project | `AGF.md` + `.agf/log.md` | 首次编辑前、重置后 | 整个项目 |
| Info Block | 任意工具的返回值 | 每次调用 | 当前这一轮 |

Info Block 没有文件，也没有打印它的命令。每一条诊断、每一次 `agf inspect` 结果、每一个 `agf add` 响应就是它：一个实体或一条发现，结构化、当场可用。让它就地被消费，不要再要一份同样事实的汇总。

### 本地记忆

`AGF.md` 是契约，人写、进版本库。`.agf/log.md` 是账本，`agf log` 写、被 git 忽略——一个总在脏状态的账本，人很快会开始无视它。

账本存在的理由是记忆活不过上下文压缩。所以日志里的检查结果由 `agf log` 自己跑出来，不接收调用方传入的值：能声称"全部通过"的日志不算证据。保留最近 12 轮，更早的折叠成一行。

## 命令

| 命令 | 作用 |
| --- | --- |
| `agf check [root] [--json]` | 校验整个项目 |
| `agf audit [root] [--json]` | 资产与结构体检 |
| `agf stats [root] [--json]` | 只看计数与最大模块 |
| `agf inspect <kind> <id> [root]` | 实体定义、引用者、最近候选 ID |
| `agf add <kind> <id> --root <path>` | 原子地追加一条 manifest 记录，不覆盖已有 ID |
| `agf init [root]` | 生成 `AGF.md` 与 `.agf/` |
| `agf log --task "<what>"` | 跑一次 check 并把结果写进账本 |
| `agf prompt <global\|local>` | 输出一层提示词 |
| `agf setup --client <id> [--yes]` | 注册 MCP 服务器并安装 Skill，默认只打印计划 |
| `agf doctor [--client <id>]` | 检查安装与注册状态 |

`kind` 取值：`scene`、`widget`、`intent`、`asset`。

## manifest

```json
{
  "schemaVersion": 1,
  "name": "my-game",
  "entry": "scene/main",
  "assets": {
    "bg_menu": { "type": "image", "src": "assets/bg_menu.svg" }
  },
  "intents": {
    "confirm": { "type": "button", "bindings": [{ "key": "Enter" }] }
  },
  "widgets": {
    "button.primary": { "intents": ["confirm"], "module": "src/ui/button.ts" }
  },
  "scenes": {
    "main": {
      "module": "src/scenes/main.ts",
      "assets": ["bg_menu"],
      "widgets": ["button.primary"]
    }
  },
  "limits": { "maxModuleBytes": 262144 }
}
```

只有四个概念，刻意不再扩展：

| 概念 | 含义 | 边界 |
| --- | --- | --- |
| `asset` | 独立资产文件 | 禁止 `data:` 内联，路径不得逃出项目根 |
| `intent` | 设备无关的输入意图 | 描述"想干什么"，不描述"按了哪个键" |
| `widget` | 消费 intent 的控件 | 不直接读键盘或触摸事件 |
| `scene` | 场景装配 | 不写绘制逻辑，不写业务规则 |

ID 统一为小写点分：`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`。这样同一个标识符能同时当 manifest 键、文件名和 CSS 选择器。

## 规则

| 编号 | 级别 | 检查内容 |
| --- | --- | --- |
| AGF001 | error | manifest 读不到或不是合法 JSON |
| AGF002 | error | 不符合 schema 形状（含未知字段、缺失必填） |
| AGF003 | error | ID 不符合命名规约 |
| AGF004 | error | 引用了未声明的实体 |
| AGF005 | error | 资产声明的文件不存在 |
| AGF006 | error | 资产使用 `data:` 内联 |
| AGF007 | error | 模块文件不存在 |
| AGF008 | error | 模块超过大小上限（默认 256 KiB） |
| AGF009 | warning | 资产已声明但无人引用 |
| AGF010 | warning | intent 已声明但无 widget 消费 |
| AGF011 | warning | widget 已声明但无场景挂载 |
| AGF012 | warning | 场景既不引用资产也不挂载 widget |
| AGF013 | warning | `assets/` 下存在未声明的文件 |
| AGF014 | error | 资产路径越出项目根 |
| AGF015 | warning | widget 没有声明任何 intent |

编号发布后不改变。Agent 的忽略列表和 CI 白名单都按号引用。

## 接入 Agent

`agf setup --client opencode --yes` 会做两件事：把 MCP 服务器写进客户端配置，把 Skill 装到 `~/.agents/skills/agf`。OpenCode 和 Pi 都从这个目录发现 Skill，所以一份安装两边共用。写入前会备份原文件，第二次运行是幂等的。

支持的客户端：

| 客户端 | MCP 配置 |
| --- | --- |
| OpenCode | `~/.config/opencode/opencode.json` 的 `mcp.agf` |
| Pi | `~/.pi/agent/mcp.json` 的 `mcpServers.agf`（尊重 `PI_CODING_AGENT_DIR`） |
| Claude Code | `~/.claude.json` 的 `mcpServers.agf` |

手动注册时，服务器命令就是 `node <安装目录>/dist/mcp.js`，stdio 传输，无需参数。MCP 暴露 8 个工具和 `agf://manifest` 资源，项目根默认取服务进程的工作目录，可用 `AGF_ROOT` 覆盖。

注册完 `agf doctor` 可以逐项确认：Node 版本、MCP 入口、Skill、各客户端配置。

## 设计约束

这些是刻意划的线，越过任何一条，这个项目就会变成它想取代的东西：

- Core 必须完全独立可跑。MCP 不可用不能影响 CLI；任何功能只能在 MCP 里用就是设计错误。
- 不自己写主循环、不自己造渲染器。渲染交给 PixiJS、Phaser 或原生 canvas。
- 不造 Agent 框架。OpenCode、Codex、Pi 各自演进，agf 只做适配层。
- 规则集封闭，指标集开放。check 阻断，audit 从不阻断。
- 每条诊断必须有 `fix`，且 `fix` 只引用项目内真实存在的路径。
- 新增规则必须同时新增测试。一条从未在测试里触发过的规则，等于没有被证明会触发。
- 提示词分三层且不重复。同一条规则只存在一处：形状在 `src/schema.ts`，语义在 `src/rules.ts`，工作方法在 `prompts/`。

### 目前不做的

运行时快照、headless 断言、截图对比。第一版只做静态结构验证。不要把它描述成已经会验证游戏能不能跑。

## 开发

```bash
git clone https://github.com/Han5N/agf.git
cd agf
npm install
npm test                 # 49 个测试：规则、CLI、账本、审计
npm run typecheck
npm run build
node dist/cli.js check examples/minimal
node dist/cli.js audit examples/minimal
node scripts/mcp-smoke.mjs
```

`examples/minimal` 是一个干净的最小项目，check 应该输出 `0 error / 0 warning`。

## License

MIT
