#!/usr/bin/env node
/**
 * audit-ui.mjs —— 界面文案覆盖审计（“同类型英文是否都翻到了”）
 *
 * 扫描 Pi 安装目录里所有经主题通路渲染的界面字面量，逐个套用 ui-zh.ts 的运行时判定，
 * 列出仍然没有词典覆盖的条目：
 *   1. theme.fg(role, "…") / theme.bold("…")  → chromeTitles / statusTexts / statusPatterns / textPatterns
 *   2. showStatus("…")                        → statusTexts / statusPatterns（状态行以 theme.fg("dim", …) 渲染）
 *   3. showError/showWarning/showInfo("…")    → chromeTitles / textPatterns
 *
 * 用法：node audit-ui.mjs [--root <pi 安装目录>] [--dict <ui-zh.json>] [--all]
 *   默认只打印未被覆盖的条目（不含纯专有名词/工具名/聊天记录内容的噪声过滤已尽量做足）；
 *   --all 同时打印已覆盖数量与按文件分组的总览。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const SHOW_ALL = argv.includes("--all");

const findPiRoot = () => {
  const explicit = argOf("--root", process.env.PI_UI_ZH_ROOT);
  if (explicit) return explicit;
  const releases = join(homedir(), ".pi", "agent", "install", "releases");
  const versions = readdirSync(releases).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const v of versions.reverse()) {
    const root = join(releases, v, "node_modules", "@earendil-works", "pi-coding-agent");
    try { if (statSync(join(root, "dist")).isDirectory()) return root; } catch { /* 继续 */ }
  }
  throw new Error("找不到 pi 安装目录，请用 --root 指定");
};

const PI = findPiRoot();
const DICT = argOf("--dict", join(homedir(), ".pi", "agent", "extensions", "pi-zh", "ui-zh.json"));
const dict = JSON.parse(readFileSync(DICT, "utf8"));

const compiles = (list) => (list ?? []).map(([s, r]) => { try { return [new RegExp(s), r]; } catch { return null; } }).filter(Boolean);
const statusPatterns = compiles(dict.statusPatterns);
const textPatterns = compiles(dict.textPatterns);
const allPatterns = [...statusPatterns, ...textPatterns];
const chromeTitles = dict.chromeTitles ?? {};
const statusTexts = dict.statusTexts ?? {};

/** 镜像 ui-zh.ts translateTitle 的判定：theme 包装只认这四段。 */
const themePath = (method, role, raw) => {
  const t = raw.trim();
  if (raw.length <= 80 && chromeTitles[t]) return "chromeTitles";
  if (method === "fg" && (role === "dim" || role === "muted")) {
    if (statusTexts[t]) return "statusTexts";
    for (const [re] of statusPatterns) if (re.test(t)) return "statusPatterns";
  }
  // showError/showWarning：`Error: …` / `Warning: …` 只翻正文（Error:/Warning: 前缀由 wrapper 补中文）。
  if (method === "fg" && (role === "error" || role === "warning")) {
    for (const p of ["Error: ", "Warning: "]) {
      if (!t.startsWith(p)) continue;
      const body = t.slice(p.length);
      if (chromeTitles[body] || statusTexts[body]) return "prefixed";
      for (const section of ["texts", "extensionTexts"]) if ((dict[section] ?? {})[body]) return "prefixed";
      for (const [re] of [...statusPatterns, ...textPatterns]) if (re.test(body)) return "prefixed";
    }
  }
  for (const [re] of textPatterns) if (re.test(t)) return "textPatterns";
  return null;
};
/** 其它通路（列表行/段落）是否已收录，用于区分“缺口”与“已在别处翻译”。 */
const anywhere = (raw) => {
  const t = raw.trim();
  for (const section of ["labels", "descriptions", "texts", "values", "chromeTitles", "statusTexts", "extensionTexts", "paragraphs"]) {
    if ((dict[section] ?? {})[t]) return section;
  }
  for (const [re] of allPatterns) if (re.test(t)) return "patterns";
  return null;
};

/* ---------------------------------------------------------------- 源码扫描 -- */
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".js")) files.push(full);
  }
};
for (const sub of ["modes", "core"]) {
  try { walk(join(PI, "dist", sub)); } catch { /* 目录不存在 */ }
}

