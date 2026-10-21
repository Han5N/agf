# 提示词分层

Agent 的上下文按尺寸切三层，只有两层是文件。

| 尺寸 | 载体 | 加载时机 | 生命周期 |
| --- | --- | --- | --- |
| Global Environment | `prompts/global.md` | 会话开始或上下文重置后 | 整个会话 |
| Local Project | `AGF.md` + `.agf/log.md` | 首次编辑前、重置后 | 整个项目 |
| Info Block | 任意工具的返回值 | 每次调用 | 当前这一轮 |

## Info Block 不是文件

没有 `prompts/info.md`，也没有打印它的命令。每一条诊断、每一次 `agf_inspect` 结果、每一个 `agf_add` 响应就是 Info Block：一个实体或一条发现，结构化、当场可用。让它就地被消费，不要再要一份同样事实的汇总。

Info Block 如果可以被单独打印，就会变成第二个会漂移的副本。

## Local Project 是两个文件

`AGF.md` 是契约，人写、进版本库：布局、引擎、边界、有意跳过的部分。它跟着项目形态变化，不该被每次运行的记录污染。

`.agf/log.md` 是账本，`agf log` 写、被 git 忽略：每轮一条，记下改了什么、检查测出什么、下一步是什么，以及独自做过的裁决。

拆开的原因很实际：账本每次运行都会变，放在受版本控制的文件里会一直挂在 `git status` 上。一个总在脏状态的账本，人会开始无视它。`.agf/` 目录自带一个内容为 `*` 的 `.gitignore`，所以不需要改项目根的忽略规则。

`agf prompt local` 把两份拼回来，契约在前账本在后。

## 账本为什么必须自测

记忆活不过上下文压缩。压缩后重新开始的工作最容易重复实现已经存在的改动。

所以日志里的检查结果由 `agf log` 自己跑出来，不接收调用方传入的值——能声称"全部通过"的日志不算证据。这跟 superpowers 的 `task-done` 只在测试真的通过时才写账本是同一个思路：记录必须比叙述更难伪造。

单条格式：

```
### 2026-10-21T13:19:39.615Z — wire the confirm intent into the menu button
- changed: src/ui/button.ts, manifest.json
- check: 0 error / 0 warning
- next: verify the button is reachable from scene/main
- ruling: kept the 128px icon — matches existing HUD scale — cost if wrong: one asset swap
```

保留最近 12 轮，更早的折叠成 `_N older rounds omitted._`。

## 一轮的流程

1. 读账本最新一条，确认上一轮停在哪。没有账本就 `agf init`。
2. `agf check` 建立基线。有 error 先修，不要叠加新改动。
3. 动已有实体前 `agf inspect`，逐个确认 `usedBy`。
4. 新增走 `agf add`，不要手写 `manifest.json`。
5. 写模块文件，遵守 `AGF.md` 里的边界。
6. `agf check`，errors 必须归零。
7. 结构有变化时 `agf audit`。
8. `agf log` 收尾。

第 8 步和第 2 步是同一条闭环：账本记的是 check 测出来的结果，不是 Agent 认为的结果。
