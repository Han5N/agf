# manifest 契约

项目根放一个 `manifest.json`。它是这个项目的唯一真相：场景、资产、控件、输入意图全部在这里声明，代码只是实现。

## 完整例子

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

## 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | `1` | 目前只接受 1 |
| `name` | string | 项目名 |
| `entry` | string | 入口，固定为 `scene/<已声明的场景 ID>` |
| `assets.<id>.type` | enum | `image` \| `audio` \| `video` \| `font` \| `json` |
| `assets.<id>.src` | string | 相对项目根的路径，禁止 `data:` 与 `..` |
| `intents.<id>.type` | enum | `axis2` \| `button` \| `pointer` \| `text` |
| `intents.<id>.bindings` | array | 由运行时解释，Core 只校验形状 |
| `widgets.<id>.intents` | string[] | 消费的 intent ID，空数组表示纯展示控件 |
| `widgets.<id>.module` | string | 控件实现模块 |
| `scenes.<id>.module` | string | 场景实现模块 |
| `scenes.<id>.assets` | string[] | 引用的资产 ID |
| `scenes.<id>.widgets` | string[] | 挂载的控件 ID |
| `limits.maxModuleBytes` | integer | 单模块字节上限，默认 262144 |

schema 是关闭的。出现契约以外的字段就是 AGF002——拼错的字段不会静默失效。

## 四个概念

只有四个，刻意不再扩展。想加第五个之前，先证明它不能用这四个表达。

| 概念 | 含义 | 边界 |
| --- | --- | --- |
| `asset` | 独立资产文件 | 禁止 `data:` 内联，路径不得逃出项目根 |
| `intent` | 设备无关的输入意图 | 描述"想干什么"，不描述"按了哪个键" |
| `widget` | 消费 intent 的控件 | 不直接读键盘或触摸事件 |
| `scene` | 场景装配 | 不写绘制逻辑，不写业务规则 |

`intent` 这一层是为了让设备差异停在它上面。同一个控件在键盘、触摸和手柄下表现一致，因为它只认 `confirm`，不认 `Enter`。

## ID

```
^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$
```

小写字母开头，只允许 `a-z 0-9 _` 和点分段。

有效：`main`、`button.primary`、`bg_menu_01`
无效：`Main`、`button-primary`、`Background Menu`

点分段是有意的：同一个标识符要能同时当 manifest 键、文件名和 CSS 选择器。

## 目录

```
manifest.json     契约，唯一真相
AGF.md            项目契约与边界，人写
.agf/log.md       轮次账本，agf log 写，被 git 忽略
assets/           资产文件
src/scenes/       一个场景一个文件
src/ui/           一个控件一个文件
src/systems/      跨场景逻辑：物理、音频、存档
src/core/         运行时管道：主循环、输入适配、资产加载
```

不建 `utils/` 或 `helpers/`。一个文件放不进任何位置，说明职责还没被命名。
