# Z-Order Alt-Tab

GNOME Shell 扩展：用 **层叠顺序（z-order）** 切换窗口，而不是 GNOME 默认的
“最近使用（MRU）+ 按应用分组”顺序。

所有窗口都是平级的：列表里每个窗口占一行，按它们在屏幕上的堆叠位置排列，
最上面的窗口排在最前。按 Alt+Tab 沿着这个列表往下走，松开 Alt 时切换到最后
选中的窗口——它被激活后自然升到堆顶。

## 切换规则

以列表 `a1 a2 b1 b2 c1 c2` 为例（最后一个在堆顶）：

| 操作 | 切换到 | 切换后的层叠顺序 |
| --- | --- | --- |
| Alt+Tab | a1 | `a2 b1 b2 c1 c2 a1` |
| 再按一次 Tab | b2 | `a2 b1 c1 c2 a1 b2` |

也就是说：**被切换到的窗口会移动到列表末尾（堆顶）**，其余窗口的相对顺序不变。
第一次按 Alt+Tab 默认选中当前焦点窗口下面那一层；如果没有焦点窗口，则从堆顶开始。

## 交互

| 按键 | 作用 |
| --- | --- |
| `Alt+Tab` | 向下一层（默认绑定） |
| `Alt+Shift+Tab` | 向上一层 |
| `↑` / `↓` / `←` / `→` | 同上，方向键也可用 |
| `PageUp` / `PageDown` | 同上 |
| `Esc` | 取消，不切换 |
| `Enter` / `Space` | 立即切换到当前选中的窗口 |

按键绑定沿用 GNOME 的 `switch-applications` / `switch-applications-backward`
和 `switch-windows` / `switch-windows-backward`。不同发行版会把 Alt+Tab 绑到
其中一套上，扩展两套都会接管，因此无论哪种默认设置都能生效，也会尊重用户在
系统设置里对这四个快捷键的修改。

## 设置

`gnome-extensions prefs z-order-alt-tab@local`

- **只切换当前工作区**（默认开启）：关掉后会在所有工作区的窗口之间切换。
- **循环**（默认开启）：走到列表末尾后从堆顶继续。
- **图标大小**：弹窗中应用图标的像素大小（16–64）。

## 安装

需要 GNOME Shell 45 及以上（本仓库在 48.7 / Debian 13 / Wayland 上实测）。

```bash
make install                 # 复制到 ~/.local/share/gnome-shell/extensions/
gnome-extensions enable z-order-alt-tab@local
```

Wayland 会话下，第一次安装后需要注销并重新登录，扩展才会被加载；之后在
X11 会话里可以直接用 `gnome-extensions disable/enable` 重新加载。

卸载：

```bash
make uninstall
```

打包成可分发的 zip：

```bash
make pack                    # build/z-order-alt-tab@local.shell-extension.zip
```

## 开发

```bash
make check                   # 编译 GSettings schema + node --check 语法检查
```

实现要点：

- 窗口列表来自 `global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace)`，
  再用 `global.display.sort_windows_by_stacking()` 按 z 序排序。
- 弹窗用 `Main.pushModal()` 抓取键盘，因此按键事件走 `vfunc_key_press_event` /
  `vfunc_key_release_event`（模态抓取期间的按键不会传到 stage）。
- 松开 Alt/Super/Ctrl 时提交；如果按下 Alt+Tab 后很快松开 Alt（抓取建立前按键已
  释放），会用 `global.get_pointer()` 的修饰键状态检测并立即提交。
- 15 秒没有任何按键会自动提交并释放抓取，避免任何情况下把整机会话的键盘卡住。

## 已知限制

- 弹窗显示应用图标 + 窗口标题，不渲染窗口缩略图。
- 弹窗出现在焦点窗口所在显示器上，并且只在一台显示器上显示。
- 只接管 Alt+Tab 系列快捷键，不影响反引号（同应用窗口切换）。

## 许可

GPL-2.0-or-later，见各源文件头部的 SPDX 标识。