/**
 * 离线校验「界面汉化」（verify-ui.mjs）。
 *
 * 做三件事，全部离线、不启动 TUI：
 *   1. 用**运行时真正的 chunk 类**渲染若干界面，对比安装汉化前后的输出；
 *   2. 断言风格 A 的关键性质：标签中文化、值列位置不变、英文说明行保留、追加「中文：…」行、
 *      提示行中文化、所有行不超出终端宽度、可重复安装（幂等）；
 *   3. 词典漂移检查：词典里的每个英文键都必须仍能在 Pi 安装目录的源码里找到
 *      （Pi 升级改了文案时立刻报警）。加 --strict 时漂移即失败。
 *
 * 用法：node verify-ui.mjs [--strict] [--width 100]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");
const WIDTH = Number(argv[argv.indexOf("--width") + 1]) || 100;

const failures = [];
const warnings = [];
const pass = [];
const check = (ok, label, detail = "") => {
  if (ok) pass.push(label);
  else failures.push(detail ? `${label} —— ${detail}` : label);
};
const warn = (label, detail = "") => warnings.push(detail ? `${label} —— ${detail}` : label);

const strip = (s) => s.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*\x07|[PX^_][^\x1b]*\x1b\\)/g, "");
const ROW_RE = /^([\s>→·]*)(\S(?:.*?\S)?)(\s{2,})(\S.*)$/;
const noop = () => { };

/** 界面汉化模块（node 24 可直接导入 .ts） */
const ui = await import(pathToFileURL(path.join(HERE, "..", "lib", "ui-zh.ts")).href);
const dict = ui.loadDictionary(new URL("../dict/ui.json", import.meta.url));
const piRoot = ui.resolvePiRoot();
if (!piRoot) {
  console.error("✗ 找不到正在运行的 pi 安装目录（dist/bundle/chunks）");
  process.exit(1);
}
console.log(`pi 安装目录：${piRoot}`);

const WANTED = [
  "initTheme", "visibleWidth", "SettingsList", "SelectList", "Container",
  "SettingsSelectorComponent", "ThemeSelectorComponent", "ThinkingSelectorComponent",
  "ShowImagesSelectorComponent", "LoginDialogComponent", "ModelSelectorComponent",
  "SessionSelectorComponent", "TreeSelectorComponent", "OAuthSelectorComponent",
  "ExtensionSelectorComponent", "UserMessageSelectorComponent", "Editor", "Text",
  "Markdown", "getMarkdownTheme", "theme",
];
const { names, missing } = await ui.loadNames(piRoot, WANTED, () => { });
check(missing.length === 0, "运行时类全部可用", `缺失：${missing.join(", ")}`);
const vw = names.visibleWidth ?? ((s) => s.length);
names.initTheme();

/* ------------------------------------------------------------ 渲染被测界面 ---- */

const cfg = {
  autoCompact: true, defaultModel: "daybreak/gpt-5.1", currentModel: "daybreak/gpt-5.1",
  availableDefaultModels: [], showImages: true, imageWidthCells: 80, autoResizeImages: true,
  blockImages: false, enableSkillCommands: true, steeringMode: "one-at-a-time", followUpMode: "all",
  transport: "auto", httpIdleTimeoutMs: 300000, cacheWarmingMode: "off", thinkingLevel: "medium",
  availableThinkingLevels: ["off", "low", "medium", "high"],
  modelThinkingLevels: { "daybreak/gpt-5.1": "high" },
  currentTheme: "default", terminalTheme: "dark", availableThemes: [{ name: "default", light: false, dark: true }],
  hideThinkingBlock: false, mermaidRenderingMode: "auto", collapseChangelog: true, enableInstallTelemetry: true,
  doubleEscapeAction: "none", treeFilterMode: "default", showHardwareCursor: false, showCacheMissNotices: true,
  defaultProjectTrust: "ask", editorPaddingX: 1, outputPad: 1, autocompleteMaxVisible: 8, quietStartup: false,
  clearOnShrink: true, showTerminalProgress: false, tuiMode: "regular", fullscreenExitOutput: "transcript",
  fullscreenScrollbar: "auto", fullscreenCopyOnSelect: true, fullscreenWheelScrollLines: "auto",
  warnings: { anthropicExtraUsage: true },
};
const callbacks = new Proxy({}, { get: () => noop });

