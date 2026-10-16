# pi-zh —— Pi 中文说明（命令菜单 + 内置界面）

用户级扩展，给 Pi 补上**中文注释**，分两部分：

1. **命令菜单**：在斜杠命令补全列表中给命令说明加中文（显示为“中文 · 原说明”），通过公开的 `CustomEditor` / `setEditorComponent` / `AutocompleteProvider` 接口实现。
2. **内置界面**：设置、主题、模型、思考级别、图片、会话、会话树、登录、扩展选择器等 TUI 界面的标签、说明和提示行显示中文，通过给**运行中 Pi 自己使用的组件类**安装渲染装饰器实现。

两条功能都只做“加中文”，不改命令名、参数、配置键、取值和交互逻辑；不修改 Pi 安装文件，不调用网络或模型。

## 启用

在 Pi 中执行 `/reload`，然后输入 `/` 或打开 `/settings`；如果没有生效，重启 Pi。

| 开关 | 作用 |
| --- | --- |
| 默认 | 命令菜单 + 内置界面都汉化 |
| `PI_UI_ZH=0`（或 `off`） | 只关内置界面汉化，命令菜单仍生效 |
| `PI_UI_ZH_ROOT=<Pi 安装包目录>` | 手动指定 `@earendil-works/pi-coding-agent` 所在目录（自动探测失败时用） |

内置界面汉化失败只在通知栏提示“界面汉化未启用：…”，不会影响命令菜单和 Pi 本身。

## 汉化效果

设置界面（`/settings`）为“标签中文 + 英文原说明 + 中文说明”，值列位置不变：

```
→ 自动压缩                          true
  自动补全最多显示条目                8
  上下文过大时自动压缩
  中文：上下文过大时自动压缩
  输入即搜索 · 回车/空格 修改 · Esc 取消
```

单行说明（`/theme`、`/model`、`/thinking` 等列表的行内说明）显示为“英文 · 中文”；提示行、标题、空列表文案等整行文案直接显示中文。词典未收录的文案保持原样。

`/hotkeys` 这类“打印到聊天区”的界面输出也会汉化（表格按单元格等宽替换，边框不错位）：

```
键盘快捷键

┌───────┬──────────────────────┐
│ 按键  │ 操作                 │
├───────┼──────────────────────┤
│ ↑ / ↓ │ 移动光标 / 浏览历史  │
└───────┴──────────────────────┘
```

## 覆盖范围与实现原理

Pi 没有任何“界面翻译”扩展钩子，扩展加载器解析到的包与 Pi 实际运行的代码也不一定是同一份。本扩展的做法：

1. 扫描 Pi 安装目录 `dist/bundle/chunks/*.js` 的 `export {...}` 语句，建立“导出名 → chunk 文件”映射，并用 `import(file://…)` 动态导入（Node 的 ESM 缓存保证与 Pi 正在运行的 chunk 是同一个模块实例）；
2. 同时用普通 `import("@earendil-works/pi-coding-agent")` / `import("@earendil-works/pi-tui")` 取包入口导出的类（jiti 会把它解析为 Pi 内联的那份）；
3. **两条来源都收集，并且对每个“不同对象”的副本分别打补丁**，因此无论渲染走哪一份都会生效；
4. 在这些类上安装 `render` 装饰器：先取原始行，再按词典后处理（保持 ANSI、保持可视宽度、异常时原样回退），最后交回原渲染流程；
5. 对**没有导出**、无法按类名定位的屏幕（`/trust`、`/config` 等），挂钩 `Container.addChild`：凡是加入了编辑器（`Editor`）的容器就记为“编辑器容器”，之后加入其中的屏幕组件（即 Pi 的 `showSelector` 挂载的所有对话框）自动获得同一套整行汉化；聊天记录（`ScrollView`）与输入框不在其中；
6. 对**打印到聊天区**的界面输出（`/hotkeys`）：只在 Markdown 内容里出现 `│ Key │ Action │` 画框表格时才按单元格翻译（单元格总宽不变，边框因此不会错位），普通 Markdown——也就是模型回复——绝不触碰；该屏的标题 “Keyboard Shortcuts” 通过包装全局 `theme.fg`/`bold`（按原文精确匹配 `chromeTitles`）汉化；
7. 包装全局 `theme.fg`/`bold`：按原文整串精确匹配 `chromeTitles`、`statusTexts`/`statusPatterns`（仅 `dim`/`muted` 角色，即聊天区状态行）或 `textPatterns`（与角色无关的锤定模板），命中才替换、保留首尾空白；`showError`/`showWarning` 的 `Error: …` / `Warning: …` 前缀保留、正文再查词典，未收录的正文保持英文。

