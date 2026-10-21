# 规则与指标

两个不同的东西：`agf check` 判断契约还成不成立，`agf audit` 判断项目是不是在变坏。check 封闭、可阻断；audit 开放、从不阻断。

分开的理由是混在一起会让每次重构看起来都像缺陷——重构期间 fan-out 上升、重复块暂时增加，那是正常代价。

## check

每条诊断都带 `file`、`path`（JSON Pointer）、`message` 和一个可直接执行的 `fix`。

| 编号 | 级别 | 检查内容 |
| --- | --- | --- |
| AGF001 | error | manifest 读不到或不是合法 JSON |
| AGF002 | error | 不符合 schema 形状，含未知字段与缺失必填 |
| AGF003 | error | ID 不符合命名规约 |
| AGF004 | error | 引用了未声明的实体 |
| AGF005 | error | 资产声明的文件不存在 |
| AGF006 | error | 资产使用 `data:` 内联 |
| AGF007 | error | 模块文件不存在 |
| AGF008 | error | 模块超过大小上限，默认 256 KiB |
| AGF009 | warning | 资产已声明但无人引用 |
| AGF010 | warning | intent 已声明但无 widget 消费 |
| AGF011 | warning | widget 已声明但无场景挂载 |
| AGF012 | warning | 场景既不引用资产也不挂载 widget |
| AGF013 | warning | `assets/` 下存在未声明的文件 |
| AGF014 | error | 资产路径越出项目根 |
| AGF015 | warning | widget 没有声明任何 intent |

原型模式（没有 manifest、只有一个 HTML 文件）不跑上面这套规则，只给三条提示，且从不阻断：

| 编号 | 级别 | 检查内容 |
| --- | --- | --- |
| PRT001 | warning | 单文件超过 600 行，该拆了 |
| PRT002 | warning | 文件里存在内联资产 |
| PRT003 | warning | 缺少 viewport meta，手机上会按桌面排版 |

原型阶段的目标是"能跑"，此时引入结构要求只会逼模型在还没有可运行基线的时候先想架构。

编号发布后不改变。忽略列表和 CI 白名单按号引用，改号等于让所有历史记录失效。

诊断长这样：

```json
{
  "code": "AGF004",
  "severity": "error",
  "file": "manifest.json",
  "path": "/scenes/main/assets/0",
  "message": "scene \"main\" references undeclared asset \"ghost\"",
  "fix": "Declare \"ghost\" under assets, or remove it from scenes.main.assets."
}
```

`fix` 是下一步动作，不是建议。绕过它自己发明修法通常会产出两三条新诊断，因为规则是封闭集合。

## audit

| 指标 | 阈值 | 依据 |
| --- | --- | --- |
| 资产总量 | 不评级 | 没有普适预算，对着自己的下载目标看 |
| 重复资产占比（SHA-256） | 0% / ≤5% | 同一份字节放在两个路径，就有两处要更新、一处会忘 |
| 平均扇出 | A ≤ 3.04，B ≤ 6.44 | TIOBE 可维护性模型 |
| 循环依赖 | 必须为 0 | 有环时两个模块谁都不能单独读、单独测 |
| 重复的 6 行代码块 | 0 / ≤2 | 重复是"修了一处忘了另一处"最直接的来源 |
| 孤儿模块 | 必须为 0 | 既不在 manifest 里也没被任何文件 import |
| 代码里用到但未声明的资产 ID | 必须为 0 | manifest 校验看不见的盲区 |

代码字符串引用这一项来自 Unity 依赖图工具反复强调的问题：靠字符串加载的资产（`Resources.Load("Prefabs/Enemy")`）不会在静态引用图里留下任何边，所以只做 manifest 校验的工具永远抓不到它。agf 用正则扫描 `assets.image("...")` 这类调用和现存资产的文件名，结果是启发式的——拼接出来的字符串（`"bg_" + name`）抓不到。

findings：

| 编号 | 级别 | 内容 |
| --- | --- | --- |
| AUD001 | bad | 字节级重复的资产 |
| AUD002 | bad | 代码引用了 manifest 未声明的资产 ID |
| AUD005 | bad | 依赖环 |
| AUD006 | warn | 跨文件重复的代码块 |
| AUD007 | bad | 孤儿模块 |
| AUD008 | info | 无人导入的导出（启发式） |

不产出合成总分。一个好看的数字会诱导优化数字本身，分项等级加可见阈值不会。