const EXT_ACTION = "Toggle web search activity";
const HOTKEYS_MD = [
  "**Navigation**",
  "| Key | Action |",
  "|-----|--------|",
  "| `↑` / `↓` | Move cursor / browse history |",
  "| `←` / `→` | Move by word |",
  "",
  "**Extensions**",
  "| Key | Action |",
  "|-----|--------|",
  "| `Ctrl+Shift+W` | " + EXT_ACTION + " |",
].join("\n");
const PLAIN_MD = [
  "**Navigation**",
  "",
  "- Move cursor / browse history",
  "- Move by word",
].join("\n");
const renderMarkdown = (text) => new names.Markdown(text, 0, 0, names.getMarkdownTheme()).render(WIDTH);

const screens = {
  settings: () => new names.SettingsSelectorComponent(cfg, callbacks).render(WIDTH),
  theme: () => new names.ThemeSelectorComponent("dark", noop, noop, noop).render(WIDTH),
  thinking: () => new names.ThinkingSelectorComponent("medium", ["off", "low", "medium", "high"], noop, noop, noop, "medium").render(WIDTH),
  images: () => new names.ShowImagesSelectorComponent(true, noop, noop).render(WIDTH),
  auth: () => new names.ExtensionSelectorComponent(
    "Select authentication method:",
    ["Sign in with an account", "Sign in with an API key"],
    noop, noop,
  ).render(WIDTH),
  hotkeys: () => renderMarkdown(HOTKEYS_MD),
  plainMarkdown: () => renderMarkdown(PLAIN_MD),
};
const renderAll = () => Object.fromEntries(Object.entries(screens).map(([k, f]) => [k, f().map(strip)]));

const before = renderAll();

/* ---------------------------------------------------------------- 安装汉化 ---- */

const install = await ui.installUiZh({ piRoot, dictionary: dict, log: (m) => console.log(`  [安装] ${m}`) });
console.log(`  补丁：${install.patched.join(", ")}`);
check(install.missing.length === 0, "汉化目标类全部命中", `未命中：${install.missing.join(", ")}`);

const after = renderAll();
const dump = (label, lines) => {
  console.log(`\n----- ${label}（${lines.length} 行，宽 ${WIDTH}） -----`);
  lines.forEach((line, i) => console.log(String(i).padStart(3), JSON.stringify(line)));
};
dump("设置界面（汉化后）", after.settings);
for (const key of ["theme", "thinking", "images", "auth"]) dump(`${key}（汉化后）`, after[key]);

/* ---------------------------------------------------------------- 断言检查 ---- */

const rows = (lines) => lines.map((line) => {
  const m = ROW_RE.exec(line);
  return m ? { label: m[2], value: m[4], col: vw(m[1] + m[2] + m[3]) } : null;
}).filter(Boolean);

// 1) 标签中文化
const zhLabel = /[\u4e00-\u9fff]/;
const settingsRows = rows(after.settings);
const hasZh = (lines) => lines.some((line) => ZhLabelTest(line));
const ZhLabelTest = (line) => /[\u4e00-\u9fff]/.test(line);
const zhRows = settingsRows.filter((r) => zhLabel.test(r.label));
check(zhRows.length >= 8, "设置界面标签中文化", `仅 ${zhRows.length} 行含中文标签`);
check(after.settings.some((l) => l.includes("自动压缩")), "设置界面出现“自动压缩”");

// 2) 值列位置不变（逐行对比首个同值行）
const beforeCols = new Map();
for (const r of rows(before.settings)) if (!beforeCols.has(r.value)) beforeCols.set(r.value, r.col);
const colDrift = settingsRows.filter((r) => beforeCols.has(r.value) && beforeCols.get(r.value) !== r.col);
check(colDrift.length === 0, "设置界面值列位置不变",
  colDrift.map((r) => `${r.label} → 值 ${r.value} 列 ${r.col}（原 ${beforeCols.get(r.value)}）`).join("；"));

// 3) 英文说明行保留（不再被就地替换）
const EN_DESC = "  Automatically compact context when it gets too large";
check(after.settings.includes(EN_DESC), "英文说明行保留", "未找到原始英文说明行");

// 4) 追加“中文：…”行
check(after.settings.some((l) => l.trim() === "中文：上下文过大时自动压缩"), "说明追加中文行");