因此只读取 Pi 安装目录，不修改其中任何文件；Pi 升级后词典或补丁点可能需要适配（用下面的验证脚本检查）。

已覆盖的渲染路径：

| 渲染路径 | 覆盖的界面 |
| --- | --- |
| `SettingsList.render` / `addHintLine` | `/settings` 主列表、两个二级菜单 |
| `SelectList.renderItem` / `render` | `/theme`、`/thinking`、`/images`、设置二级菜单 |
| 11 个界面组件类 | `/settings`、`/theme`、`/images`、`/thinking`、`/model`、`/sessions`、`/tree`、`/login`、OAuth、扩展选择器、用户消息选择器 |
| 编辑器容器兜底（`Container.addChild` → 子组件 `render`） | 未导出的屏幕：`/trust`、`/config`、scoped models、首次运行引导、bug 报告、会话分享等；只对词典命中的整行生效 |
| `Markdown.render`（仅含 `Key`/`Action` 画框表格时）+ 全局 `theme.fg`/`bold` 标题 | `/hotkeys` 的命令速查表与 “Keyboard Shortcuts” 标题 |

覆盖判定以**词典命中**为准，因此“已覆盖”不等于“全部中文”：Pi 的模板拼接文案（`keyText` 组合的按键提示、`${变量}` 插值句）需要写进 `patterns` 才能翻译。聊天记录、消息内容、工具输出、模型回复**不在**翻译范围内。

关键词条可以同时出现在 `labels` 与 `texts` 中：`labels` 用于列表行的标签列，遇到独立标题行（如“Project trust”）时会自动回退到 `labels` 查找。

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `index.ts` | 扩展入口：装配命令菜单汉化 + 界面汉化（各自独立容错） |
| `ui-zh.ts` | 界面汉化引擎：探测安装目录、定位 chunk、安装渲染装饰器、逐行翻译 |
| `ui-zh.json` | 界面词典：`labels` / `descriptions` / `texts` / `patterns` / `values` / `paragraphs` / `paragraphPatterns` / `chromeTitles` / `statusTexts` / `statusPatterns` / `textPatterns` / `extensionTexts` / `inline` |
| `translations.json` | 命令菜单用户词典（键为不带 `/` 的命令名），优先于第三方词典 |
| `third-party.ts` | 第三方 npm 包命令词典（含别名、条件命令、提示模板） |
| `upgrade-baseline.json`、`baseline-archive/` | 第三方包审计基线（命令菜单部分） |
| `check-upgrades.ps1` | 第三方包基线漂移检查（只读） |
| `verify.mjs` | 命令菜单验证脚本 |
| `verify-ui.mjs` | 界面汉化验证脚本（离线真实渲染） |
| `coverage.mjs` | 覆盖率盘点：扫 Pi 安装目录的界面字面量，按词典段统计已覆盖/未覆盖 |
| `audit-ui.mjs` | 主题通路审计：解析 `theme.fg/bold`、`showStatus/showError/showWarning/showInfo` 的实参并套用包装判定，列出仍未覆盖的条目 |

## 词典维护

### 命令菜单

编辑 `translations.json`，键为不带 `/` 的完整命令名，值为中文说明，保存后 `/reload`。未收录命令保留原说明。技能命令统一增加“加载技能”，原技能说明保留。Pi 自带内置命令与内置扩展命令（如 `/llama`、`/mcp`）也在此文件维护，不写入 `third-party.ts`。

### 内置界面

编辑 `ui-zh.json` 对应段落：

