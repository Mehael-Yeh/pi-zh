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

## 覆盖范围与实现原理

Pi 没有任何“界面翻译”扩展钩子，扩展加载器解析到的包与 Pi 实际运行的代码也不是同一份。本扩展的做法：

1. 扫描 Pi 安装目录 `dist/bundle/chunks/*.js` 的 `export {...}` 语句，建立“导出名 → chunk 文件”映射；
2. 用 `import(file://…)` 动态导入该 chunk——Node 的 ESM 缓存保证得到与 Pi 正在运行的**同一个模块实例**，因此同一个类对象；
3. 在这些类上安装 `render` 装饰器：先取原始行，再按词典后处理（保持 ANSI、保持可视宽度、异常时原样回退），最后交回原渲染流程。

因此只读取 Pi 安装目录，不修改其中任何文件；Pi 升级后词典或补丁点可能需要适配（用下面的验证脚本检查）。

已覆盖的渲染路径：

| 渲染路径 | 覆盖的界面 |
| --- | --- |
| `SettingsList.render` / `addHintLine` | `/settings` 主列表、两个二级菜单 |
| `SelectList.renderItem` / `render` | `/theme`、`/thinking`、`/images`、设置二级菜单 |
| 11 个界面组件类 | `/settings`、`/theme`、`/images`、`/thinking`、`/model`、`/sessions`、`/tree`、`/login`、OAuth、扩展选择器、用户消息选择器 |

**已知未覆盖**：Pi 没有导出、也无法按类名定位的组件（`/config`、`/trust`、scoped models、首次运行引导、bug 报告、会话分享、页脚、状态指示器等）以及自绘列表（`/sessions`、`/tree` 的行内说明）。这些界面里的文案若恰好是整行文案，仍可能被翻译；其余保持英文。聊天记录、消息内容、工具输出、模型回复**不在**翻译范围内。

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `index.ts` | 扩展入口：装配命令菜单汉化 + 界面汉化（各自独立容错） |
| `ui-zh.ts` | 界面汉化引擎：探测安装目录、定位 chunk、安装渲染装饰器、逐行翻译 |
| `ui-zh.json` | 界面词典：`labels` / `descriptions` / `texts` / `patterns` / `values` / `inline` |
| `translations.json` | 命令菜单用户词典（键为不带 `/` 的命令名），优先于第三方词典 |
| `third-party.ts` | 第三方 npm 包命令词典（含别名、条件命令、提示模板） |
| `upgrade-baseline.json`、`baseline-archive/` | 第三方包审计基线（命令菜单部分） |
| `check-upgrades.ps1` | 第三方包基线漂移检查（只读） |
| `verify.mjs` | 命令菜单验证脚本 |
| `verify-ui.mjs` | 界面汉化验证脚本（离线真实渲染） |

## 词典维护

### 命令菜单

编辑 `translations.json`，键为不带 `/` 的完整命令名，值为中文说明，保存后 `/reload`。未收录命令保留原说明。技能命令统一增加“加载技能”，原技能说明保留。Pi 自带内置命令与内置扩展命令（如 `/llama`、`/mcp`）也在此文件维护，不写入 `third-party.ts`。

### 内置界面

编辑 `ui-zh.json` 对应段落：

| 段落 | 用途 |
| --- | --- |
| `labels` | 设置项等**行标签**（按标签文本精确匹配，带 `✓` 的行会自动去标记后匹配） |
| `descriptions` | 选项说明，单独成段；选中项说明会追加“中文：…”行 |
| `texts` | 整行文案（标题、提示行、空列表文案）；**不要**把选项说明放这里，否则会被就地替换成中文而没有英文原文 |
| `patterns` | 带变量的整行文案，`["正则（字符串）", "中文模板（$1 引用捕获）"]` |
| `values` | 值列取值（`true`→`开`、`sse`→`SSE` 等） |
| `inline` | 单行说明格式：`en+zh`“英文 · 中文”（默认）、`zh`“只中文”、`zh+en`“中文 · 英文” |

`verify-ui.mjs` 会检查词典键是否仍存在于 Pi 源码中（漂移检查）；Pi 升级后重跑即可发现需要更新的条目。

## 验证

两个脚本都是手动测试，不随 Pi 自动加载。需要 Node 22+（本机 v24 可直接运行 `.ts`）。

```powershell
# 命令菜单：传入 Pi 安装目录下的 node_modules
node "$HOME\.pi\agent\extensions\pi-zh\verify.mjs" "$HOME\.pi\agent\install\releases\<版本>\node_modules"

# 内置界面：离线构造真实组件并渲染，逐条断言；--strict 把警告当失败
node "$HOME\.pi\agent\extensions\pi-zh\verify-ui.mjs" --strict
```

`verify-ui.mjs` 覆盖：设置界面标签/值列对齐/英文说明保留/中文说明追加/提示行、`/theme`、`/thinking`、`/images` 的关键文案、输出不超宽、重复安装幂等、词典无空键、`descriptions` 与 `texts` 不重叠、词典漂移检查。当前结果：22 通过 / 1 警告 / 0 失败（警告是 Pi 用变量拼接的两条提示行，属已知情况）。

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

不翻译聊天记录、消息、工具说明和模型回复——只翻译界面“外壳”文案。不会自动翻译新安装扩展的任意说明。

## 停用

- 只停界面汉化：启动 Pi 前设置 `PI_UI_ZH=0`。
- 全部停用：将本目录移出 `~/.pi/agent/extensions/`，然后 `/reload` 或重启 Pi。
