// 覆盖率盘点：把 Pi 安装里的界面字面量逐个与 ui-zh.json 对照，列出还没覆盖的文案。
// 用法：node coverage.mjs [--show 12] [--file model-selector] [--root <pi 包目录>]
// 说明：候选字串只从“会渲染界面”的文件里抽取（interactive 模式及其 components），并过滤代码噪声；
// 少量源码里用 \\u00b7 转义写的文案会在比对前还原，避免误报。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const SHOW = Number(argValue("--show") ?? 10);
const FILE_FILTER = argValue("--file");
const DICT_PATH = argValue("--dict") ?? new URL("./ui-zh.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const findPiRoot = () => {
  const explicit = argValue("--root") ?? process.env.PI_UI_ZH_ROOT;
  if (explicit) return explicit;
  const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
  if (!existsSync(releases)) return null;
  const versions = readdirSync(releases).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(releases, version, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(path.join(candidate, "dist"))) return candidate;
  }
  return null;
};

const PI_ROOT = findPiRoot();
if (!PI_ROOT) {
  console.error("找不到 pi 安装目录（可用 --root 指定）");
  process.exit(1);
}
const dict = JSON.parse(readFileSync(DICT_PATH, "utf8"));

const keys = new Set();
for (const section of ["labels", "descriptions", "texts", "values", "extensionTexts", "paragraphs", "chromeTitles"]) {
  for (const k of Object.keys(dict[section] ?? {})) keys.add(k.trim());
}
const patterns = (dict.patterns ?? [])
  .map(([source]) => {
    try {
      return new RegExp(source);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const isCandidate = (s) => {
  const text = s.trim();
  if (typeof s !== "string" || text.length < 4 || text.length > 300) return false;
  if (!/ /.test(text) || !/[a-z]/.test(text) || !/[A-Za-z]{2}/.test(text)) return false;
  if (/[\u4e00-\u9fff]/.test(text)) return false;
  if (/^[\w@./\\:-]+$/.test(text)) return false;
  if (/[${]|\{|}|=>|; |\bfunction\b|\breturn\b|\bconst\b|\blet\b|===|!==|&&|\|\||\.join\(|\.map\(|\bnew \w+\(|\brequire\(|\bimport\b/.test(text)) return false;
  if (/^[),.;:]+/.test(text) || /[;{}]$/.test(text)) return false;
  if (/(^|\s)(https?|file|data):/.test(text)) return false;
  return true;
};

const collect = (dir, out) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
};

const INTERACTIVE = path.join(PI_ROOT, "dist", "modes", "interactive");
const files = [];
if (existsSync(INTERACTIVE)) collect(INTERACTIVE, files);
const include = (rel) => !rel.includes("/vendor/") && !rel.includes("theme-tokens") && !rel.includes("theme-schema") && !rel.endsWith(".d.ts") && !rel.endsWith(".map");

const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
const report = [];
for (const file of files) {
  const rel = path.relative(PI_ROOT, file).replace(/\\/g, "/");
  if (FILE_FILTER && !rel.includes(FILE_FILTER)) continue;
  if (!include(rel)) continue;
  const source = readFileSync(file, "utf8");
  const seen = new Set();
  let total = 0;
  let covered = 0;
  const uncovered = [];
  for (const match of source.matchAll(LITERAL)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const text = raw
      .replace(/\\u00b7/g, "·")
      .replace(/\\n/g, " ")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (seen.has(text) || !isCandidate(text)) continue;
    seen.add(text);
    total += 1;
    if (keys.has(text) || patterns.some((re) => re.test(text))) covered += 1;
    else uncovered.push(text);
  }
  if (total) report.push({ rel, total, covered, uncovered });
}

report.sort((a, b) => b.uncovered.length - a.uncovered.length);
const totalAll = report.reduce((sum, r) => sum + r.total, 0);
const coveredAll = report.reduce((sum, r) => sum + r.covered, 0);
console.log(`pi 安装：${PI_ROOT}`);
console.log(`界面字面量候选 ${totalAll} 条，词典已覆盖 ${coveredAll} 条（${((coveredAll / totalAll) * 100).toFixed(1)}%）`);
console.log("未覆盖分布（前 20 个文件）：");
for (const r of report.slice(0, 20)) {
  console.log(`  ${String(r.uncovered.length).padStart(4)} 未覆盖 / ${String(r.total).padStart(4)} 条  ${r.rel}`);
}
if (SHOW > 0) {
  console.log("\n未覆盖文案示例（仍在界面上出现的需补词典；聊天记录/消息/工具输出类属设计不翻译）：");
  for (const r of report.slice(0, 6)) {
    if (!r.uncovered.length) continue;
    console.log(`\n### ${r.rel}（${r.uncovered.length} 条）`);
    for (const s of r.uncovered.slice(0, SHOW)) console.log(`  - ${s}`);
  }
}
