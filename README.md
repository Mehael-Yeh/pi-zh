# Pi 命令菜单中文说明

用户级扩展，通过公开的 CustomEditor / setEditorComponent / AutocompleteProvider 接口，在显示命令补全结果前添加中文说明。不修改 Pi 安装文件，不调用网络或模型。

## 启用

在 Pi 中执行 `/reload`，然后输入 `/` 或 `/model` 查看菜单；如果没有生效，重启 Pi。默认显示“中文 · 原说明”，保持命令、参数提示和执行逻辑不变。

## 安装与复用

扩展是纯源码目录，无需构建，直接放入用户扩展目录即可。

```powershell
# 本机已启用：目录就在 Pi 用户扩展目录下
# C:\Users\<用户名>\.pi\agent\extensions\command-menu-zh

# 复用到其他机器：克隆到用户扩展目录
cd "$HOME\.pi\agent\extensions"
git clone https://github.com/Mehael-Yeh/pi-command-menu-zh.git command-menu-zh
# 然后在 Pi 中执行 /reload
```

依赖来自 Pi 自身安装（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`），不要在扩展目录执行 `npm install`；`verify.mjs` 需要传入 Pi 安装目录下的 `node_modules`。

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `index.ts` | 扩展入口，包装补全提供者，输出“中文 · 原说明” |
| `third-party.ts` | 第三方 npm 包命令词典（含别名、条件命令、提示模板） |
| `translations.json` | 用户自定义翻译，优先于第三方词典 |
| `upgrade-baseline.json` | 审核时记录的包文件 SHA-256 基线 |
| `baseline-archive/` | 历次审核确认后的旧基线存档，便于追溯 |
| `check-upgrades.ps1` | 升级后检查基线是否漂移（只检查，不改动） |
| `verify.mjs` | 手动验证脚本，不随 Pi 自动加载 |

## 增补翻译

编辑本目录 `translations.json`，键为不带 `/` 的完整命令名，值为中文说明，保存后 `/reload`。未收录命令保留原说明。技能命令统一增加“加载技能”，原技能说明保留。

## 第三方命令与升级检查

`third-party.ts` 收录当前 settings.json 中 11 个 npm 包的 156 个命令名称（包含别名、条件命令、内部桥接命令和提示模板）。每组注释标记审核时的包版本；`upgrade-baseline.json` 记录代码、提示模板及技能文档的 SHA-256。实际显示的命令仍由第三方包配置和当前模式决定，词典不注册或启用命令。

Bigpowers 与 pi-subagents 提示模板已收录。`skill:<name>` 优先使用同名命令翻译，其他技能仅增加“加载技能”并保留原说明。`@juicesharp/rpiv-todo` 提供 `/todos`；`@juicesharp/rpiv-ask-user-question` 与 `openwiki` 只注册工具和技能（openwiki 另提供 `skill:openwiki`），没有斜杠命令，因此只由通用技能翻译覆盖。MCP 服务动态下发的提示命令无法通过包源码穷举；当前 amap-maps 缓存未发现提示目录。未来新包、新模板或动态命令需要再次检查并补充。

用户 `translations.json` 优先于第三方默认词典，可覆盖说明。

升级后在 PowerShell 7 中运行（只检查，不自动修改基线）：

```powershell
& "$HOME\.pi\agent\extensions\command-menu-zh\check-upgrades.ps1"
```

版本或源文件变化将列出 VERSION／CHANGED／ADDED／REMOVED，并以退出码 1 提示人工复核。脚本要求 PowerShell 7。不自动更新翻译，不改动任何第三方文件。确认变化并修改词典后，再把旧基线移入 `baseline-archive/` 并用 `-Capture` 建立新基线；保留旧文件便于追溯。

## 持久化与边界

此目录位于用户扩展目录，不在 install/releases 内，Pi 升级不会覆盖。未来公开接口发生不兼容变化时仍可能需要适配；已知接口缺失或词典损坏会通知并跳过汉化。

本扩展占用自定义编辑器位置，不能保证与 Vim 编辑器等其他 setEditorComponent 扩展同时生效：通常后设置的编辑器覆盖前者。遇到冲突，应将补全包装逻辑整合到已有编辑器扩展。

只处理命令菜单说明，不翻译设置界面、消息、工具说明或模型回复。不会自动翻译新安装扩展的任意说明。

## 验证

`verify.mjs` 是手动测试，不自动加载。执行：

```powershell
node "$HOME\.pi\agent\extensions\command-menu-zh\verify.mjs" "<当前 Pi 安装目录>\node_modules"
```

已在 Pi 1.1.0 上通过 24 个内置命令、156 个第三方翻译、249 处源码字面量命令／模板匹配覆盖，以及真实补全提供者、补全结果保持、未知命令回退、文件隔离、重复包装不重复翻译、自定义编辑器构造和非 TUI 模式跳过测试。动态名称（BTW 表、MCP 别名和 Fusion 模型选择器）与变量名注册（如 `/todos`）人工核对。真实终端视觉效果需要在交互会话中确认。

## 停用

将本目录移出 `~/.pi/agent/extensions/`，然后 `/reload` 或重启 Pi。
