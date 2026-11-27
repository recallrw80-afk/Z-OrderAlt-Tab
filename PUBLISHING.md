# 发布到 extensions.gnome.org

本文记录把这个扩展发布到 GNOME 官方扩展站（EGO）的完整流程。EGO 只接受
`metadata.json` 位于压缩包根目录的 zip，并且每一次上传都要人工审核。

## 0. 发布前检查清单

- [ ] `make check` 通过
- [ ] 在本机 GNOME Shell 上实测：Alt+Tab、Shift+Alt+Tab、Esc、松手切换、缩略图、
      多行网格与滚动、点击卡片、PrintScreen
- [ ] 禁用扩展后原生 Alt+Tab 恢复
- [ ] `disable()` 里释放了所有资源（快捷键、抓取、信号、actor）
- [ ] `metadata.json` 的 `shell-version` 包含当前 GNOME 稳定版
- [ ] 仓库里有 `LICENSE`，所有源文件都有 SPDX 头
- [ ] 没有把 `build/`、`.git` 打进 zip

## 1. 先把 uuid 改成可发布的

`metadata.json` 里的 `uuid` 是唯一来源（`Makefile` 会自动读取）：

```json
"uuid": "z-order-alt-tab@your-name.example"
```

- EGO 上 uuid 全局唯一，`@local` 这种写法虽然能用，但不适合发布；
  惯例是 `<扩展名>@<域名或昵称>`。
- 改完执行 `make install`，旧的扩展目录（用旧 uuid 的那份）手动删掉，
  并在 `org.gnome.shell enabled-extensions` 里替换 uuid。
- `uuid` 只在 `metadata.json` 里，安装目录名和 zip 名会自动跟着变；schema id 是
  `Makefile` 和 schema 文件里硬编码的独立值，不跟着 uuid 变，也不需要变。

## 2. 打 tag、出包

```bash
make release        # = make check + make pack
git tag -a v1.0.0 -m "Z-Order Alt-Tab 1.0.0"
git push --tags
```

产物是 `build/<uuid>.shell-extension.zip`，内容形如：

```
metadata.json
extension.js
prefs.js
stylesheet.css
LICENSE
schemas/gschemas.compiled
schemas/org.gnome.shell.extensions.z-order-alt-tab.gschema.xml
```

两个硬性要求，`make pack` 会自检并在不满足时直接失败：

1. **metadata.json 在压缩包根目录**（不要把仓库目录整个压进去）；
2. **schemas/gschemas.compiled 必须在包里**。

> 为什么不用 `gnome-extensions pack`：GNOME Shell 48 的 `gnome-extensions pack`
> 只会把 `schemas/*.gschema.xml` 放进包里，**不会**附上 `gschemas.compiled`，
> 从那个包安装后设置会加载失败。所以这里用 `zip` 自己组装并校验。

## 2.5 metadata.json 的硬性规则

对照 [GNOME Shell 扩展审核规范](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)：

- `shell-version` **只能列已发布的稳定版本**（最多带一个开发版），不能声明支持未来的版本。
  当前列表 `["48","49","50","51"]`，这四个都已是稳定版，EGO 后台也认识 51。
- 如果扩展只用 `user` 会话模式，**必须删掉 `session-modes`**（本项目已删）。
- `url` 应指向可以反馈问题的仓库（本项目指向 GitHub）。
- 许可必须是 OSI 认可的许可证（本项目 GPL-2.0-or-later）。
- `version` 字段已废弃，不要写；EGO 自己给每次上传编号。
- **上传时不要开着浏览器网页翻译**（Chrome/Google 翻译的“翻译此页”）。它会把上传表单里的
  `name` / `description` 改写成带 `<font dir="auto" ...>` 的译文并转义，EGO 会原样存下来，
  页面就会显示成 `&amp;lt;font ...&amp;gt;` 的乱码。`make check` 里的
  `tools/check-metadata.py` 会拦掉这种 markup。
- `name` / `description` 只能是纯文本；`description` 里的段落用 `\n`，列表用 `*` 开头。

> 已经存进 EGO 的乱码**不会**因为之后关掉网页翻译而恢复：那是数据库里的值，
> 页面上的 `&amp;lt;font …` 只是 Django 又转义了一次。修的办法只有重新上传一个
> metadata 干净的版本（或者在个人页删掉待审条目再传）。

上传前先确认手里的 zip 是干净的：

```bash
unzip -p build/z-order-alt-tab@recallrw80-afk.shell-extension.zip metadata.json
unzip -p build/z-order-alt-tab@recallrw80-afk.shell-extension.zip metadata.json |
    python3 tools/check-metadata.py /dev/stdin
```

两个字段应该正好是 `Z-Order Alt-Tab` 和英文描述；如果上传页把它们显示成输入框，
提交前手动确认内容，别让浏览器翻译插件改写。

