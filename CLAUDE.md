# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

**Z-Order Alt-Tab**——GNOME Shell 扩展（GNOME 48–51，ESM 模块）。用层叠顺序
（z-order）切换窗口，替代 GNOME 默认的 MRU / 按应用分组切换。

核心语义（产品定义，不要随意改动）：

- 所有窗口平级，不按应用分组。
- 列表按 z 序排列，最上面的窗口排最前（弹窗里从左到右：堆顶 → 堆底）。
- 每按一次 Tab 沿列表向下走一层；被切换到的窗口激活后移动到列表末尾（堆顶），
  其余窗口相对顺序不变。
- 例（按自底向上书写，末尾是堆顶）：`a1 a2 b1 b2 c1 c2` → 切到 a1 → `a2 b1 b2 c1 c2 a1`
  → 再切到 b2 → `a2 b1 c1 c2 a1 b2`。

## 结构

| 文件 | 作用 |
| --- | --- |
| `extension.js` | 全部运行时逻辑：接管快捷键、收集窗口、缩略图弹窗与按键处理 |
| `prefs.js` | Adw 首选项窗口 |
| `schemas/*.gschema.xml` | 六个设置项：`current-workspace-only`、`wrap-around`、`icon-size`、`preview-size`、`title-font-size`、`caption-spacing` |
| `stylesheet.css` | 弹窗样式（`.z-order-switcher*`） |
| `Makefile` | `check` / `install` / `uninstall` / `pack` / `release` / `schemas` |
| `tools/check-metadata.py` | 构建前校验 `metadata.json`（字段、uuid、HTML 转义） |
| `tools/screenshot.py` | 通过 XDG portal 延时截取切换器 |

## 常用命令

```bash
make check      # 唯一的自动化“测试”
make install    # 复制到 ~/.local/share/gnome-shell/extensions/<uuid>/
make pack       # 生成 build/<uuid>.shell-extension.zip
make release    # make check + make pack
make clean      # 删除 build/ 与 schemas/gschemas.compiled
```

`make check` 依次编译 schema、校验 metadata、对两个 ESM 文件做 `node --check`，
再 `py_compile` 截图工具；任何一步失败都会中断。也可以单独跑：

```bash
glib-compile-schemas --strict --targetdir=schemas schemas
python3 tools/check-metadata.py metadata.json
cp extension.js /tmp/x.mjs && node --check /tmp/x.mjs   # prefs.js 同理
python3 -m py_compile tools/screenshot.py
```

复制成 `.mjs` 是必要的：仓库里没有 `package.json`，`node --check` 会把 `.js` 当
CommonJS 解析，遇到 ESM `import` 就报错。

没有单元测试和 CI，`make check` 只查语法与 metadata。真正的验证必须在真实的
GNOME Shell 会话里手动做：Alt+Tab / Shift+Alt+Tab / 方向键、Esc、松开修饰键提交、
缩略图、多行网格与纵向滚动、点击卡片、PrintScreen，以及禁用扩展后原生 Alt+Tab
是否恢复。

其他命令：

```bash
gnome-extensions enable z-order-alt-tab@recallrw80-afk
gnome-extensions disable z-order-alt-tab@recallrw80-afk   # X11 下可原地重载
gnome-extensions prefs z-order-alt-tab@recallrw80-afk
journalctl -f -o cat /usr/bin/gnome-shell                 # logError() 都进这里
```

Wayland 下新安装或更新扩展后必须注销/重新登录才会被加载；X11 下
`disable` + `enable` 即可热重载。

弹窗打开时持有模态键盘抓取；`Main.pushModal()` 默认把 actionMode 设为 `NONE`，所有
全局快捷键（包括截图）都不会触发，所以扩展会主动转发 PrintScreen。无键盘的延时/脚本
截图仍可用仓库里的工具：

```bash
tools/screenshot.py --delay 5 --output ~/Pictures/switcher.png
```

## 架构

两个入口：`extension.js` 是全部运行时逻辑；`prefs.js` 是独立的 Adw 设置窗口，
把六个 GSettings key 直接 `bind` 到控件上，没有共享代码。UUID 只在
`metadata.json` 里定义，Makefile 用 `sed` 读取它来拼安装目录和 zip 名。

### 运行时对象图

`ZOrderAltTabExtension`（接管快捷键）→ `SwitcherPopup`（`St.BoxLayout` actor，
同时是模态抓取对象）→ 每个窗口一个 `SwitcherItem`（缩略图 + 应用图标 + 标题）。