// 5) 提示行中文化
check(after.settings.some((l) => l.trim() === "输入即搜索 · 回车/空格 修改 · Esc 取消"), "设置提示行中文化");

// 6) 宽度安全
for (const [key, lines] of Object.entries(after)) {
  const over = lines.filter((l) => vw(l) > WIDTH);
  check(over.length === 0, `${key} 输出不超宽`, over.map((l) => `${vw(l)} 列：${l}`).join("；"));
}

// 7) /theme
check(after.theme.some((l) => l.includes("（当前）")), "/theme 的“(current)”已中文化");
// 8) /thinking
check(after.thinking.some((l) => l.includes("思考级别")), "/thinking 标题已中文化");
check(after.thinking.some((l) => /中文|不推理|推理/.test(l)), "/thinking 说明或标签已中文化");
// 9) /images
check(after.images.some((l) => /[是否]/.test(l)), "/images 的 Yes/No 已中文化");
check(after.images.some((l) => l.includes("在终端内嵌渲染图片") || l.includes("改为显示文本占位符")), "/images 说明已中文化");

// 10) 幂等（同一版本重复安装直接返回缓存）
const install2 = await ui.installUiZh({ piRoot, dictionary: dict, log: () => { } });
check(install2.patched.length === install.patched.length, "同版本重复安装返回缓存（补丁数一致）",
  `${install.patched.length} → ${install2.patched.length}`);
check(JSON.stringify(renderAll()) === JSON.stringify(after), "重复安装后渲染结果不变");

// 10b) 模拟 /reload：清掉安装缓存后重跑 —— 包裹应被替换成新实现，不重复套娃、输出不变
Reflect.deleteProperty(globalThis, Symbol.for("pi.uiZh.installed"));
const install3 = await ui.installUiZh({ piRoot, dictionary: dict, log: () => { } });
check(install3.patched.length === 0, "清缓存后重装不重复套娃（包裹只被替换）",
  `patched=${install3.patched.length}`);
check(install3.already > 0, "重装时把“换新逻辑”的补丁计入 already（避免误报未生效）",
  `already=${install3.already}`);
check(JSON.stringify(renderAll()) === JSON.stringify(after), "替换包裹后渲染结果不变");

/* ------------------------------------------------ 兜底（编辑器容器）机制 ---- */
// TrustSelectorComponent / ConfigSelectorComponent 等类不导出，无法直接 new；
// 这里模拟 app 的 showSelector 流程：编辑器容器持有 Editor，其子节点才走兜底汉化。
const chromeProbe = (() => {
  try {
    const editor = Object.create(names.Editor.prototype);
    const editorContainer = new names.Container();
    editorContainer.addChild(editor);
    const chromeChild = new names.Container();
    chromeChild.addChild(new names.Text("Project trust", 0, 0));
    chromeChild.addChild(new names.Text("Current session: untrusted", 0, 0));
    editorContainer.addChild(chromeChild);
    const control = new names.Container();
    control.addChild(new names.Text("Project trust", 0, 0));
    return { marked: chromeChild.render(WIDTH).map(strip), control: control.render(WIDTH).map(strip) };
  } catch (error) {
    return { error: String(error) };
  }
})();
if (chromeProbe.error) {
  check(false, "兜底机制可运行", chromeProbe.error);
} else {
  check(hasZh(chromeProbe.marked), "编辑器容器内的屏幕走兜底汉化", chromeProbe.marked.filter((l) => l.trim()).join("；"));
  check(chromeProbe.marked.some((l) => l.includes("项目信任")), "标题类整行也能汉化（labels 兼作整行词典）", chromeProbe.marked.filter((l) => l.trim()).join("；"));
  check(chromeProbe.marked.some((l) => l.includes("当前会话")), "模板行（Current session: …）已汉化", chromeProbe.marked.filter((l) => l.trim()).join("；"));
  check(!hasZh(chromeProbe.control), "编辑器容器之外不翻译（聊天记录/输入框）", chromeProbe.control.filter((l) => l.trim()).join("；"));
}

check(hasZh(after.auth), "认证方式选择已中文化", after.auth.filter((l) => l.trim()).join("；"));

