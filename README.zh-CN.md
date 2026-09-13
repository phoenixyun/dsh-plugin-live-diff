# dsh-plugin-live-diff

给 [DSH](https://github.com/deepseek-ai) 的文件编辑加上**实时流式 diff** —— diff 会随着
模型吐参数**当场长出来**，而不是等工具调用结束才整块出现。

**[English →](README.md)**

```
┌ Live Diffs ─────────────────────── 1 in flight ─┐
│ solar/viewport.py                     python    │
│ 403  + def zoom_by(self, steps, anchor_x=None): │
│ 404  +     world_x, world_y = self.to_world(…)  │
│ 405  +     self.zoom = clamp_zoom(…)            │
│ 406  +     self.offset_x = anchor_x - …    ▌    │
└─────────────────────────────────────────────────┘
```

## 问题在哪

DSH 其实**已经有** diff 卡片，也**已经在累积**流式数据（宿主里那句
`argsRaw: base.argsRaw + chunk.argumentsDelta` 就是为此存在的）。它缺的不是数据，
而是一个能容忍**半到达**参数串的读取器：

```js
// dsh-client-ui-tool
value = JSON.parse(call.argsRaw);          // 文档被截断就抛错
if (typeof oldText !== "string" || typeof newText !== "string") return null;
```

调用进行中时 `argsRaw` 是一个**被截断的 JSON 文档**，解析必然失败，于是卡片一直是空的，
要等最后一个 token 落地。这个插件提供的就是那个容错读取器，以及一个把结果放上去的界面。

## 功能

- **悬浮面板**（`Live Diffs`）：字符到达时就地更新 diff。**左边缘可拖拽调宽**，宽度会被
  记住，刷新后还在。
- **聊天记录里的 diff 卡片**：针对 `edit` / `write`，通过 DSH 自己的 `DiffBlock` 图元渲染，
  所以和宿主自己的 diff 卡片天然一致。
- **容错读取器**：值字符串还没闭合的字段，返回"可用但不完整"，而不是 `null`。
- **部分语法高亮**：按语言分别配置（Python、JS/TS、JSON、YAML、shell、Markdown）。
- 流式期间面板**自动跟随最新一行**；你用鼠标滚上去就会松开跟随，滚回底部自动恢复。
- **编辑结束后不关闭面板**：`entries` 一空就清屏会把用户正在看的东西抹掉，所以会保留
  最后一次结果。
- **面板是增量更新 DOM 的**，不是每次轮询整块重建 —— 所以行的淡入动画只播一次，而不是
  每 80ms 重播一次（那看起来就是"一直在闪"）。

**只接管渲染。** 不写你的文件，也不修改任何其他包。

## 环境要求

在 **DSH `0.1.5-rc.1`** / Windows 上开发并验证（`cordis` 4.0.2、
`dsh-api-session-controller` 0.1.5-rc.2）。

这个插件是通过 DSH 的**内部**客户端接口接进去的，**不是**一套已发布的扩展 API。
下面这些都没有版本承诺：

| 依赖的东西 | 用途 |
| --- | --- |
| `ctx.sessions` 客户端服务 | 读取会话事件窗口 —— 唯一携带流式 `tool-call-delta` chunk 的数据源 |
| `ctx.slots` / `ctx.sidebarRightTabs` | 注册聊天记录卡片与侧边栏标签类型 |
| `@deepseek-ai/dsh-client-ui-primitives`（`DiffBlock`） | 聊天记录里的 diff 卡片 |
| `ctx.webServer` + `ctx.clientModules` | 宿主侧 `/live-diff-diag` 诊断路由 |
| 针对 `edit` / `write` 的 keyed `tool.call.toolview` | **替换** DSH 自带的 `FileMutationRow` |

最后一行是最脆的一环：keyed 注册会**替换**官方那一行，也就是说这个插件是在**故意覆盖
DSH 自带组件**。如果某次 DSH 升级改了工具 key 名、改了 `toolview` 契约，或者重构了会话
事件窗口，它就会失效——而且大概率表现为**面板空白**，而不是报错。

如果你用的不是同一个 DSH 版本，可以先装上试试，然后看诊断输出（见下）：面板会如实报告
"它看到了什么、没看到什么"，而不是静默失败。

## 安装

两部分，都在 DSH 自己的文件之外。

**第一步：让包能被解析到。** 在活动 profile 的 `node_modules` 下建一个联结/符号链接。
必须这样，**不能**用 `file:` 说明符 —— Loader 解析不了那种写法。

```bat
:: Windows
mklink /J "%DSH_HOME%\profiles\node_modules\dsh-plugin-live-diff" "C:\path\to\dsh-plugin-live-diff"
```

```bash
# POSIX
ln -s /path/to/dsh-plugin-live-diff "$DSH_HOME/profiles/node_modules/dsh-plugin-live-diff"
```

**第二步：在 profile 的用户补丁层 `profiles/web/cordis.patch.yml` 里加一行：**

```yaml
- insert:
    - id: live-diff
      name: dsh-plugin-live-diff
```

**第三步：重启 `dsh web`。** 运行中的进程**不会**发现新装的包，这一行必须在启动时被看到。
之后对插件源码的修改会被热加载（`patchReload: live`），但**改客户端 bundle 仍然要重启 +
硬刷新**（`Ctrl+Shift+R`）—— 普通刷新曾经返回过旧 bundle。

## 验证

```bash
node test/parser.test.mjs      # 容错读取器，覆盖真实调用的每个截断点
node test/overlay.test.mjs     # 增量 DOM 更新、拖拽调宽
node test/apply.test.mjs       # 注册，以及 CSS/布局守卫
node test/highlight.test.mjs   # 语言识别与分词
node test/host.test.mjs        # 宿主侧诊断路由
```

五个都应当以 0 退出。

然后让模型编辑一个文件，看面板。如果面板一直是空的，它自己的诊断页脚和宿主日志会告诉你
原因（见下）。

## 诊断

作者（也就是 AI）打不开你的浏览器，所以面板会**自己上报**。每次状态变化时它把一行读数
POST 到 `/live-diff-diag`，宿主侧追加写进日志文件：

- 默认位置：`<系统临时目录>/dsh-plugin-live-diff/diag.log`
- 覆盖方式：环境变量 `DSH_LIVE_DIFF_LOG`

每行包含事件窗口计数和一段压缩后的事件序列：

```json
{"surface":"overlay","entryCount":1,"deltaCount":269,"accumulating":1,
 "sequence":"b0) t0)x269","toolNames":["write"],"reason":"deltas present"}
```

`sequence` 把"同一流索引上连续同类型的 chunk"压成一段，事件到达顺序就是靠它确认的：
`block-start` 总是在该索引的 deltas **之前**。

**面板不会改写 `document.title`。** 以前会；但标题只在标签页**未激活**时才可见，而那恰好
是没人在看 live diff 的时刻。

## 设计笔记

那些不显然的决定 —— 为什么面板是原生 DOM 而不是 React、为什么放弃了侧边栏方案、为什么
没有直接移植 Cline 的组件、实测的传输粒度、以及两次踩中的布局陷阱 —— 都在
[`docs/DESIGN.md`](docs/DESIGN.md)（英文）。

## 致谢

行为（不是代码）参考了 [Cline](https://github.com/cline/cline) 的流式 diff：数据到多少就
显示多少而不是直接放弃、"还在流式"从文档没闭合推断、视图钉在最新一行。细节见设计笔记。
Cline 是 Apache-2.0，本仓库**不含**任何 Cline 代码。

## 许可

MIT
