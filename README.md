# agf

给 AI 生成的游戏项目用的契约校验器。

AI 写出来的游戏通常是一个几千行的 HTML 单页：能跑，但每改一次就得整份重写。agf 用一份 manifest 描述场景、资产、控件和输入意图，然后用一条命令检查这份描述还成不成立、项目是不是在变坏，并把每轮改动记成 Agent 下次能读到的记忆。

```
$ agf check
error AGF006  asset "bg" is inlined as a data: URI
       file: manifest.json  path: /assets/bg/src
       fix : Write the contents to a standalone file under assets/, then set src to
             that relative path, for example "assets/bg.svg".
```

## 安装

需要 Node.js 20+。不依赖 npm registry。

```bash
curl -fsSL https://raw.githubusercontent.com/Han5N/agf/main/install.sh | bash -s -- --client opencode
```

`--client` 取 `opencode`、`pi` 或 `claude-code`；省略则只安装，不注册。重跑同一条命令即更新。

## 用法

项目分两个阶段：没有 manifest 时按单文件原型对待，`check` 只提示不阻断；单文件能玩之后用 `agf extract` 生成拆分计划，一步一拆。

```bash
agf init                       # 生成 AGF.md 与 .agf/ 日志目录
agf check                      # 校验项目
agf audit                      # 资产与结构体检
agf log --task "接通确认键"      # 记录一轮
```

## 接入 Agent

```bash
agf setup --client opencode    # 打印计划与备份路径
agf setup --client opencode --yes
agf doctor                     # 逐项确认
```

手动注册时，服务器命令是 `node <安装目录>/dist/mcp.js`，stdio 传输，无参数。

## 文档

- [manifest 契约](docs/manifest.md)
- [规则与指标](docs/rules.md)
- [命令参考](docs/cli.md)
- [提示词分层](docs/prompts.md)

## 开发

```bash
npm install
npm test
node dist/cli.js check examples/minimal
```

## License

MIT