- 快捷键触发 `_onKeybinding`：创建一个 `SwitcherPopup` 并调用
  `showSwitcher(direction, mask)`；弹窗已存在时只调用 `select(delta)`（只有在拿不到
  模态抓取时才会走到这条路径）。
- `_collectEntries()` 取 `global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace)`，
  再用 `sort_windows_by_stacking()` 排序并 `reverse()`——mutter 返回自底向上，而切换器
  要堆顶在前。桌面窗口会被过滤；没有 compositor actor 的窗口保留，缩略图退化为
  应用图标；少于 2 个窗口不弹。
- **没有持久化的顺序模型**：每次弹出都从 mutter 重新读取实时堆叠顺序。“选中的窗口
  移到堆顶”不是代码在重排列表，而是 `_finish` 里 `Main.activateWindow()` 激活窗口后，
  mutter 自然把它抬到最上层。不要引入扩展自己维护的窗口列表。
- 初始选中项 = 焦点窗口在列表中的下标 + direction。没有焦点时向下从堆顶开始，
  向上从堆底开始（关闭 `wrap-around` 时两者都 `clamp` 到堆顶）。`wrap-around`
  关闭时 `_wrapIndex` 用 `clamp` 停在列表两端。
- `_finish(index)` 是唯一出口：先 `popModal`、断开 stage 信号、`destroy()`，然后才激活
  窗口。`index === null` 表示取消（Esc，或抓取建立前修饰键就已松开）。

### 输入处理

弹窗用 `Main.pushModal(this)` 取得模态键盘抓取（默认 `actionMode: NONE`，会过滤所有
全局 keybinding，所以截图键需要手动转发），期间按键必须通过 actor 的
`vfunc_key_press_event` / `vfunc_key_release_event` 接收；仅连接 `global.stage` 的信号
在抓取期间收不到事件（48.7 上已实测）。`global.stage` 上的 `key-press-event` /
`key-release-event` 只是没拿到抓取时的兜底，handler 里用 `if (this._grab)` 让路。
另外几个容易忽略的细节：

- `_minEventTime` 丢弃触发弹窗的那次按键事件，防止抓取建立后同一事件再被处理一遍。
- 松开召唤弹窗的主修饰键（`_modifierMask`）才提交，而不是松开任意 Alt/Super/Ctrl；
  抓取建立后先用 `global.get_pointer()` 检查该修饰键是否仍按着，若已松开则直接关闭、
  不做任何切换。没有 Alt/Super/Ctrl 的绑定（例如 Shift+Tab 或单键）在松开触发键时提交。
- 弹窗构造时 `visible: false`，加入 uiGroup 并完成定位后才 `visible = true` 并调用
  `get_allocation_box()` 强制分配，然后才进入 150ms 淡入。可见但未分配的 actor 会让
  mutter 为整棵 actor 树打印 "needs an allocation" 警告并跳过该次 stage view 更新。
- 弹窗延迟 `POPUP_SHOW_DELAY` 才淡入，快速点按 Alt+Tab 不会闪一下。
- 抓取期间 shell 的全局截图快捷键不会触发，所以 `PrintScreen` / `Sys_Req` 由扩展
  主动转发给 `Main.screenshotUI.open()`，并先把弹窗淡入完成、滚动到选中项；截图 UI
  关闭后若修饰键已松开就提交。
- 每张卡片都是 `reactive` 的，挂着 `Clutter.ClickAction`，点击卡片直接
  `_finish(index)`，和 Enter 的效果一致。

### 绘制与布局

缩略图是 `Clutter.Clone` 克隆 `window.get_compositor_private()`，用窗口帧矩形缩放；
没有 actor 时退回应用图标。`ClutterBinLayout` 在 mutter 48 里没有 `x_align`/`y_align`，
对齐要设在子 actor 上。`icon-size` 同时控制标题行应用图标和回退图标的大小；
`preview-size` 以百分比缩放缩略图（默认 125%），标题行宽度随之计算。`title-font-size`
控制标题字号（内联 `font-size`），`caption-spacing` 控制图标与标题的间距，标题宽度 =
缩略图宽 − 图标宽 − 间距（最小 1px）。

