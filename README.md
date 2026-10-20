# pi-zh

给 [Pi](https://pi.dev) 补上**简体中文界面**的用户级扩展：命令菜单说明 + 内置 TUI 界面文案。

纯源码、免构建、不改 Pi 安装文件、不联网、不调用模型。**只加中文，不改行为**：命令名、参数、配置键、取值与交互逻辑一律保持原样。

```
→ 自动压缩                          true
  自动补全最多显示条目                8
  Automatically compact context when it gets too large
  中文：上下文过大时自动压缩
  输入即搜索 · 回车/空格 修改 · Esc 取消
```

## 功能一览

| 功能 | 效果 |
| --- | --- |
| 命令菜单 | 斜杠命令补全列表的说明显示为「中文 · 原说明」，命令名与参数不变 |
| 设置界面 `/settings` | 标签中文、英文原说明保留并追加「中文：…」行、值列对齐不变、提示行中文 |
| 选择器（`/theme` `/model` `/thinking` `/images` `/sessions` `/tree` `/login` 等） | 行内说明「英文 · 中文」、标题、空态、提示行中文 |
| 未导出的对话框（`/trust` `/config` `/bug` `/share`、scoped models、首次运行引导…） | 编辑器容器兜底：整行文案中文 |
| `/hotkeys` 速查表 | 画框表格按单元格等宽翻译，含第三方扩展说明，边框不错位 |
| 聊天区外壳 | 标题、状态行（`/reload`、`Model: …`、`Session compacted …`）、通知、`Error:`/`Warning:` 提示、启动头部与 `ctrl+o` 展开视图的按键提示、`[Context]`/`[Skills]` 等资源分节标题、全屏指示条 |

## 安装与开关

扩展按目录自动发现，无需注册。

```powershell
# 复用到其他机器
cd "$HOME\.pi\agent\extensions"
git clone https://github.com/Mehael-Yeh/pi-zh.git pi-zh
# 然后在 Pi 里 /reload
```

依赖直接取 Pi 自身安装里的包，**不要在扩展目录执行 `npm install`**。

| 环境变量 | 作用 |
| --- | --- |
| （默认） | 命令菜单 + 界面汉化全部启用 |
| `PI_UI_ZH=0` / `off` | 只关界面汉化，命令菜单照常 |
| `PI_UI_ZH_ROOT=<目录>` | 手动指定 `@earendil-works/pi-coding-agent` 所在目录（自动探测失败时用） |
| `PI_UI_ZH_LOG=0` | 关闭诊断日志 |

界面汉化失败只在通知栏提示「界面汉化未启用：…」，不会影响命令菜单，也不会影响 Pi 本身。

## 工作原理

Pi 没有界面翻译钩子，扩展加载器解析到的包与 Pi 实际运行的代码也不一定是同一份，因此做法是**给运行中 Pi 真正使用的组件类安装渲染装饰器**。

1. **取到「活的」类**：扫描 `dist/bundle/chunks/*.js` 的 `export {…}` 建立“导出名 → chunk 文件”映射并用 `import(file://…)` 载入；同时用普通 `import("@earendil-works/pi-coding-agent")` / `import("@earendil-works/pi-tui")` 取包入口导出的类。两条来源都收集，**对每个不同副本分别打补丁**，所以无论渲染走哪一份都生效。
2. **渲染装饰器**：保留原 `render` 结果，先通过词典逐行后处理（保留 ANSI、保持可视宽度、异常一律回退原行），再交回原流程。
3. **可替换包裹**：每次安装都用“真正的原方法”重新包一层并替换原型上的 `render`（不叠加、不套娃），因此 `/reload` 能升级已装补丁的逻辑。
4. **编辑器容器兜底**：挂钩 `Container.addChild`，凡加入过 `Editor` 的容器即视为“编辑器容器”，此后加入其中的屏幕组件（Pi 的 `showSelector` 挂载的所有对话框）自动获得整行汉化；聊天记录（`ScrollView`）与输入框不受影响。
5. **主题包装**：包 `theme.fg` / `theme.bold`，按整串精确匹配 `chromeTitles`，`dim`/`muted` 角色另查 `statusTexts`/`statusPatterns`，与角色无关的模板查 `textPatterns`；命中才替换并保留首尾空白。`showError`/`showWarning` 的 `Error: …` / `Warning: …` 前缀保留、正文查词典，未收录正文保持英文。
6. **画框表格**：仅在 Markdown 渲染出 `│ Key │ Action │` 表头时按单元格翻译（单元格总宽不变 ⇒ 边框不错位）；普通 Markdown 即模型回复，绝不触碰。
7. **多行段落**：把连续非空行拼回整段查 `paragraphs`/`paragraphPatterns`，命中后按原缩进与当前宽度重新折行（窄终端也能命中）。

词典通过 `globalThis` 上的代理实时读取，所以**只改 `ui-zh.json` 时 `/reload` 就生效**；改动补丁代码（新增补丁点或逻辑变化）需要递增 `ui-zh.ts` 里的 `CODE_VERSION`，`/reload` 便会重装包裹；个别情况下（进程里跑着更旧的代码）需要完全重启 Pi。

## 覆盖范围

| 补丁点 | 覆盖的界面 |
| --- | --- |
| `SettingsList.render` / `addHintLine` | `/settings` 主列表及其二级菜单：标签、值列、英文原说明、追加的中文说明、提示行 |
| `SelectList.renderItem` / `render` | `/theme`、`/thinking`、`/images`、设置二级菜单：行内说明与整行文案 |
| 11 个导出组件类的 `render` | `SettingsSelectorComponent`、`ThemeSelectorComponent`、`ShowImagesSelectorComponent`、`ThinkingSelectorComponent`、`LoginDialogComponent`、`ModelSelectorComponent`、`SessionSelectorComponent`、`TreeSelectorComponent`、`OAuthSelectorComponent`、`ExtensionSelectorComponent`、`UserMessageSelectorComponent` |
| `Container.addChild` + 编辑器容器兜底 | 未导出、无法按类名定位的屏幕：`/trust`、`/config`、scoped models、首次运行引导、`/bug`、`/share` 等（只翻词典命中的整行） |
| `Markdown.render`（画框表格签名门控） | `/hotkeys` 的命令速查表（含「扩展」小节的第三方说明） |
| 全局 `theme.fg` / `theme.bold` | 聊天区标题、状态行、通知、`Error:`/`Warning:`、启动头部与 `ctrl+o` 展开视图的按键提示、资源分节标题与冲突横幅、全屏指示条 |

**按设计不翻译**（会污染模型输出或没有翻译价值）：

| 类别 | 例子 |
| --- | --- |
| 聊天记录、工具输出、diff、mermaid、消息内容 | 助手回复、工具结果、`[branch]`/`[compaction]` 摘要条目 |
| 专有名词 | 模型 id、服务商、主题名、会话标题、文件路径、时间戳、token 数与金额 |
| 命令名与代码片段 | `/changelog`、`loop: true` |
| 终端控制台输出 | 崩溃时写到 stderr 的诊断文本 |
| 第三方扩展文案 | 除非登记进 `extensionTexts` |

**已打印到终端的内容不会被追溯汉化**：常规模式里旧输出留在回滚缓冲区，改完词典后需重新执行命令（再按一次 `/hotkeys`、再开一次 `/settings`）；选择器/对话框这类会重绘的界面当场生效。

## 词典

`ui-zh.json` 的全部段落：

| 段落 | 用途 |
| --- | --- |
| `labels` | 列表行的**标签列**、独立标题行（带 `✓` 的行自动去标记后匹配） |
| `descriptions` | 选项说明：选中项会追加「中文：…」行；列表行的行内说明也查这里 |
| `texts` | 整行文案：标题、提示行、空态、对话框标题与选项 |
| `patterns` | 带变量的整行：`["锚定正则", "中文模板（$1 等）"]` |
| `values` | 值列取值：`true`→`开`、`sse`→`SSE` 等（同宽替换，不破坏对齐） |
| `chromeTitles` | 任何经 `theme.fg`/`bold` 渲染、长度 ≤ 80 的界面串：面板标题、空态、字段名、通知、资源分节标题 |
| `statusTexts` / `statusPatterns` | 聊天区状态行（`dim`/`muted` 角色）：`/reload` 提示、`Model: …`、`Session compacted …` 等，模板必须锚定 |
| `textPatterns` | 与颜色角色无关的模板串：`↓ Jump to latest message`、`Loading …`、`Failed to load theme "…"`、缓存未命中/思考块丢弃通知等 |
| `extensionTexts` | 第三方扩展注册的文案（`/hotkeys` 的「扩展」小节）；不在 Pi 源码里，故单独成段、不做漂移检查 |
| `paragraphs` | 会被折行的多行段落（如 `/bug` 的隐私声明）：拼回整段再查表，命中后按宽度重排 |
| `paragraphPatterns` | 含动态内容的多行段落 |
| `inline` | 单行说明格式：`en+zh`「英文 · 中文」（默认）、`zh` 只中文、`zh+en`「中文 · 英文」 |

命中顺序：多行段落（拼回整段后用 `paragraphs` / `paragraphPatterns`）→ 整行精确（`texts` → `labels` → `extensionTexts`）→ `patterns`（**首个命中即返回，所以更具体的模板要放前面**）→ 标签列 + 值列。

写作规则（`verify-ui.mjs` 会强制检查）：

- 键一律不带首尾空格（引擎按 `trim()` 后查表）。
- `labels` / `descriptions` 的键必须**逐字存在**于 Pi 源码，否则漂移检查失败；`texts` 的漂移只告警。
- `descriptions` 与 `texts` **不得重叠**：选项说明若进了 `texts`，英文原文会被就地替换掉。
- `patterns` / `statusPatterns` / `textPatterns` / `paragraphPatterns` 必须能编译；后两者还必须锚定（`^…$`）。
- 源码里的 `\u00b7`、`\u2022`、`\u2713` 与 `\n` 转义要按运行时字符写入，否则比对不上。

命令菜单词典另有两个文件：`translations.json`（键为不带 `/` 的完整命令名，优先于第三方词典；未收录的命令保留原说明，技能命令统一加「加载技能」）与 `third-party.ts`（第三方 npm 包命令，含别名、条件命令与提示模板）。

## 维护工具

都需 Node 22+（本机 v24 可直接运行 `.ts`），手动执行、不随 Pi 加载：

```powershell
cd "$HOME\.pi\agent\extensions\pi-zh"

node verify-ui.mjs --strict   # 离线渲染真实组件并断言（--strict 把警告当失败）
node coverage.mjs --show 12   # 界面字面量覆盖率盘点，列出未覆盖文案
node audit-ui.mjs             # 主题通路审计（theme.fg/bold、showStatus/showError、keyHint…）
node verify.mjs "$HOME\.pi\agent\install\releases\1.3.0\node_modules"   # 命令菜单验证
```

| 工具 | 说明 |
| --- | --- |
| `verify-ui.mjs` | 离线构造真实组件并渲染：设置界面标签/值列对齐/英文说明保留/中文说明追加、`/theme`、`/thinking`、`/images`、认证屏、`/hotkeys` 表格与普通 Markdown 不受影响、状态行与通知模板、`Error:`/`Warning:` 前缀、启动头部按键提示、资源分节标题、超宽检查、重复安装幂等、编辑器容器兜底（容器外不翻译）、词典无空键、`descriptions` 与 `texts` 不重叠、模板可编译且锚定、词典漂移。**当前 82 项断言全部通过（0 警告）**。 |
| `coverage.mjs` | 扫 `dist/modes/interactive/**` 的字符串字面量，对照全部词典段输出覆盖率与未覆盖清单（支持 `--show N`、`--file`、`--root`、`--dict`）。当前 Pi 1.3.0：302 条候选、覆盖 236 条（78.1%），余项集中在聊天记录/工具输出/专有名词。 |
| `audit-ui.mjs` | 解析 `theme.fg`/`bold`、`showStatus/showError/showWarning/showInfo`、`keyHint`/`rawKeyHint`/`hint` 的实参（不是正则粗匹配），套用主题包装的判定后列出仍未覆盖项，并把「片段」与「完整文案」分开计数。当前 187 条字面量、覆盖 120 条；真正缺口只剩 2 条聊天记录/工具输出内容。 |
| `verify.mjs` / `check-upgrades.ps1` | 命令菜单部分：词典渲染验证、第三方包基线漂移检查（只读）。 |

## 排障

诊断日志在扩展目录下的 `ui-zh.log`（追加写入，约 800 行上限，`PI_UI_ZH_LOG=0` 关闭），关键前缀：

| 日志 | 含义 |
| --- | --- |
| `[source] …命中 n/25` | 各来源取到多少运行时类；`chunk 加载失败 …A dynamic import callback was not specified` 属正常（扩展侧原生 import 被 jiti 禁止，包入口已兜底） |
| `[patch] …` / `[FAIL]` | 装了哪些补丁；`[FAIL] 没有安装任何补丁` 说明一个都没装上 |
| `[chrome] …` | 编辑器容器兜底挂钩与命中 |
| `[render] <组件> 首次渲染 N 行` | 屏幕首次渲染的**原始英文**行（用于核对，不代表未译） |
| `[未译] "…"` | 翻译后仍是英文的候选行 ⇒ **补词典就看这里** |
| `[table-miss] …` | `/hotkeys` 表格里仍未命中的单元格 |
| `[dict] labels=… texts=…` | 本次加载的词典规模 |

| 症状 | 处理 |
| --- | --- |
| 界面全英文 | 先 `/reload`；仍不行看 `ui-zh.log` 是否有 `[FAIL]`/`[source]` 未命中，必要时完全重启 Pi |
| 大部分中文、个别屏没变 | 词典缺词：按 `[未译]` 行补 `texts`/`chromeTitles`/`statusPatterns`/`textPatterns` |
| 设置项标签中文但没有「中文：…」行 | 该条没进 `descriptions`（误放进 `texts` 会被就地替换） |
| 命令菜单没中文 | 该命令不在词典；或原说明已含中文（幂等跳过） |
| 与 Vim 等其他编辑器扩展冲突 | 两者都占用 `setEditorComponent`，后设置者生效（界面汉化不占编辑器） |

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `index.ts` | 扩展入口：装配命令菜单汉化 + 界面汉化，各自独立容错 |
| `ui-zh.ts` | 界面汉化引擎：定位运行时类、安装渲染装饰器、逐行/整段/表格翻译 |
| `ui-zh.json` | 界面词典（段落见上） |
| `translations.json` / `third-party.ts` | 命令菜单词典 |
| `upgrade-baseline.json` / `baseline-archive/` / `check-upgrades.ps1` | 第三方包审计基线与其漂移检查 |
| `verify.mjs` / `verify-ui.mjs` | 命令菜单与界面汉化的验证脚本 |
| `coverage.mjs` / `audit-ui.mjs` | 覆盖率盘点与主题通路审计 |

## 边界

- 只读取 Pi 安装目录，不写入其中任何文件；Pi 升级后重跑验证脚本即可发现需要适配的词典或补丁点。
- 词典或接口不兼容时通知并跳过汉化，不影响 Pi 运行。
- 命令菜单部分占用自定义编辑器位置；界面汉化部分不占用编辑器。
- 目录位于用户扩展目录（不在 `install/releases` 内），Pi 升级不会覆盖。

## 停用

- 只关界面汉化：启动 Pi 前设 `PI_UI_ZH=0`。
- 全部停用：把本目录移出 `~/.pi/agent/extensions/`，然后 `/reload` 或重启 Pi。