| 段落 | 用途 |
| --- | --- |
| `labels` | 设置项等**行标签**与独立标题行（按文本精确匹配，带 `✓` 的行会自动去标记后匹配） |
| `descriptions` | 选项说明，单独成段；选中项说明会追加“中文：…”行 |
| `texts` | 整行文案（标题、提示行、空列表文案）；**不要**把选项说明放这里，否则会被就地替换成中文而没有英文原文 |
| `patterns` | 带变量的整行文案，`["正则（字符串）", "中文模板（$1 引用捕获）"]` |
| `values` | 值列取值（`true`→`开`、`sse`→`SSE` 等） |
| `chromeTitles` | 打印到聊天区的界面标题（如 `Keyboard Shortcuts`），按原文精确匹配，仅用于全局主题包装 |
| `statusTexts` / `statusPatterns` | 聊天区状态行（如 `/reload` 后的 `Reloaded keybindings…`、`Model: …`）：它们经 `theme.fg("dim", message)` 渲染，只在该角色下按整串（`statusPatterns` 必须锚定）匹配替换，不影响其它着色文本与模型回复 |
| `chromeTitles` | 任何经 `theme.fg(role, …)` / `theme.bold(…)` 渲染、长度 ≤ 80 的界面串（面板标题、空态、字段名、通知与提示，如 `Session Info`、`No matching models`、`Compaction cancelled`）：按去空格后的整串精确匹配，与颜色角色无关 |
| `textPatterns` | 与颜色角色无关的模板类界面串（全屏指示条 `↓ Jump to latest message`、`Loading …`、`Failed to load theme "…": …` 等）：锚定正则，整串命中才替换，两侧空白原样保留 |
| `extensionTexts` | 第三方扩展注册的文案（`/hotkeys` 的“扩展”小节，如 `Toggle web search activity`）。这些字串不在 Pi 源码里，因此单独成段、**不做漂移检查**；换机器或换扩展时按需增删 |
| `paragraphs` | **多行段落**（会被终端按宽度折行的说明文字，如 `/bug` 的隐私声明）。引擎把连续非空行按空格拼回整段再查表，命中后按原缩进与宽度重新折行——因此换终端宽度也能命中 |
| `paragraphPatterns` | 含动态内容的多行段落：`[正则, 替换文本]`，在拼回整段后再匹配，`$1` 等可用（如“上传到 <主机>；导出则…”） |
| `inline` | 单行说明格式：`en+zh`“英文 · 中文”（默认）、`zh`“只中文”、`zh+en`“中文 · 英文” |

`verify-ui.mjs` 会检查词典键是否仍存在于 Pi 源码中（漂移检查）；Pi 升级后重跑即可发现需要更新的条目。

## 验证

两个脚本都是手动测试，不随 Pi 自动加载。需要 Node 22+（本机 v24 可直接运行 `.ts`）。

```powershell
# 命令菜单：传入 Pi 安装目录下的 node_modules
node "$HOME\.pi\agent\extensions\pi-zh\verify.mjs" "$HOME\.pi\agent\install\releases\<版本>\node_modules"

# 内置界面：离线构造真实组件并渲染，逐条断言；--strict 把警告当失败
node "$HOME\.pi\agent\extensions\pi-zh\verify-ui.mjs" --strict

# 覆盖率盘点：把 Pi 安装里的界面字面量逐个与词典对照，列出还没覆盖的文案
node "$HOME\.pi\agent\extensions\pi-zh\coverage.mjs" --show 12
```

`verify-ui.mjs` 覆盖：设置界面标签/值列对齐/英文说明保留/中文说明追加/提示行、`/theme`、`/thinking`、`/images`、认证屏幕的关键文案、`/hotkeys` 画框表格（表头/动作/小节/第三方扩展说明/边框对齐）与普通 Markdown 不受影响、聊天区标题、状态行（`/reload` 提示与覆盖框、`Model: …`、`Session compacted … times`、`Only one model in scope` 等，仅 `dim`/`muted` 角色且整串/锚定模板命中）、全屏指示条（`↓ Jump to latest message`，保留快捷键与两侧 padding）、面板/空态/通知类文案（`Session Info`、`No matching models`、`Compaction cancelled`、主题加载失败提示等）、错误/警告提示（`Error: …` / `Warning: …` 前缀保留、正文查词典，未收录正文不被改写）、缓存未命中与思考块丢弃通知、启动帮助提示行、词典未收录的状态文本与非目标角色的同样文本不被改写、输出不超宽、重复安装幂等、编辑器容器兜底生效且容器外不翻译、词典无空键、`descriptions` 与 `texts` 不重叠、patterns/paragraphPatterns/statusPatterns/textPatterns 可编译（后两者还必须锚定）、词典漂移检查。当前结果：77 通过 / 0 警告 / 0 失败。

### 同类型文案的排查方法

界面文案遍布 `dist/modes/interactive/**` 与 `dist/core/**`。判断“某种通路里的英文是否都翻到了”，先按渲染通路枚举字面量，再对词典四段（`chromeTitles` / `statusTexts` / `statusPatterns` / `textPatterns`）做覆盖比对：