/* ------------------------------- 多行段落（/bug 隐私声明这类按宽度折行的说明） ---- */
// 说明文字会被终端按宽度折行，逐行匹配不可能命中，因此引擎把连续非空行拼回整段再查词典。
const BUG_DISCLAIMER =
  "This report goes to the Pi developers (Earendil) and is not shared publicly. It includes your pi version, " +
  "operating system, the current model and provider configuration (without API keys), loaded extensions, settings, " +
  "and provider error diagnostics from this session.";
const blockProbe = (() => {
  try {
    const editor = Object.create(names.Editor.prototype);
    const editorContainer = new names.Container();
    editorContainer.addChild(editor);
    const chromeChild = new names.Container();
    chromeChild.addChild(new names.Text(`${BUG_DISCLAIMER}\n\nWhat went wrong? (optional)`, 1, 0));
    chromeChild.addChild(new names.Text("Description: none\nTranscript: not included\nSummary: none", 1, 0));
    editorContainer.addChild(chromeChild);
    return { lines: chromeChild.render(WIDTH).map(strip) };
  } catch (error) {
    return { error: String(error) };
  }
})();
if (blockProbe.error) {
  check(false, "多行段落探针可运行", blockProbe.error);
} else {
  const joined = blockProbe.lines.join("\n");
  check(hasZh(blockProbe.lines), "多行段落（/bug 隐私声明）已中文化", blockProbe.lines.filter((l) => l.trim()).join("；"));
  check(!joined.includes("is not shared publicly"), "隐私声明英文原文已被整段替换", joined.includes("is not shared publicly") ? "仍含英文原文" : "ok");
  check(joined.includes("哪里出了错？"), "整行文案（What went wrong?）已中文化");
  check(joined.includes("说明：无") && joined.includes("会话记录：不包含"), "Description:/Transcript: 模板行已中文化");
}

/* ------------------------------------------- /hotkeys 画框表格（聊天区输出） ---- */
check(after.hotkeys.some((l) => l.includes("按键") && l.includes("操作")), "hotkeys 表头已中文化", after.hotkeys.join("；"));
check(after.hotkeys.some((l) => l.includes("切换网页搜索活动面板")), "hotkeys 扩展小节（第三方说明）已中文化", after.hotkeys.join("；"));
check(after.hotkeys.some((l) => l.includes("移动光标 / 浏览历史")), "hotkeys 动作说明已中文化");
check(after.hotkeys.some((l) => l.includes("按键") || l.includes("导航")), "hotkeys 小节/表头已中文化");
check(after.hotkeys.some((l) => l.trim() === "导航"), "hotkeys 小节标题已中文化");
check(after.hotkeys.some((l) => l.includes("↑ / ↓")), "hotkeys 键名列保持原文");
// 每张表格（连续边框行）内部宽度必须一致；多张表之间可以不同。
const groups = [];
let current = null;
for (const line of after.hotkeys) {
  if (/[│┌├└]/.test(line)) {
    (current ??= []).push(vw(line.trimEnd()));
  } else if (current) {
    groups.push(current);
    current = null;
  }
}
if (current) groups.push(current);
const badGroups = groups.filter((widths) => new Set(widths).size > 1);
check(
  groups.length > 0 && badGroups.length === 0,
  "hotkeys 表格边框未错位",
  badGroups.map((widths) => widths.join(", ")).join(" | "),
);
check(!hasZh(after.plainMarkdown), "普通 Markdown（模型回复）不被翻译", after.plainMarkdown.filter((l) => l.trim()).join("；"));
const titleText = strip(String(names.theme.fg("accent", "Keyboard Shortcuts")));
check(titleText.includes("键盘快捷键"), "聊天区标题（Keyboard Shortcuts）已中文化", titleText);

// 聊天区状态行（showStatus → theme.fg("dim", message)）
const reloadLine = strip(String(names.theme.fg(
  "dim",
  "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
)));
check(reloadLine.includes("已重新加载"), "状态行（/reload 提示）已中文化", reloadLine);
const trustLine = strip(String(names.theme.fg(
  "dim",
  "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust",
)));
check(trustLine.includes("并已保存项目信任"), "状态行（含 saved project trust 变体）已中文化", trustLine);
const modelStatus = strip(String(names.theme.fg("dim", "Model: claude-sonnet-4")));
check(modelStatus.includes("模型："), "状态行（动态 Model: …）已中文化", modelStatus);
const reloadBoxLine = strip(String(names.theme.fg(
  "muted",
  "Reloading keybindings, extensions, skills, prompts, themes, and context files...",
)));
check(reloadBoxLine.includes("正在重新加载"), "状态行（/reload 进行中的覆盖框）已中文化", reloadBoxLine);

