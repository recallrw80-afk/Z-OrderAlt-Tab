# AGENTS.md

## 项目

**Z-Order Alt-Tab**——GNOME Shell 扩展（GNOME 45+，ESM 模块）。用层叠顺序
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
| `extension.js` | 全部运行时逻辑：接管快捷键、收集窗口、弹窗与按键处理 |
| `prefs.js` | Adw 首选项窗口 |
| `schemas/*.gschema.xml` | 三个设置项：`current-workspace-only`、`wrap-around`、`icon-size` |
| `stylesheet.css` | 弹窗样式（`.z-order-switcher*`） |
| `Makefile` | `check` / `install` / `uninstall` / `pack` / `schemas` |

## 约定

- 改动前先阅读相关模块。
- 保持与现有代码风格一致：4 空格缩进、单引号、`GObject.registerClass`、
  SPDX 头（GPL-2.0-or-later）。
- 弹窗必须在模态抓取期间通过 actor 的 `vfunc_key_press_event` /
  `vfunc_key_release_event` 收键；仅连接 `global.stage` 的信号在抓取期间收不到事件。
- 任何会让弹窗保持打开的改动，都要保证抓取最终一定被释放（Alt 松开、Esc、
  15 秒 watchdog）。
- 改完跑 `make check`；不要在仓库里提交 `build/` 产物。

## 快捷键接管

Alt+Tab 在不同发行版上分别绑定到 `switch-applications` 或 `switch-windows`，
`KEYBINDINGS` 里的四组都要接管；`disable()` 时必须用 `Main.wm._startSwitcher`
把 GNOME 原生切换器恢复回去。