| 通路 | 排查方式 |
| --- | --- |
| `theme.fg(role, "…")` / `theme.bold("…")` | 仓库内 `node audit-ui.mjs`：解析调用实参（而非正则贪婪匹配），逐个字面量套用主题包装的判定逻辑，列出仍未覆盖的条目 |
| `showStatus("…")` | 状态行经 `theme.fg("dim"/"muted", …)` 渲染，比对 `statusTexts` / `statusPatterns`（`audit-ui.mjs` 已含） |
| `showError/showWarning("…")` | 实际文本是 `Error: …` / `Warning: …`，前缀由包装补齐，正文比对 `texts` / `chromeTitles` / 各 patterns（`audit-ui.mjs` 已含） |
| 列表行/对话框/面板 | `node coverage.mjs`：扫 `dist/modes/interactive/**` 的字符串字面量并比对全部词典段 |

注意：源码里常常写成 `\u00b7`、`\u2022`、`\u2713` 这类转义与 `\n` 换行，比对时要把两边都还原成运行时字符串，否则会把已译条目误判成缺口。

当前盘点结果（Pi 1.3.0）：主题通路字面量 140 条，已覆盖 98 条、片段 29 条（被拼进整行，由整行模板/列表行处理）、完整文案 13 条（其中 11 条标记为“已在别处”，即由 `labels`/`texts`/列表行翻译；剩下 2 条为聊天记录/工具输出的内容，属设计不翻）；`coverage.mjs` 的广义候选覆盖率为 236/302 = 78.1%，未覆盖项同样集中在聊天记录、工具输出与专有名词。

运行中的诊断日志写在扩展目录下的 `ui-zh.log`（记录补丁命中的类、屏幕首次渲染的原文行、未译行清单、`/hotkeys` 表格里仍未译的行；`PI_UI_ZH_LOG=0` 可关闭）。补词典时先看其中的 `[未译]` 行最省事。

`coverage.mjs` 给出量化进度（当前：interactive 模式界面字面量 302 条，覆盖 225 条 = 74.5%；剩余项多为聊天记录/工具输出/专有名词）。剩下的未覆盖项分三类：

| 类别 | 举例 | 为何未覆盖 |
| --- | --- | --- |
| 聊天记录/消息/工具输出 | `AssistantMessageComponent`、`BranchSummaryMessage`、`diff`、`mermaid` | 属设计不翻译（只翻译界面外壳），翻译会污染模型输出 |
| 通知/toast 与聊天区面板 | `[Skill conflicts]`、`Clipboard file path contains control characters`、已加载资源面板 | 渲染在聊天区而非编辑器容器，需新增补丁点（会让 `CODE_VERSION` 递增、需完整重启 Pi） |
| 源码里的代码片段/专有名词 | `loop: true`、模型名、主题名、路径、时间戳 | 不是给人看的界面文案，或属专有名词 |

界面汉化沿用命令菜单的一贯约束：**只显示、不改行为**。真实终端视觉效果建议在交互会话里确认一次。

## 安装与复用

扩展是纯源码目录，无需构建，直接放入用户扩展目录即可。

```powershell
# 本机已启用：目录就在 Pi 用户扩展目录下
# C:\Users\<用户名>\.pi\agent\extensions\pi-zh

# 复用到其他机器：克隆到用户扩展目录
cd "$HOME\.pi\agent\extensions"
git clone https://github.com/Mehael-Yeh/pi-zh.git pi-zh
# 然后在 Pi 中执行 /reload
```

依赖来自 Pi 自身安装（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`），不要在扩展目录执行 `npm install`。

## 持久化与边界

目录位于用户扩展目录，不在 `install/releases` 内，Pi 升级不会覆盖。未来公开接口或内部结构发生不兼容变化时可能需要适配；接口缺失或词典损坏会通知并跳过汉化，不影响 Pi 本身。

命令菜单部分占用自定义编辑器位置，不能保证与 Vim 编辑器等其他 `setEditorComponent` 扩展同时生效（通常后设置的编辑器覆盖前者）；界面汉化部分不占用编辑器。遇到冲突，应将补全包装逻辑整合到已有编辑器扩展。

不翻译聊天记录、消息、工具说明和模型回复——只翻译界面“外壳”文案（`/hotkeys` 这类由命令打印的速查表属于界面输出，按画框表格签名识别后翻译）。不会自动翻译新安装扩展的任意说明。

**已打印到终端的内容不会被追溯汉化**：常规模式下旧输出留在终端回滚缓冲区里，改完词典后必须重新执行命令（如再按一次 `/hotkeys`、再开一次 `/settings`）才能看到新的译文；只有选择器/对话框这类会重绘的界面会当场生效。

## 停用

- 只停界面汉化：启动 Pi 前设置 `PI_UI_ZH=0`。
- 全部停用：将本目录移出 `~/.pi/agent/extensions/`，然后 `/reload` 或重启 Pi。