// 全屏指示条（tui-renderer.js:16，role = text，带快捷键后缀与两侧 padding）
const jumpIndicator = strip(String(names.theme.fg("text", " ↓ Jump to latest message · ^⌘↓ ")));
check(jumpIndicator.includes("跳到最新消息") && jumpIndicator.includes("^⌘↓"), "全屏指示条（Jump to latest message）已中文化且保留快捷键", jumpIndicator);
check(jumpIndicator.startsWith(" ") && jumpIndicator.endsWith(" "), "全屏指示条两侧 padding 保留", JSON.stringify(jumpIndicator));
const plainYes = strip(String(names.theme.fg("text", "Yes")));
check(plainYes === "Yes", "text 角色下普通短词（Yes）不被改写", plainYes);

// 提示/空态/面板文案（chromeTitles + textPatterns，同样走 theme 通路）
const emptyState = strip(String(names.theme.fg("muted", "  No matching models")));
check(emptyState.includes("没有匹配的模型") && emptyState.startsWith("  "), "空态（No matching models）已中文化且保留缩进", JSON.stringify(emptyState));
const widgetTruncated = strip(String(names.theme.fg("muted", "... (widget truncated)")));
check(widgetTruncated.includes("挂件已截断"), "挂件截断提示已中文化", widgetTruncated);
const waitReload = strip(String(names.theme.fg("dim", "Wait for the current response to finish before reloading.")));
check(waitReload.includes("重新加载"), "等待类警告（Wait for the current response…）已中文化", waitReload);
const themeFail = strip(String(names.theme.fg("error", 'Failed to load theme "dark": bad color\nFell back to the system theme.')));
check(themeFail.includes("加载主题") && themeFail.includes("系统主题"), "主题加载失败提示（含换行模板）已中文化", JSON.stringify(themeFail));
const scopedOnly = strip(String(names.theme.fg("muted", "Session-only. ctrl+s to save to settings.")));
check(scopedOnly.includes("仅本次会话"), "模板类提示（Session-only. …）已中文化", scopedOnly);

// showError / showWarning：`Error: …` / `Warning: …` 前缀 + 正文分别处理
const errToast = strip(String(names.theme.fg("error", "Error: Uploading bug reports requires online mode. Use Export as Zip instead.")));
check(errToast.startsWith("错误：") && errToast.includes("上传问题报告"), "错误提示（Error: …）已中文化且保留前缀语义", errToast);
const warnToast = strip(String(names.theme.fg("warning", "Warning: Wait for the current response to finish before reloading.")));
check(warnToast.startsWith("警告：") && warnToast.includes("重新加载"), "警告提示（Warning: …）已中文化", warnToast);
const unknownToast = strip(String(names.theme.fg("error", "Error: something nobody translated")));
check(unknownToast === "Error: something nobody translated", "未收录的错误正文保持英文", unknownToast);
const textRoleToast = strip(String(names.theme.fg("text", "Error: Uploading bug reports requires online mode. Use Export as Zip instead.")));
check(textRoleToast.startsWith("Error: "), "非 error/warning 角色的同类文本不被改写", textRoleToast);

// 状态行/通知模板（批次 17-18，走 statusPatterns / textPatterns）
const cacheMiss = strip(String(names.theme.fg("warning", "Cache miss after model switch: 12.3k tokens re-billed (~$0.03)")));
check(cacheMiss.includes("切换模型后缓存未命中") && cacheMiss.includes("重新计费"), "缓存未命中通知（含模型切换变体）已中文化", cacheMiss);
const droppedThinking = strip(String(names.theme.fg("warning", "Anthropic dropped 3 thinking blocks (details in session)")));
check(droppedThinking.includes("丢弃了 3 个思考块"), "思考块丢弃通知已中文化", droppedThinking);
const compactedTimes = strip(String(names.theme.fg("dim", "Session compacted 2 times")));
check(compactedTimes.includes("会话已压缩 2 次"), "状态行（Session compacted … times）已中文化", compactedTimes);
const startupHelp = strip(String(names.theme.fg("dim", "Press ctrl+o to show full startup help and loaded resources.")));
check(startupHelp.includes("完整启动帮助") && startupHelp.includes("ctrl+o"), "启动帮助提示行已中文化且保留按键", startupHelp);
const onlyOneModel = strip(String(names.theme.fg("dim", "Only one model in scope")));
check(onlyOneModel.includes("只有一个模型"), "状态行（Only one model in scope）已中文化", onlyOneModel);