/** 取出实参列表（忽略嵌套括号与字符串里的逗号）。 */
const splitArgs = (src, openIdx) => {
  const args = []; let depth = 0; let cur = ""; let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) { cur += ch; if (ch === "\\") { cur += src[++i] ?? ""; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
    if (ch === "(") { depth++; if (depth === 1) continue; }
    if (ch === ")") { depth--; if (depth === 0) { args.push(cur.trim()); break; } }
    if (ch === "," && depth === 1) { args.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  return args;
};
/** 还原字面量：去掉引号并解码 \uXXXX / \n / \t 等转义（源码与运行时的关键差异）。 */
const unquote = (arg) => {
  const m = /^(["'`])([\s\S]*)\1$/.exec((arg ?? "").trim());
  if (!m) return undefined;
  const body = m[2];
  const decoded = body.includes("${") ? body.replace(/\$\{[^}]*\}/g, "\u0000") : body;
  return decoded.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["'`\\])/g, "$1")
    .length > 0 ? decoded.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["'`\\])/g, "$1") : undefined;
};
const isPlaceholder = (s) => s.includes("${") || s.includes("\u0000");

const ROLE_NAMES = new Set(["accent", "dim", "muted", "text", "error", "warning", "success", "border", "borderMuted", "borderAccent", "fg", "bg", "thinkingText", "toolOutput", "toolTitle", "toolDiffContext", "toolDiffAdded", "toolDiffRemoved", "mdLink", "mdCode", "mdHeading", "customMessageLabel", "customMessageText", "selectedBg", "terminalBg", "label", "value", "hint", "description", "cursor", "scrollInfo", "noMatch", "selectedText"]);
const NOISE = new Set(["read", "write", "edit", "grep", "find", "codemode", "bash", "task", "todo"]);
const noisy = (text) => {
  const t = text.trim();
  if (!t || ROLE_NAMES.has(t) || NOISE.has(t.toLowerCase())) return true;
  if (/\x1b/.test(t)) return true;                    // ANSI 片段
  if (!/[A-Za-z]{3}/.test(t)) return true;            // 无实词（符号、缩写）
  if (/^[a-z0-9-]+\/[a-z0-9.-]+$/i.test(t)) return true; // 包名/路径
  return false;
};

const found = new Map(); // key → {kind, file, text}
const record = (kind, role, method, text, file) => {
  if (text === undefined || noisy(text)) return;
  if (isPlaceholder(text)) return; // 模板由 patterns 负责，不在此列（避免逐条 TPL 噪声）
  const key = `${kind}|${role}|${text}`;
  if (!found.has(key)) found.set(key, { kind, role, method, text, file });
};

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = relative(PI, file).replace(/\\/g, "/");
  for (const m of src.matchAll(/theme\s*\.\s*(fg|bold)\s*\(/g)) {
    const args = splitArgs(src, m.index + m[0].length - 1);
    const role = m[1] === "fg" ? unquote(args[0]) ?? "?" : "?";
    const text = unquote(m[1] === "fg" ? args[1] : args[0]);
    if (isPlaceholder(text ?? "")) continue;
    record("theme", role, m[1], text, rel);
  }
  // 按键提示：keyHint/rawKeyHint/hint(key, description) 的说明部分会变成 theme.fg("muted", ` ${description}`)
  for (const m of src.matchAll(/(?<![.\w])(?:keyHint|rawKeyHint|hint)\s*\(/g)) {
    const args = splitArgs(src, m.index + m[0].length - 1);
    if (args.length < 2) continue;
    const text = unquote(args[args.length - 1]);
    if (isPlaceholder(text ?? "")) continue;
    record("hint", "muted", "fg", text, rel);
  }
  for (const m of src.matchAll(/\.(showStatus|showError|showWarning|showInfo)\s*\(/g)) {
    const text = unquote(splitArgs(src, m.index + m[0].length - 1)[0]);
    if (isPlaceholder(text ?? "")) continue;
    record(m[1], "dim", m[1], text, rel);
  }
}

/* ------------------------------------------------------------------ 结果 ---- */
const FRAGMENT_RE = /[:：]\s*$|◉|○|\|\s*$/;
const isFragment = (text) => {
  const t = text.trim();
  return FRAGMENT_RE.test(t) || t.split(/\s+/).length <= 2;
};

const miss = [];
const fragments = [];
let covered = 0;
for (const row of found.values()) {
  const hit = row.kind === "theme" ? themePath(row.method, row.role, row.text) : themePath("fg", "dim", row.text);
  if (hit) { covered += 1; continue; }
  (isFragment(row.text) ? fragments : miss).push({ ...row, other: anywhere(row.text) });
}
console.log(`Pi 安装：${PI}`);
console.log(`主题通路界面字面量：${found.size} 条；已覆盖 ${covered}；未覆盖 ${miss.length + fragments.length}（其中待确认的完整文案 ${miss.length}，片段 ${fragments.length}）`);
console.log("提示：片段类多为被拼进整行的主题片段（如 `Scope: `、`◉ All`），由整行模板/列表行处理；" +
  "若属于界面文案，补进 chromeTitles（≤80 且整串）或 textPatterns（锚定正则）后重跑本脚本。");

const byFile = new Map();
for (const row of [...miss, ...fragments]) {
  if (!byFile.has(row.file)) byFile.set(row.file, []);
  byFile.get(row.file).push(row);
}
for (const [file, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n### ${file} (${list.length})`);
  for (const row of list.sort((a, b) => a.text.localeCompare(b.text))) {
    const kind = row.other ? `已在别处(${row.other})` : isFragment(row.text) ? "片段" : "缺口";
    console.log(`  [${row.kind}/${row.role}] ${kind} ${JSON.stringify(row.text)}`);
  }
}