## 2.6 上传前在本地验证这个 zip

```bash
gnome-extensions install --force build/z-order-alt-tab@recallrw80-afk.shell-extension.zip
gnome-extensions info z-order-alt-tab@recallrw80-afk     # State: ACTIVE / Enabled: Yes
```

装完至少按一次 Alt+Tab 看缩略图和切换是否正常，再 `make install` 恢复到开发版本。

> 小坑：`gnome-extensions install` 在 `XDG_DATA_HOME` 指向一个不存在的目录树时
> 会报 "Can't recursively copy directory"。用真实的用户目录（或先 `make install`
> 让目录存在）再装即可。

## 3. 上传

1. 用 GNOME 账号登录 <https://extensions.gnome.org>。
2. 打开 <https://extensions.gnome.org/upload/>，或者在用户菜单里选择
   **Upload Extension**（首次发布用这个，不是 “Add Extension”）。
3. 选择上面生成的 zip。
4. 站点会解析 `metadata.json`，显示名称、描述、支持的 Shell 版本；
   确认无误后提交。
5. 提交后扩展进入 **审核队列**（页面上会显示 pending / awaiting review）。

> 如果上传时提示某个 `shell-version` 未知：EGO 只认识它数据库里已有的版本。
> 例如 51 还没发布时，先把 `metadata.json` 里的 `"51"` 去掉再打包，代码不用改，
> 等 EGO 收录该版本后再加回来并上传新版本。

## 4. 审核

- 由志愿者人工审核，通常几天到几周；被拒会收到站内/邮件通知，附带理由。
- 看到 `Auto-rejected because of new version N was uploaded` 不用慌：这是站点在
  你上传新版本后，把**被取代的旧待审版本**自动标记为拒绝，免得审核员审旧包。
  扩展本身仍是 pending，队列里是新的那个版本；不要因此再传一次，否则新版也会
  被下一次上传自动拒绝，永远排队。
- 被拒后修完代码，重新打包上传即可（新版本会重新进入队列）。
- 常见的退回原因（这个项目也适用）：

| 原因 | 这里的状态 |
| --- | --- |
| 使用 `imports.*` 旧式导入 | 全部使用 ESM `import` |
| `disable()` 没清理干净 | 恢复快捷键、销毁弹窗、断开信号、释放抓取 |
| 用版本校验绕过 / 修改 `version-validation` | 没有 |
| 硬编码路径、写入用户目录 | 没有 |
| schema 没随包分发 | `schemas/gschemas.compiled` 随 zip |
| 缺少开源许可 | `LICENSE` + 每个文件 SPDX 头 |
| 破坏其它扩展 | 只接管 Alt+Tab 四个绑定，禁用即恢复 |
| 使用私有 API | 仅 `Main.wm._startSwitcher`（恢复原生切换器，带降级链） |

如果审核对私有 API 有意见，可以解释清楚用途，或者退化成“禁用时直接移除自定义处理器”的方案。

## 5. 后续更新

```bash
# 改代码 → make check → 本机实测
git tag -a v1.1.0 -m "Z-Order Alt-Tab 1.1.0" && git push --tags
make release
```

然后在扩展页面选择 **Upload new version**，上传新 zip。EGO 会给每次上传分配版本号，
不需要在 `metadata.json` 里写版本。

## 6. 文案与截图

- 扩展页面可以补充截图（需登录）。建议 1920×1080，截一张弹窗里有 3–4 个
  带缩略图的窗口、其中一个高亮的画面。
- 弹窗会抓走键盘，`Main.pushModal()` 默认用 `actionMode: NONE` 过滤全局快捷键，
  所以扩展会把 PrintScreen 主动转发给截图 UI，切换器本身也会出现在截图里。
  延时/脚本截图仍可用：

  ```bash
  tools/screenshot.py --delay 5 --output docs/screenshot.png
  # 然后按住 Alt+Tab 翻到想要的画面
  ```

  仓库当前的 `docs/screenshot.png` 是旧版布局，发布前用当前代码重截再上传。
- 描述保持纯文本、说明“按 z 序切换、不按 MRU、不按应用分组”。

## 7. 备选分发方式

不想等审核或只给自己用时：

```bash
# 从 zip 安装（覆盖已存在的同名扩展）
gnome-extensions install --force build/z-order-alt-tab@recallrw80-afk.shell-extension.zip
# 或者直接从仓库安装
make install && gnome-extensions enable <uuid>
```

也可以把 zip 挂到 GitHub Releases，让用户下载后手动安装。

## 8. 许可注意

- 本项目是 **GPL-2.0-or-later**，与 GNOME Shell 本身一致，EGO 接受。
- 发布 zip 里要带上 `LICENSE`（`make pack` 已经包含）。
- 新增文件时补上 SPDX 头，避免审核时被要求返工。