// 启动头部/展开视图：keyHint 说明（主题 muted 角色，带前导空格）与资源分节标题
const expandToolsHint = String(names.theme.fg("muted", " to expand tools"));
check(strip(expandToolsHint).includes("展开工具输出") && strip(expandToolsHint).startsWith(" "), "启动头部提示（to expand tools）已中文化且前导空格保留", JSON.stringify(strip(expandToolsHint)));
const cycleThinkingHint = strip(String(names.theme.fg("muted", " to cycle thinking level")));
check(cycleThinkingHint.includes("循环切换思考级别"), "启动头部提示（to cycle thinking level）已中文化", cycleThinkingHint);
const runBashHint = strip(String(names.theme.fg("muted", " to run bash (no context)")));
check(runBashHint.includes("不进入上下文"), "启动头部提示（to run bash (no context)）已中文化", runBashHint);
const skillsSection = strip(String(names.theme.fg("mdHeading", "[Skills]")));
check(skillsSection === "[技能]", "资源分节标题（[Skills]）已中文化", skillsSection);
const skillConflict = strip(String(names.theme.fg("warning", "[Skill conflicts]")));
check(skillConflict === "[技能冲突]", "冲突横幅（[Skill conflicts]）已中文化", skillConflict);
const untouchedStatus = "A sentence that is not in the dictionary at all";
check(
  strip(String(names.theme.fg("dim", untouchedStatus))) === untouchedStatus,
  "词典未收录的状态文本保持原样",
  strip(String(names.theme.fg("dim", untouchedStatus))),
);
check(
  strip(String(names.theme.fg("accent", "Model: claude-sonnet-4"))).includes("Model: claude-sonnet-4"),
  "非 dim 角色的同样文本不被改写",
  strip(String(names.theme.fg("accent", "Model: claude-sonnet-4"))),
);

/* ---------------------------------------------------- 屏幕样例文案自测 ---- */
// 取各屏幕源码里的代表性文案，走兜底（编辑器容器）通道渲染，确认词典确实覆盖。
const SAMPLE_LINES = [
  // /model
  "Refreshing model catalogs…",
  "Only showing models from configured providers. Use /login to add providers.",
  "Model refresh timed out; showing cached models.",
  "  No matching models",
  "  Model Name: gpt-5",
  "  enter to select · ctrl+s to set as default · esc to cancel",
  // /scoped-models
  "Model Configuration",
  "  Session-only. ctrl+s to save to settings.",
  "  12/34 enabled",
  // /login、OAuth
  "  Select provider to configure:",
  "  ✓ configured",
  "  • not configured",
  "  env: ANTHROPIC_API_KEY",
  "  No providers logged in. Use /login first.",
  "Login to Anthropic",
  "  Enter code: ABCD-1234",
  "  (esc to cancel)",
  "  (esc to cancel, enter to submit)",
  "Ctrl+click to open",
  "Login cancelled",
  // /trust
  "Project trust",
  "  Saved decision: none",
  "  Current session: untrusted",
  "  Ask (inherited from ~/.pi/agent/settings.json)",
  // /sessions
  "Resume Session (Current Folder)",
  "◉ Current Folder | ○ All   Name: default   Sort: recent",
  "  No sessions found",
  "  No named sessions found. Press tab to show all.",
  "  No sessions in current folder. Press Tab to view all.",
  "  Delete session? enter confirm · esc cancel",
  "  Failed to load sessions: boom",
  "  Session moved to trash",
  "Rename Session",
  "  12 messages",
  // /tree
  "Session Tree",
  "  Type to search: abc",
  "  [no-tools] hello",
  "  user: hello",
  "  assistant: hi",
  "  (aborted)",
  "  Label (empty to remove):",
  "  No entries found",
  // 用户消息选择器
  "Fork from Message",
  "Select a user message to copy the active path up to that point into a new session",
  "  Message 2 of 9",
  "  No user messages found",
  // 其它
  "Thinking Level",
  "  (auto)",
  "  thinking off",
  "  (all/scoped)",
  // 通知/对话框/会话流程（批次 17-18）
  "Session cwd not found",
  "Import session",
  "Failed to resume session",
  "Summarize branch?",
  "Custom summarization instructions",
  "Clipboard file path contains control characters",
];
const sampleProbe = (() => {
  try {
    const editor = Object.create(names.Editor.prototype);
    const editorContainer = new names.Container();
    editorContainer.addChild(editor);
    const screen = new names.Container();
    for (const line of SAMPLE_LINES) screen.addChild(new names.Text(line, 0, 0));
    editorContainer.addChild(screen);
    return { lines: screen.render(WIDTH).map(strip) };
  } catch (error) {
    return { error: String(error) };
  }
})();
if (sampleProbe.error) {
  check(false, "屏幕样例渲染可运行", sampleProbe.error);
} else {
  const untranslated = sampleProbe.lines.map((l) => l.trim()).filter((l) => l && !/[\u4e00-\u9fff]/.test(l));
  check(
    untranslated.length === 0,
    `屏幕样例文案全部汉化（${SAMPLE_LINES.length} 条）`,
    untranslated.slice(0, 12).map((l) => JSON.stringify(l)).join("；"),
  );
  if (process.argv.includes("--dump")) dump("屏幕样例（汉化后）", sampleProbe.lines);
}

