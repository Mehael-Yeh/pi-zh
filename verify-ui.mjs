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
  "ExtensionSelectorComponent", "UserMessageSelectorComponent",
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
for (const key of ["theme", "thinking", "images"]) dump(`${key}（汉化后）`, after[key]);

/* ---------------------------------------------------------------- 断言检查 ---- */

const rows = (lines) => lines.map((line) => {
  const m = ROW_RE.exec(line);
  return m ? { label: m[2], value: m[4], col: vw(m[1] + m[2] + m[3]) } : null;
}).filter(Boolean);

// 1) 标签中文化
const zhLabel = /[\u4e00-\u9fff]/;
const settingsRows = rows(after.settings);
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
const drifted = { blocks: [], texts: [] };
for (const section of ["labels", "descriptions", "texts"]) {
  for (const key of Object.keys(dict[section] ?? {})) {
    if (haystack.includes(key)) continue;
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
