# 伴读应用图标 v2

日期：2026-10-04。

原图标为 64×64 PNG，细小矩形与双竖条难以表达阅读。新版使用深绿色圆角底、米白开放书页和暖橙色对话气泡，表达「读到哪里，聊到哪里」。没有小字与细线，便于在 Dock 中辨认。

图像通过内置 Imagegen 生成，透明边角保留。源图为 `src-tauri/icons/reader-v2.png`；使用项目已有 Tauri 工具生成各尺寸与 macOS ICNS，最终使用 `src-tauri/icons/reader-v2.icns`。原始 `icon.png` 保留以便回退。应用打包配置指向新版。

已经目视检查 32px、64px 输出。图标资源调整不涉及阅读、对话、存储逻辑。本次不运行实现测试。

## 本机交付

Tauri debug 构建完成，应用仍为 0.1.0。包内 `reader-v2.icns` 与源图标产物校验一致，完整 ad-hoc 签名验证通过。新版已安装到 `/Applications/AI Native Reader.app`，全部 4 个文件与构建包一致。替换前确认该安装路径下的应用未运行，旧应用副本保存在忽略目录 `data/icon-v2/previous-installed/`。详细构建与文件校验记录在 `data/icon-v2/`。

图标先更新至原开发仓库及本机应用。随后按用户授权同步至公开 GitHub 仓库，并发布新的 v0.1.1 预览版；v0.1.0 及其附件保留。

## GitHub 交付

公开提交与标签：`5c4585ec38c3fdded64af7e24ca2f436b58f3931` / `v0.1.1`。

- 发布：https://github.com/leoyang1984/ai-native-reader/releases/tag/v0.1.1
- GitHub 构建：37201948671；CI：37201947835，均成功。
- 包含 Mac arm64 ZIP、完整对应源码 TAR.GZ、SHA256SUMS；三个附件服务端校验值均与本地相同。
- 新 ICNS、版本、架构、许可资源及完整 ad-hoc 签名通过核对；匿名公开应用下载与 checksum 核对通过。
- 公开版的发行版本为 0.1.1，本机既有安装为 0.1.0 开发包，二者均已使用新图标。原开发仓库的私人历史未推送。

发行记录在忽略目录 `data/public-release/2026-10-04/icon-v0.1.1/`。未重新执行实现测试或真实模型问答。

## 生成提示词

```text
Use case: logo-brand.
Asset type: production macOS app icon for 伴读 / AI Native Reader, a quiet EPUB reader with an adjacent conversational assistant.
Primary request: create one exceptionally clear, memorable app icon, recognizable in a Dock at 32 pixels. Square 1024x1024 canvas. A large rounded-square tile centered with transparent space around the outer corners, taking about 90% of canvas width. Tile is deep forest green (#344E42), subtle matte ceramic relief, very slight soft tonal variation. One bold warm ivory (#FFF4DC) open book silhouette occupies about 65% of the tile width. Thick, broad, calm curved page shapes, clearly visible central gutter. Integrate a single small terracotta (#D17D56) rounded conversation bubble with a short pointed tail emerging from the upper-right page: a clear companion to the book, not a separate floating badge. The bubble is about 24% of tile width and contains no text, dots or micro-details. The book and chat bubble should form one distinctive balanced emblem.
Style: disciplined contemporary macOS icon, frontal orthographic, clean near-flat geometric surfaces with only gentle edge depth, elegant editorial reading identity. Strong contrast, bold silhouette and abundant separation between forms. Not a realistic book illustration.
Constraints: exactly one icon; no words, letters, numbers, slogans, sparkles, stars, robot face, circuitry, logos of existing apps, or extra marks. No thin strokes, no detailed page lines. No showcase mockup, background scene, desk, border frame, perspective tilt, multiple alternatives, or grid. Actual transparent alpha outside the rounded-square tile; preserve solid opaque tile and emblem.
```