/* ---------------------------------------------------- 词典自身一致性 / 漂移 ---- */

const sections = ["labels", "descriptions", "texts", "values", "chromeTitles", "statusTexts", "extensionTexts", "paragraphs"];
const empty = [];
for (const section of sections) {
  for (const [k, v] of Object.entries(dict[section] ?? {})) {
    if (!k.trim() || typeof v !== "string" || !v.trim()) empty.push(`${section}.${k}`);
  }
}
check(empty.length === 0, "词典没有空键/空值", empty.join("；"));

const overlap = Object.keys(dict.descriptions ?? {}).filter((k) => k in (dict.texts ?? {}));
check(overlap.length === 0, "descriptions 与 texts 不重叠（避免英文说明被就地替换）", overlap.join("；"));

// patterns 必须都能编译，且不能吃掉整行（只允许做局部替换）
const badPatterns = [];
for (const entry of dict.patterns ?? []) {
  const [source] = entry;
  try {
    new RegExp(source);
  } catch (error) {
    badPatterns.push(`${source} → ${error.message}`);
  }
}
check(badPatterns.length === 0, "patterns 正则均可编译", badPatterns.join("；"));

// statusPatterns = 只作用于 theme.fg("dim", …) 的状态行，必须可编译且锚定（防止误伤聊天内容）
const badStatusPatterns = [];
for (const entry of dict.statusPatterns ?? []) {
  const [source] = entry;
  try {
    new RegExp(source);
  } catch (error) {
    badStatusPatterns.push(`${source} → ${error.message}`);
    continue;
  }
  if (!(source.startsWith("^") && source.endsWith("$"))) badStatusPatterns.push(`${source}（未锚定）`);
}
check(badStatusPatterns.length === 0, "statusPatterns 正则均可编译且锚定", badStatusPatterns.join("；"));
const statusPatternFmt = (dict.statusPatterns ?? []).filter((e) => !Array.isArray(e) || e.length !== 2 || e.some((v) => typeof v !== "string"));
check(statusPatternFmt.length === 0, "statusPatterns 均为 [正则, 替换] 成对字符串", statusPatternFmt.length + " 条异常");

// textPatterns = 与角色无关的界面指示条（全屏按钮等），同样必须可编译且锚定
const badTextPatterns = [];
for (const entry of dict.textPatterns ?? []) {
  const [source] = entry;
  try {
    new RegExp(source);
  } catch (error) {
    badTextPatterns.push(`${source} → ${error.message}`);
    continue;
  }
  if (!(source.startsWith("^") && source.endsWith("$"))) badTextPatterns.push(`${source}（未锚定）`);
  if (!Array.isArray(entry) || entry.length !== 2 || entry.some((v) => typeof v !== "string")) badTextPatterns.push(`${source}（非成对字符串）`);
}
check(badTextPatterns.length === 0, "textPatterns 正则均可编译、锚定且成对", badTextPatterns.join("；"));

