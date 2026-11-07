# dsh-plugin-live-diff

给 [DSH](https://github.com/deepseek-ai) 的文件编辑加上**实时流式 diff** —— diff 会随着
模型吐参数**当场长出来**，而不是等工具调用结束才整块出现。0.2.0 起，同一份流还会画在
**整个应用的背后**，做成一层磨砂玻璃窗口背景。

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

## 演示视频

[26 秒 B 站演示 —— 「deepseek v4.1 flash 太强大了 50元手搓文件变更实时预览」](https://www.bilibili.com/video/BV1N6YB6KESy/)\
*Live Diffs for DSH —— 边写边看的编辑过程*

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

## 窗口背景

同一份读数会画在整个应用的背后。宿主那些大块的不透明表面是**量出来的，不是靠类名匹配**
（视口占比 + 计算后的背景色）：覆盖 ≥85% 窗口的表面会被清空，让背景透出来；不透明面板
只要 ≥0.1% 就变成磨砂玻璃。一旦某个祖先已经是玻璃，嵌套表面就跳过 —— 两层半透明叠在一起
会把"磨砂"变成"奶白"，背后的代码就看不见了。

- **液态玻璃**：浏览器支持时，`backdrop-filter: url(#dshld-lg-lens)` 用 SVG 位移滤镜把
  背景代码折射在大面板后面；不支持时退化成普通模糊。
- **鼠标光效**：一道柔光跟着光标在玻璃上移动，强度和光斑大小都能调。
- **前景白字**：玻璃上的灰色正文对比度太低，默认把文字提成白色；它的不透明度是一个滑杆。
- **标题栏保持原样**：窗口标题栏不变，只有应用区域变成玻璃。
- **可实时调**：背景样式表是**从磁盘发出来**的，不烤进 bundle，浏览器每 1.5 秒重取一次。
  改 `style.css` 大约一秒就生效，不用重启、不用重新构建。

### 外观调节面板

右下角一个圆形按钮，打开一个 264px 的面板，含 **9 个滑杆 + 2 个开关**：

| 控件 | 范围 | 作用 |
| --- | --- | --- |
| 面板不透明度 | 0.05 – 0.9 | 所有玻璃层共用一个不透明度 |
| 玻璃模糊 | 0 – 24 px | 背景模糊半径 |
| 折射强度 | 0 – 40 | 液态玻璃的位移强度 |
| 高光强度 | 0 – 1 | 鼠标光效的透明度 |
| 光斑大小 | 80 – 900 px | 光斑半径 |
| 文字不透明度 | 0.3 – 1 | 白字模式下前景文字 alpha |
| 代码层亮度 | 0.2 – 1 | 画在背景上的 diff 代码的透明度 |
| 代码字号 | 12 – 28 px | 背景代码字号 |
| 背景压暗 | 0 – 1 | 背景上的压暗层 |
| 界面文字转白色 | 开/关 | 把全部前景提成白色 |
| 液态玻璃（折射） | 开/关 | 启用 SVG 折射滤镜 |

数值存在 `localStorage`（`dshld.tuner.v2`），面板里的重置按钮把全部控件恢复默认。

### Windows 标题栏

Windows 桌面版的系统标题栏会在所有列之上预留 40px，而下面的会话头部又重复了一行
标题 + 一行视图标签。当 preload 用 `data-windows-titlebar` 标记窗口时，插件把**整个
会话头部**提进那条预留带里，做成固定的一行：面包屑标题、头部按钮（智能体团队、
创造模式、子智能体与后台任务计数）和视图标签（对话 / 轨迹 / 上下文 / 编队）都进
标题栏，和原生控件并排。

- 整行从侧栏右边开始（`--dsh-windows-sidebar-width`，侧栏收起时保底 176px），
  所以原生「应用/编辑」菜单、侧栏开关和新建会话按钮不会被挡住。
- 右端离窗口边缘 148px，避开原生最小化/最大化/关闭按钮。
- 预留带的空白处仍然可以拖动窗口；行内每个控件都是 `no-drag`，按钮照常可点。
- 全屏时退回原生头部（那时预留带已经不存在），普通浏览器里的文档完全不受影响。

这段是发给浏览器的 `style.css` 里的纯 CSS，所以和外观其它部分一样：改文件、大约
一秒生效。

### 逃生开关

- 在发出去的 `style.css` 里任意位置写 `/* dshld-off */`，整套效果**当场关闭**；删掉标记
  就恢复。插件对宿主做的一切都挂在同一个属性（`data-dshld-backdrop`）上，去掉它就是完整还原。
- `?dshld-demo=1` 会画一份合成的、持续生长的 diff，不用等模型编辑也能调外观。
- 浏览器控制台里 `window.__dshldDebug.state()` / `.probe()` / `.scan()` / `.demo()` 会报告
  背景能看到什么、看不到什么。

**只接管渲染。** 不写你的文件，也不修改任何其他包。

## 环境要求

在 **DSH `0.1.5-rc.1`** 与 DSH 桌面版 **`0.2.1-rc.5`** / Windows 上开发并验证
（`cordis` 4.0.2）。

这个插件是通过 DSH 的**内部**客户端接口接进去的，**不是**一套已发布的扩展 API。
下面这些都没有版本承诺：

| 依赖的东西 | 用途 |
| --- | --- |
| `ctx.sessions` 客户端服务 | 读取会话事件窗口 —— 唯一携带流式 `tool-call-delta` chunk 的数据源 |
| `ctx.slots` / `ctx.sidebarRightTabs` | 注册聊天记录卡片与侧边栏标签类型 |
| `@deepseek-ai/dsh-client-ui-primitives`（`DiffBlock`） | 聊天记录里的 diff 卡片 |
| `ctx.webServer` + `ctx.clientModules` | 宿主侧 `/live-diff-diag` 诊断路由与样式表路由 |
| 针对 `edit` / `write` 的 keyed `tool.call.toolview` | **替换** DSH 自带的 `FileMutationRow` |

最后一行是最脆的一环：keyed 注册会**替换**官方那一行，也就是说这个插件是在**故意覆盖
DSH 自带组件**。如果某次 DSH 升级改了工具 key 名、改了 `toolview` 契约，或者重构了会话
事件窗口，它就会失效——而且大概率表现为**面板空白**，而不是报错。

如果你用的不是同一个 DSH 版本，可以先装上试试，然后看诊断输出（见下）：面板会如实报告
"它看到了什么、没看到什么"，而不是静默失败。

## 安装

包自带 bundle 补丁（`cordis.patch.yml`）并声明了 `dsh.bundle.patch`，所以安装和挂载是一步 ——
不用建联结，也不用自己写补丁行。

**从插件市场安装：** 打开 **设置 → 插件 → 插件市场**，搜索 `Live Diffs` /
`dsh-plugin-live-diff`，点安装。多数客户端插件刷新页面即可生效。

**命令行安装**（普通 `dsh web` / 自定义 profile）：

```bash
dsh plugin --profile <profile> add github:phoenixyun/dsh-plugin-live-diff
```

**DSH 桌面版：** 用应用内的 **设置 → 插件** 安装。桌面版有它自己的插件管理器，用的是桌面
profile 而不是 `web` profile，所以在命令行装进 `web` 不会出现在桌面端。

运行中的进程**不会**发现新装的宿主包，这一行必须在启动时被看到，所以装完要重启（市场在
需要时会提供一键重启）。之后对插件源码的修改会被热加载（`patchReload: live`），但
**改客户端 bundle 仍然要重启 + 硬刷新**（`Ctrl+Shift+R`）—— 普通刷新曾经返回过旧 bundle。

### 从手工安装迁移

早期版本是手工装的：profile 的 `node_modules` 里一个联结，加上 profile 的
`cordis.patch.yml` 里一行 `id: live-diff`。装带 bundle 的版本之前，先删掉那行手工补丁
（以及联结）——两个都留着会把插件加载两次。

### 开发用安装（链接一份 checkout）

两部分，都在 DSH 自己的文件之外。

1. 让包能被活动 profile 的 `node_modules` 解析到。用联结/符号链接，**不能**用 `file:`
   说明符 —— Loader 解析不了那种写法。

   ```bat
   :: Windows
   mklink /J "%DSH_HOME%\profiles\<profile>\node_modules\dsh-plugin-live-diff" "C:\path\to\dsh-plugin-live-diff"
   ```

   ```bash
   # POSIX
   ln -s /path/to/dsh-plugin-live-diff "$DSH_HOME/profiles/<profile>/node_modules/dsh-plugin-live-diff"
   ```

2. 在 `profiles/<profile>/cordis.patch.yml` 里加 bundle 行：

   ```yaml
   - insert:
       - id: dsh-plugin-live-diff
         name: dsh-plugin-live-diff
   ```

3. 重启 DSH。

## 验证

```bash
npm test
```

六个套件各打一行：

| 套件 | 覆盖什么 |
| --- | --- |
| `parser.test.mjs` | 容错读取器，在真实调用的 25 个截断点上验证 |
| `apply.test.mjs` | 注册，以及布局与清单守卫 |
| `host.test.mjs` | 两条宿主路由的端到端验证（不需要服务器） |
| `highlight.test.mjs` | 语言识别与分词 |
| `overlay.test.mjs` | 增量 DOM 更新、拖拽调宽、滚动、结束后状态 |
| `audit.mjs` | bundle 静态审查：死函数、重复声明、未在 `dsh.client.inject` 里声明的 `require()` |

六个都应当以 0 退出。然后让模型编辑一个文件，看面板。如果面板一直是空的，它自己的诊断
页脚和宿主日志会告诉你原因（见下）。

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
没有直接移植 Cline 的组件、实测的传输粒度、两次踩中的布局陷阱，以及背景那套"量表面、
绝不按类名匹配"的规矩 —— 都在 [`docs/DESIGN.md`](docs/DESIGN.md)（英文）。

## 致谢

行为（不是代码）参考了 [Cline](https://github.com/cline/cline) 的流式 diff：数据到多少就
显示多少而不是直接放弃、"还在流式"从文档没闭合推断、视图钉在最新一行。细节见设计笔记。
Cline 是 Apache-2.0，本仓库**不含**任何 Cline 代码。

## 许可

MIT
