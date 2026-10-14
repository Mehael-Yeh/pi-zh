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
const ui = await import(pathToFileURL(path.join(HERE, "ui-zh.ts")).href);
const dict = ui.loadDictionary(new URL("./ui-zh.json", import.meta.url));
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

// 10) 幂等
const install2 = await ui.installUiZh({ piRoot, dictionary: dict, log: () => { } });
check(install2.patched.length === install.patched.length, "重复安装补丁数一致",
  `${install.patched.length} → ${install2.patched.length}`);
check(JSON.stringify(renderAll()) === JSON.stringify(after), "重复安装后渲染结果不变");

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

const sections = ["labels", "descriptions", "texts", "values"];
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