弹窗外层是 `St.BoxLayout`，里面包一个 `St.ScrollView`；内容按**行优先**排成网格：列数由
工作区宽度、缩略图宽度和每张卡片的固定外框（`ITEM_CHROME_WIDTH`）自动算出，放不下的
窗口换到下一行。弹窗放在焦点窗口所在显示器，纵向位于工作区高度的 `POPUP_TOP_FACTOR`
处；宽度最多为工作区的 90%，高度最多为 `POPUP_MAX_HEIGHT_FACTOR`（72%）。超出时由
`_ensureVisible` 同时调整水平/垂直 adjustment，滚动到选中项。所有样式类以
`.z-order-switcher*` 为前缀，定义在 `stylesheet.css`。

> 尺寸兼容性：`THUMB_*`、`ITEM_CHROME_WIDTH`、`POPUP_CHROME_WIDTH`、
> `SCROLLBAR_ALLOWANCE` 目前按 scale factor = 1 的像素值直接使用；CSS 的
> padding/margin/border 会随缩放放大，`St.Icon` 的 `icon_size` 是逻辑尺寸，所以
> 125%/200% 下列数和标题宽度可能漂移。改这些常量时要乘
> `St.ThemeContext.get_for_stage(global.stage).scale_factor` 并实测。

### 快捷键接管与恢复

Alt+Tab 在不同发行版上分别绑定到 `switch-applications` 或 `switch-windows`，
`KEYBINDINGS` 里的四组都要接管。`_installHandler()` 优先
`Main.wm.setCustomKeybindingHandler()`，不可用时退回
`Meta.keybindings_set_custom_handler()` + `Main.wm.allowKeybinding()`。

`enable()` 时先把 `Main.wm._startSwitcher` 捕获为 `_defaultHandler`；`disable()`
时按优先级恢复：

1. `_defaultHandler`（`_startSwitcher`，GNOME 原生切换器，48 上有效）；
2. `Main.wm._startAppSwitcher`（48.7 没有这个方法，实际会直接落到第 3 条）；
3. 兜底的 MRU 直接切换（`_switchMru`），保证不会留下失效的 Alt+Tab。

三条路径都复用 `_installHandler()` 重新注册；恢复原生处理器时传
`Shell.ActionMode.NORMAL`（shell 48.7 原生 Alt+Tab 只注册在 NORMAL），扩展自己接管时
则用 `NORMAL | OVERVIEW`。48.7 的 `Main.wm.setCustomKeybindingHandler()` 实际只接收
`(name, modes, handler)`，第四个 flags 参数会被忽略。注意
`Meta.keybindings_set_custom_handler(name, null)` **不会**恢复默认处理器（48 上实测）。

### 构建、兼容与发布

`Makefile` 不用 `gnome-extensions pack`，而是自己用 `zip` 组包：Shell 48 的
`gnome-extensions pack` 不会包含 `schemas/gschemas.compiled`，装出来的扩展读不到设置。
`make pack` 会自检 `metadata.json` 在压缩包根目录、compiled schema 在包内。
`tools/check-metadata.py` 拦截 metadata 中的 HTML/转义实体（EGO 上传页的浏览器翻译
曾把名称和描述改写成乱码）。`build/` 里的 zip 和 `docs/screenshot.png` 都是生成物，
可能落后于代码；上传前跑 `make release` 并用 `tools/screenshot.py` 重新截图。

`extension.js` / `prefs.js` 是 ESM（`gi://` + `resource:///`），目标 GNOME Shell 48–51。
新 API 用特性检测；窗口几何先 `get_frame_rect()` 再退回 `get_frame_bounds()`；UI 容器
先 `Main.uiGroup` 再退回 `Main.layoutManager.uiGroup`。不要使用 `imports.*`，EGO 审核会拒绝。

发布到 extensions.gnome.org 的完整流程（uuid、tag、上传、审核、更新）见 `PUBLISHING.md`；
产物由 `make release` 生成。

## 开发约定

- 改动前先阅读相关模块。
- 保持与现有代码风格一致：4 空格缩进、单引号、`GObject.registerClass`、
  SPDX 头（GPL-2.0-or-later）。
- **不做任何“自动提交”**：只有用户松开召唤用的主修饰键（无修饰键的绑定则松开触发键）、
  Enter/Space 或点击卡片才切换，Esc 取消；不要重新引入空闲超时自动提交。
- 新增/修改设置项要同时改 `schemas/*.gschema.xml`（默认值与 range）、`prefs.js`
  （控件与 Adjustment 范围）、`extension.js`（读取处）和 `README.md` 的中英文两节。
- 改完跑 `make check`；不要在仓库里提交 `build/` 和 `schemas/gschemas.compiled`。
