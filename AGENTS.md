# AGENTS.md

## 项目

**Z-Order Alt-Tab**——GNOME Shell 扩展（GNOME 48–51，ESM 模块）。用层叠顺序
（z-order）切换窗口，替代 GNOME 默认的 MRU / 按应用分组切换。

核心语义（不要随意改动，这是产品定义）：

- 所有窗口平级，不按应用分组。
- 列表按 z 序排列，最上面的窗口排最前。
- 每按一次 Tab 沿列表向下走一层；被切换到的窗口激活后移动到列表末尾（堆顶），
  其余窗口相对顺序不变。
- 例：`a1 a2 b1 b2 c1 c2`（末尾在堆顶）→ 切到 a1 → `a2 b1 b2 c1 c2 a1`
  → 再切到 b2 → `a2 b1 c1 c2 a1 b2`。

## 结构

| 文件 | 作用 |
| --- | --- |
| `extension.js` | 全部运行时逻辑：接管快捷键、收集窗口、缩略图弹窗与按键处理 |
| `prefs.js` | Adw 首选项窗口 |
| `schemas/*.gschema.xml` | 三个设置项：`current-workspace-only`、`wrap-around`、`icon-size` |
| `stylesheet.css` | 弹窗样式（`.z-order-switcher*`） |
| `Makefile` | `check` / `install` / `uninstall` / `pack` / `schemas` |

## 约定

- 改动前先阅读相关模块。
- 保持与现有代码风格一致：4 空格缩进、单引号、`GObject.registerClass`、
  SPDX 头（GPL-2.0-or-later）。
- **不做任何“自动提交”**：只有用户松开修饰键、Enter/Space 才切换，Esc 取消；
  不要重新引入空闲超时自动提交。
- 弹窗必须在模态抓取期间通过 actor 的 `vfunc_key_press_event` /
  `vfunc_key_release_event` 收键；仅连接 `global.stage` 的信号在抓取期间收不到事件
  （48.7 上已实测）。
- 缩略图用 `Clutter.Clone` 克隆 `window.get_compositor_private()`；没有 actor 时退回
  应用图标。`ClutterBinLayout` 在 mutter 48 里没有 `x_align`/`y_align`，对齐要设在子 actor 上。
- 兼容 GNOME Shell 48–51：新 API 用特性检测；窗口几何先 `get_frame_rect()` 再退回
  `get_frame_bounds()`；UI 容器先 `Main.uiGroup` 再退回 `Main.layoutManager.uiGroup`。
- 改完跑 `make check`；不要在仓库里提交 `build/` 和 `schemas/gschemas.compiled`。

## 快捷键接管

Alt+Tab 在不同发行版上分别绑定到 `switch-applications` 或 `switch-windows`，
`KEYBINDINGS` 里的四组都要接管。`disable()` 时按优先级恢复：

1. `Main.wm._startSwitcher`（GNOME 原生切换器，48 上有效）；
2. `Main.wm._startAppSwitcher`；
3. 兜底的 MRU 直接切换（`_switchMru`），保证不会留下失效的 Alt+Tab。

注意 `Meta.keybindings_set_custom_handler(name, null)` **不会**恢复默认处理器（48 上实测）。