// paragraphPatterns = 多行段落用的正则（先拼接再匹配），同样必须可编译且成对
const badBlockPatterns = [];
for (const entry of dict.paragraphPatterns ?? []) {
  const [source, replacement] = entry;
  if (typeof source !== "string" || typeof replacement !== "string") {
    badBlockPatterns.push(`条目不是 [正则, 替换] 两元组：${JSON.stringify(entry)}`);
    continue;
  }
  try {
    new RegExp(source);
  } catch (error) {
    badBlockPatterns.push(`${source} → ${error.message}`);
  }
}
check(badBlockPatterns.length === 0, "paragraphPatterns 正则均可编译", badBlockPatterns.join("；"));
check(
  dict.paragraphs && Object.keys(dict.paragraphs).length > 0,
  "paragraphs 段存在（多行段落词典）",
  String(Object.keys(dict.paragraphs ?? {}).length),
);

// 漂移检查：英文键仍需存在于 Pi 源码（pi-coding-agent + 同目录的 pi-tui）
// piRoot = .../node_modules/@earendil-works/pi-coding-agent，因此 pi-tui 的兄弟包在
// pkgsRoot/@earendil-works/pi-tui/dist（注意 @earendil-works 这一层）。
const pkgsRoot = path.resolve(piRoot, "..", "..");
const SOURCE_DIRS = [
  path.join(piRoot, "dist/modes"),
  path.join(piRoot, "dist/core"),
  path.join(piRoot, "dist/bundle/chunks"),
  path.join(pkgsRoot, "@earendil-works", "pi-tui", "dist"),
  path.join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist"),
  path.join(piRoot, "node_modules", "pi-tui", "dist"),
];
const sources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (entry.endsWith(".js")) sources.push(readFileSync(full, "utf8"));
  }
};
for (const dir of SOURCE_DIRS) {
  try { walk(dir); } catch { /* 目录不存在则跳过 */ }
}
const haystack = sources.join("\n");
// Pi 源码里 `·` 常写成 \u00b7 转义（settings-submenu.js 等），因此再拿解码后的文本搜一遍
const haystackDecoded = haystack.replaceAll("\\u00b7", "·").replaceAll("\\u3067", "で");
const found = (key) => RUNTIME_VERIFIED.has(key) || haystack.includes(key) || haystackDecoded.includes(key);
// 这些文案由多段拼接而成（源码里搜不到），但已在真实 pi 渲染日志里逐字见到，故列入白名单。
const RUNTIME_VERIFIED = new Set([
  "↑/↓ move · ←/→ page · ctrl+←/→ branch · ctrl+x copy · shift+l label · shift+t label time · filters ctrl+d/t/u/l/a",
  "cycle ctrl+o/shift+ctrl+o",
  // /hotkeys 的 Windows 变体由模板拼接：`New line${platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""}`
  "New line (Ctrl+Enter on Windows Terminal)",
  // 会话选择器的搜索提示由多段拼接（源码里搜不到），已在真实 pi 渲染日志里逐字见到。
  'tab scope · re:<pattern> regex · "phrase" exact',
]);
const drifted = { blocks: [], texts: [] };
for (const section of ["labels", "descriptions", "texts"]) {
  for (const key of Object.keys(dict[section] ?? {})) {
    if (found(key)) continue;
    (section === "texts" ? drifted.texts : drifted.blocks).push(`${section}.${key}`);
  }
}
// labels/descriptions 是稳定的选项文案，漂移即失败；texts 里含按键提示等拼接文案，只告警。
check(drifted.blocks.length === 0, "词典无漂移（labels/descriptions）",
  drifted.blocks.length ? `在 Pi 源码中找不到：${drifted.blocks.join("；")}` : "");
if (drifted.texts.length) {
  warn("texts 漂移（可能含拼接文案，仅供参考）", drifted.texts.join("；"));
} else {
  pass.push("texts 无漂移");
}

/* -------------------------------------------------------------------- 输出 ---- */

console.log("");
for (const label of pass) console.log(`✓ ${label}`);
for (const label of warnings) console.log(`! ${label}`);
for (const label of failures) console.log(`✗ ${label}`);
console.log(`\n${pass.length} 通过 / ${warnings.length} 警告 / ${failures.length} 失败`);
process.exitCode = failures.length ? 1 : 0;
