/**
 * Pi 界面汉化（风格 A：列表行标签中文 + 说明“英文原文 + 中文”两行）。
 *
 * 为什么不能直接 import 组件类？
 *   运行中的 pi 由 dist/bundle/cli-runtime.js 动态 import dist/bundle/chunks/*.js，
 *   而扩展 import '@earendil-works/pi-coding-agent' 拿到的是 dist/index.js 这**另一份副本**
 *   （两份 bundle 各自持有一份 pi-tui 组件类）。给副本打补丁对真实渲染无效。
 *   因此这里改为：扫描 dist/bundle/chunks/*.js 的 export 语句，找到导出目标类的那个 chunk，
 *   直接 import 该 chunk 文件（ESM 缓存 ⇒ 与运行时同一个模块实例），再对类原型打补丁。
 *
 * 设计约束：
 *   - 不修改 Pi 安装目录里的任何文件；不联网、不调用模型。
 *   - 只翻译“界面固定文案”：精确匹配词典的整行 / 标签列 / 设置取值，绝不改动数据
 *     （模型名、主题名、会话标题、路径、工具输出等只会在词典里出现同名项时才被替换）。
 *   - 所有替换都保持原可视宽度或重新截断到终端宽度，异常时原样返回，绝不抛出。
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface UiDictionary {
  labels?: Record<string, string>;
  /** 列表项说明：只用于追加「中文：…」行与 SelectList 行内说明，不会就地替换英文原文。 */
  descriptions?: Record<string, string>;
  texts?: Record<string, string>;
  values?: Record<string, string>;
  /** 含动态内容（按键提示、级别等）的整行：正则 → 替换文本，$1 等可用。 */
  patterns?: [string, string][];
  /** SelectList 行内说明的呈现方式：zh（默认，仅中文）| zh+en | en+zh */
  inline?: "zh" | "zh+en" | "en+zh";
}

export interface UiZhOptions {
  piRoot?: string;
  dictionary?: UiDictionary;
  log?: (message: string) => void;
  /** 附加上下文（写入诊断日志，便于定位运行时环境）。 */
  context?: string;
}

export interface UiZhResult {
  piRoot: string | null;
  chunks: string[];
  patched: string[];
  missing: string[];
  /** 补丁代码版本：与 ui-zh.ts 的 CODE_VERSION 不一致时，/reload 会重新安装补丁。 */
  code: number;
}

const RENDER_FLAG = Symbol.for("pi.uiZh.renderPatched");
const THEME_FLAG = Symbol.for("pi.uiZh.themePatched");
const ITEM_FLAG = Symbol.for("pi.uiZh.renderItemPatched");
const HINT_FLAG = Symbol.for("pi.uiZh.hintPatched");
const INSTALL_FLAG = Symbol.for("pi.uiZh.installed");
const DICT_FLAG = Symbol.for("pi.uiZh.dict");
// 补丁点（新增/变更要打补丁的类或方法）有改动时 +1：
// /reload 会在同一进程重跑安装，版本号不同就重新安装新补丁（已有补丁不会重复套娃）。
const CODE_VERSION = 2;

const errText = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/**
 * 诊断日志：默认写入扩展目录 ui-zh.log（每次进程启动重写，最多 600 行）。
 * 界面汉化失效往往是“补丁打到了另一份类副本”这类静默问题，日志是唯一可靠证据。
 * 设 PI_UI_ZH_LOG=0 可关闭。
 */
let debugLog: ((message: string) => void) | null = null;
function getDebugLog(): (message: string) => void {
  if (debugLog) return debugLog;
  debugLog = () => { };
  if (process.env.PI_UI_ZH_LOG === "0") return debugLog;
  try {
    const file = fileURLToPath(new URL("./ui-zh.log", import.meta.url));
    const stamp = `pi-zh 界面汉化日志 ${new Date().toISOString()}  node ${process.version}\n`;
    // 默认追加（/reload 会重建模块，覆盖会丢掉上一次的记录）；超过 1MB 才重置。
    let small = false;
    try {
      small = existsSync(file) && readFileSync(file).length < 1024 * 1024;
    } catch {
      small = false;
    }
    if (small) appendFileSync(file, `\n===== ${stamp}`);
    else writeFileSync(file, stamp);
    let lines = 0;
    debugLog = (message: string) => {
      if (lines++ >= 800) return;
      try {
        appendFileSync(file, `${message}\n`);
      } catch {
        /* 忽略 */
      }
    };
  } catch {
    /* 忽略 */
  }
  return debugLog;
}

/* ------------------------------------------------------------------ 词典 ---- */

const lookupLabel = (d: UiDictionary, text: string): string | undefined => d.labels?.[splitMarker(text.trim()).body];
const lookupText = (d: UiDictionary, text: string): string | undefined => d.texts?.[text.trim()];
const lookupValue = (d: UiDictionary, text: string): string | undefined => d.values?.[text.trim()];

/** 选中标记（✓ 等）不属于文案本身，查词典时剥掉、替换后原样补回。 */
const MARK_RE = /^([✓✔√]\s*)([\s\S]+)$/;

function splitMarker(text: string): { marker: string; body: string } {
  const m = MARK_RE.exec(text);
  return m ? { marker: m[1], body: m[2] } : { marker: "", body: text };
}

/** 说明文案查词典：直接命中；否则处理 pi 动态拼出的后缀（如“ · default”）。 */
function lookupDescription(d: UiDictionary, text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const key = text.trim();
  if (!key) return undefined;
  const direct = d.descriptions?.[key];
  if (direct) return direct;
  const suffix = " · default";
  if (key.endsWith(suffix)) {
    const base = d.descriptions?.[key.slice(0, -suffix.length).trim()];
    if (base) return `${base} · 默认`;
  }
  return undefined;
}

const INDENT_RE = /^(\s*)([\s\S]*?)(\s*)$/;

/** 整行/整句替换：保留首尾空白，只换中间文字（用于提示行、标题、单行说明）。 */
function translateTextKeepIndent(d: UiDictionary, text: string): string {
  const m = INDENT_RE.exec(text);
  if (!m) return text;
  const zh = lookupText(d, m[2]);
  return zh ? m[1] + zh + m[3] : text;
}

/** 标签替换：中文标签补齐到与原标签相同的可视宽度，保证值列位置不变。 */
function translateLabel(d: UiDictionary, text: string, vw: (s: string) => number): string {
  const m = INDENT_RE.exec(text);
  if (!m) return text;
  const parsed = splitMarker(m[2]);
  const zh = lookupLabel(d, parsed.body);
  if (!zh) return text;
  const out = m[1] + parsed.marker + zh;
  const target = vw(text);
  const got = vw(out);
  return got >= target ? out : out + " ".repeat(target - got);
}

/* ------------------------------------------------- 转义序列 / 可视宽度工具 ---- */

const ESCAPE_RE = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*\x07|[PX^_][^\x1b]*\x1b\\)/;

/** 把一行拆成「纯文本」与「纯文本每个字符在原始字符串中的下标」。 */
function analyzeLine(raw: string): { plain: string; map: number[] } {
  let plain = "";
  const map: number[] = [];
  for (let i = 0; i < raw.length;) {
    if (raw.charCodeAt(i) === 0x1b) {
      const m = ESCAPE_RE.exec(raw.slice(i));
      if (m) {
        i += m[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    plain += raw[i];
    map.push(i);
    i += 1;
  }
  return { plain, map };
}

function splicePlain(raw: string, map: number[], start: number, end: number, replacement: string): string {
  if (start >= end) return raw;
  const from = map[start];
  const to = end < map.length ? map[end] : map[map.length - 1] + 1;
  return raw.slice(0, from) + replacement + raw.slice(to);
}

/** 值行：缩进/光标前缀 + 标签 + 至少两个空格 + 值 */
const ROW_RE = /^([\s>→·]*)(\S(?:[\s\S]*?\S)?)(\s{2,})(\S[\s\S]*)$/;

/* --------------------------------------------------------------- 安装逻辑 ---- */

function candidateRoots(extra: string[]): string[] {
  const roots: string[] = [];
  const add = (p: string | undefined) => {
    if (p) roots.push(path.resolve(p));
  };
  for (const argv of [process.argv[1], process.argv[0], process.execPath]) {
    if (!argv) continue;
    let dir = path.resolve(argv);
    for (let i = 0; i < 8; i++) {
      add(dir);
      add(path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent"));
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  try {
    const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
    for (const version of readdirSync(releases).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      add(path.join(releases, version, "node_modules", "@earendil-works", "pi-coding-agent"));
    }
  } catch {
    /* 忽略 */
  }
  for (const e of extra) add(e);
  return [...new Set(roots)];
}

function isValidPiRoot(dir: string): boolean {
  try {
    if (!existsSync(path.join(dir, "dist", "bundle", "chunks"))) return false;
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "@earendil-works/pi-coding-agent";
  } catch {
    return false;
  }
}

/** 扫描所有 chunk 的 export 语句：{ 文件名: { 导出名: 内部别名 } } */
function scanChunkExports(chunksDir: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const file of readdirSync(chunksDir)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(path.join(chunksDir, file), "utf8");
    const names: Record<string, string> = {};
    const re = /export\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      for (const part of m[1].split(",")) {
        const item = part.trim();
        if (!item) continue;
        const as = item.lastIndexOf(" as ");
        if (as >= 0) names[item.slice(as + 4).trim()] = item.slice(0, as).trim();
        else names[item] = item;
      }
    }
    if (Object.keys(names).length) out[file] = names;
  }
  return out;
}

async function importUrl(url: string): Promise<Record<string, unknown>> {
  const dynamicImport = new Function("u", "return import(u)") as (u: string) => Promise<Record<string, unknown>>;
  return await dynamicImport(url);
}

async function loadNames(piRoot: string, wanted: string[], log: (m: string) => void) {
  const chunksDir = path.join(piRoot, "dist", "bundle", "chunks");
  const exportsByChunk = scanChunkExports(chunksDir);
  const names: Record<string, any> = {};
  const loadedFiles: string[] = [];
  const missing: string[] = [];
  const failedFiles = new Set<string>();
  for (const name of wanted) {
    let found = false;
    for (const file of Object.keys(exportsByChunk)) {
      if (!(name in exportsByChunk[file])) continue;
      if (!loadedFiles.includes(file)) {
        try {
          const mod = await importUrl("file:///" + path.join(chunksDir, file).split(path.sep).join("/"));
          namesStore[file] = mod;
          loadedFiles.push(file);
          log(`已加载运行时 chunk：${file}`);
        } catch (error) {
          namesStore[file] = null;
          // 同一文件只报一次（某些运行时禁止扩展侧原生 import，此时靠包入口兑底）。
          if (!failedFiles.has(file)) {
            failedFiles.add(file);
            log(`chunk 加载失败 ${file}：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      const mod = namesStore[file];
      if (mod && mod[name] !== undefined) {
        names[name] = mod[name];
        found = true;
        break;
      }
    }
    if (!found) missing.push(name);
  }
  return { names, chunks: loadedFiles, missing };
}

const namesStore: Record<string, Record<string, any> | null> = {};

export function resolvePiRoot(extra: string[] = []): string | null {
  return candidateRoots(extra).find(isValidPiRoot) ?? null;
}

export { loadNames };

interface Candidate { label: string; value: any }

/**
 * 收集目标类的**所有可用副本**：
 *   1. 扩展可正常解析的包入口——真实运行时 jiti 用 alias/虚拟模块把它指向运行中 pi 的同一份模块；
 *   2. bundle chunk 原生 import（Node ESM 缓存 ⇒ 与 app 同一个模块实例，但某些运行时不允许）。
 * 两份都打补丁，因此无论渲染走哪一份都会生效；offline 验证同样成立（dist/index.js 与 chunk 两份副本）。
 */
async function collectCandidates(piRoot: string, wanted: string[], log: (m: string) => void) {
  const candidates: Record<string, Candidate[]> = {};
  const add = (name: string, label: string, value: any) => {
    if (value === undefined || value === null) return;
    const list = (candidates[name] ??= []);
    if (!list.some((c) => c.value === value)) list.push({ label, value });
  };
  const hits = (mod: Record<string, any> | undefined): number =>
    mod ? wanted.filter((name) => mod[name] !== undefined).length : 0;

  let piAgent: Record<string, any> | undefined;
  try {
    piAgent = (await import("@earendil-works/pi-coding-agent")) as Record<string, any>;
    log(`[source] @earendil-works/pi-coding-agent 命中 ${hits(piAgent)}/${wanted.length}`);
  } catch (error) {
    log(`[source] @earendil-works/pi-coding-agent 不可用：${errText(error)}`);
  }
  let piTui: Record<string, any> | undefined;
  try {
    piTui = (await import("@earendil-works/pi-tui")) as Record<string, any>;
    log(`[source] @earendil-works/pi-tui 命中 ${hits(piTui)}/${wanted.length}`);
  } catch (error) {
    log(`[source] @earendil-works/pi-tui 不可用：${errText(error)}`);
  }
  for (const name of wanted) {
    add(name, "package:pi-coding-agent", piAgent?.[name]);
    add(name, "package:pi-tui", piTui?.[name]);
  }

  // 判定类来源：bundle 内联副本被 minify（toString 紧凑无色格式化），磁盘 ESM 副本可读。
  // 只有 bundle 副本才是运行中的 pi 真正渲染用的类。
  const describe = (value: any): string => {
    try {
      return String(value).replace(/\s+/g, " ").slice(0, 140);
    } catch {
      return "?";
    }
  };
  for (const name of ["SettingsList", "SettingsSelectorComponent"]) {
    for (const cand of candidates[name] ?? []) log(`[class] ${name}@${cand.label} = ${describe(cand.value)}`);
  }

  let chunks: string[] = [];
  try {
    const loaded = await loadNames(piRoot, wanted, log);
    chunks = loaded.chunks;
    for (const name of wanted) add(name, "chunk", loaded.names[name]);
    if (loaded.missing.length) log(`[source] chunk 未命中：${loaded.missing.join(", ")}`);
  } catch (error) {
    log(`[source] bundle chunk 扫描/加载失败（本运行时不允许原生动态 import，已由包入口兑底）：${errText(error)}`);
  }

  for (const name of wanted) {
    const list = candidates[name] ?? [];
    if (list.length > 1) {
      const same = list.every((c) => c.value === list[0].value);
      log(`[identity] ${name}：${list.map((c) => c.label).join(" / ")} → ${same ? "同一对象" : "不同对象（都会打补丁）"}`);
    }
  }
  return { candidates, chunks };
}

/** 按原型打补丁：用 render 装饰器包裹类自己的 render（优先于继承来的）。 */
function patchRender(Cls: any, wrap: (self: any, lines: string[], width: number) => string[]): boolean {
  const proto = Cls?.prototype;
  if (!proto || typeof proto.render !== "function" || proto[RENDER_FLAG]) return false;
  const original = proto.render;
  Object.defineProperty(proto, "render", {
    configurable: true,
    writable: true,
    value: function (this: any, width: number) {
      const lines = original.call(this, width);
      if (!Array.isArray(lines)) return lines;
      try {
        return wrap(this, lines, width);
      } catch {
        return lines;
      }
    },
  });
  Object.defineProperty(proto, RENDER_FLAG, { configurable: true, writable: true, value: true });
  return true;
}

/** 给 SettingsList 用的主题对象挂上中文翻译（就地包裹一次即可）。 */
function wrapSettingsTheme(list: any, dict: UiDictionary, vw: (s: string) => number): void {
  const theme = list?.theme;
  if (!theme || theme[THEME_FLAG]) return;
  const original = {
    label: typeof theme.label === "function" ? theme.label.bind(theme) : undefined,
    value: typeof theme.value === "function" ? theme.value.bind(theme) : undefined,
    hint: typeof theme.hint === "function" ? theme.hint.bind(theme) : undefined,
  };
  if (original.label) {
    theme.label = (text: string, selected?: boolean) => original.label!(translateLabel(dict, text, vw), selected);
  }
  if (original.value) {
    theme.value = (text: string, selected?: boolean) => {
      const zh = lookupValue(dict, text);
      return original.value!(zh ?? text, selected);
    };
  }
  if (original.hint) {
    theme.hint = (text: string) => original.hint!(translateTextKeepIndent(dict, text));
  }
  Object.defineProperty(theme, THEME_FLAG, { configurable: true, writable: true, value: true });
}

/* ------------------------------------------------------------------ 主函数 ---- */

export async function installUiZh(options: UiZhOptions = {}): Promise<UiZhResult> {
  const log = (message: string): void => {
    getDebugLog()(message);
    options.log?.(message);
  };
  const globals = globalThis as Record<string | symbol, any>;
  const loadedDict: UiDictionary = options.dictionary ?? loadDictionary();
  // /reload 会重新加载扩展模块但保留同一进程：把词典挂到 globalThis 上，
  // 已安装的补丁闭包通过代理读取最新词典，所以改完词典 /reload 即可生效。
  globals[DICT_FLAG] = loadedDict;
  const dict: UiDictionary = new Proxy({} as UiDictionary, {
    get: (_target, prop) => (globals[DICT_FLAG] as any)?.[prop],
    has: (_target, prop) => prop in ((globals[DICT_FLAG] as any) ?? {}),
  });
  const size = (value: unknown): number =>
    Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0;
  log(
    `[dict] labels=${size(loadedDict.labels)} descriptions=${size(loadedDict.descriptions)} texts=${size(loadedDict.texts)} ` +
      `patterns=${size(loadedDict.patterns)} values=${size(loadedDict.values)}`,
  );
  // 注意：/reload 会在同一进程里重新加载扩展，而 globalThis 会保留。
  // 若上次安装是 0 处补丁（例如旧版本残留），必须重新安装而不是直接返回缓存。
  const cached = globals[INSTALL_FLAG] as UiZhResult | undefined;
  if (cached && cached.patched.length > 0 && cached.code === CODE_VERSION) {
    log("界面汉化已安装过，跳过（词典已更新）");
    return { ...cached };
  }
  if (cached) log(cached.patched.length === 0 ? "上次安装未生效（0 处补丁），重新安装" : "补丁代码已更新，重新安装");

  const piRoot = options.piRoot ?? resolvePiRoot() ?? null;
  if (!piRoot) throw new Error("找不到正在运行的 pi 安装目录（dist/bundle/chunks）");
  log(`[root] piRoot=${piRoot}`);
  if (options.context) log(`[context] ${options.context}`);

  const wanted = [
    "SettingsList", "SelectList", "Container", "Text", "Spacer", "Editor", "VStack", "Box", "ScrollView",
    "SettingsSelectorComponent", "ThemeSelectorComponent", "ShowImagesSelectorComponent",
    "ThinkingSelectorComponent", "LoginDialogComponent", "ModelSelectorComponent",
    "SessionSelectorComponent", "TreeSelectorComponent", "OAuthSelectorComponent",
    "ExtensionSelectorComponent", "UserMessageSelectorComponent",
    "visibleWidth", "truncateToWidth",
  ];
  const { candidates, chunks } = await collectCandidates(piRoot, wanted, log);
  const missing = wanted.filter((name) => !(candidates[name]?.length));

  const metric = (name: string, fallback: (...args: any[]) => any) => {
    const found = candidates[name]?.find((c) => typeof c.value === "function");
    return (found?.value ?? fallback) as (...args: any[]) => any;
  };
  const visibleWidth: (s: string) => number = metric("visibleWidth", (s: string) => s.length);
  const truncateToWidth: (s: string, w: number, ellipsis?: string) => string = metric("truncateToWidth", (s: string, w: number) => s.slice(0, w));

  const patched: string[] = [];
  const done = new Set<any>();
  const each = (name: string, install: (value: any) => boolean): void => {
    for (const cand of candidates[name] ?? []) {
      if (done.has(cand.value)) continue;
      let ok = false;
      try {
        ok = install(cand.value);
      } catch (error) {
        log(`[patch] ${name}@${cand.label} 失败：${errText(error)}`);
      }
      if (ok) {
        done.add(cand.value);
        patched.push(`${name}@${cand.label}`);
      }
    }
  };

  const renderedOnce = new Set<string>();
  const untranslated = new Set<string>();
  /** 逐行翻译 + 首次渲染/未译行诊断（未译行清单用于补词典）。 */
  const engine = (label: string) => (lines: string[], width: number): string[] => {
    if (!renderedOnce.has(label)) {
      renderedOnce.add(label);
      log(`[render] ${label} 首次渲染 ${lines.length} 行，前 6 行原文：`);
      for (const line of lines.slice(0, 6)) log(`    ${JSON.stringify(analyzeLine(line).plain)}`);
    }
    return lines.map((line) => {
      try {
        const out = translateLine(dict, line, width, visibleWidth, truncateToWidth);
        if (out === line) {
          const text = analyzeLine(line).plain.trim();
          // 只记录“还没中文且含英文字母”的候选行，作为补词典的清单（已汉化/纯装饰行不入日志）。
          if (text && /[A-Za-z]/.test(text) && !/[\u3400-\u9fff\u3040-\u30ff]/.test(text) && untranslated.size < 400 && !untranslated.has(text)) {
            untranslated.add(text);
            log(`[未译] ${JSON.stringify(text)}`);
          }
        }
        return out;
      } catch {
        return line;
      }
    });
  };

  // 1) 设置界面主列表 + 其子菜单（子菜单由 SelectSubmenu 渲染后经 SettingsList.render 返回）
  each("SettingsList", (SettingsList) => {
    let applied = false;
    if (patchRender(SettingsList, (self, lines, width) => {
      wrapSettingsTheme(self, dict, visibleWidth);
      return engine("SettingsList")(lines, width);
    })) {
      applied = true;
    }
    // 2) 设置项说明：英文原文之后补一行“中文：…”
    if (SettingsList?.prototype && typeof SettingsList.prototype.addHintLine === "function" && !SettingsList.prototype[HINT_FLAG]) {
      const originalAddHint = SettingsList.prototype.addHintLine;
      SettingsList.prototype.addHintLine = function (this: any, lines: string[], width: number) {
        try {
          const items = typeof this.getDisplayItems === "function" ? this.getDisplayItems() : undefined;
          const selected = items?.[this.selectedIndex];
          const zh = lookupDescription(dict, selected?.description);
          if (zh) lines.push(this.theme.description(`  中文：${zh}`));
        } catch {
          /* 忽略 */
        }
        return originalAddHint.call(this, lines, width);
      };
      Object.defineProperty(SettingsList.prototype, HINT_FLAG, { configurable: true, writable: true, value: true });
      log("  └ SettingsList.addHintLine 已汉化（设置项中文说明行）");
      applied = true;
    } else if (SettingsList?.prototype && typeof SettingsList.prototype.addHintLine !== "function") {
      log("  └ SettingsList.addHintLine 不存在（本版 pi 不可用，说明行改为仅英文）");
    }
    return applied;
  });

  // 3) SelectList 类界面（/theme、/thinking、/images、设置二级菜单…）：行标签列 + 行内说明
  each("SelectList", (SelectList) => {
    let applied = false;
    if (SelectList?.prototype && typeof SelectList.prototype.renderItem === "function" && !SelectList.prototype.renderItem[ITEM_FLAG]) {
      const originalRenderItem = SelectList.prototype.renderItem;
      const wrappedRenderItem = function (this: any, item: any, isSelected: boolean, width: number, description: string | undefined, primaryColumnWidth: number) {
        let desc = description;
        if (typeof desc === "string" && desc.length > 0) {
          const zh = lookupDescription(dict, desc) ?? lookupText(dict, desc);
          if (zh) {
            const mode = dict.inline ?? "zh";
            desc = mode === "zh+en" ? `${zh} · ${desc}` : mode === "en+zh" ? `${desc} · ${zh}` : zh;
          }
        }
        return originalRenderItem.call(this, item, isSelected, width, desc, primaryColumnWidth);
      };
      Object.defineProperty(wrappedRenderItem, ITEM_FLAG, { value: true, configurable: true, writable: true });
      SelectList.prototype.renderItem = wrappedRenderItem;
      applied = true;
    }
    if (patchRender(SelectList, (_self, lines, width) => engine("SelectList")(lines, width))) {
      applied = true;
    }
    return applied;
  });

  // 4) 其余导出界面组件（标题、说明、提示行等整行文案）
  for (const name of [
    "SettingsSelectorComponent", "ThemeSelectorComponent", "ShowImagesSelectorComponent",
    "ThinkingSelectorComponent", "LoginDialogComponent", "ModelSelectorComponent",
    "SessionSelectorComponent", "TreeSelectorComponent", "OAuthSelectorComponent",
    "ExtensionSelectorComponent", "UserMessageSelectorComponent",
  ]) {
    each(name, (Cls) => patchRender(Cls, (_self, lines, width) => engine(name)(lines, width)));
  }

  // 5) 兜底：挂到“编辑器容器”里的屏幕（/trust、/config、首次运行等类未导出的对话框）。
  //    editorContainer = 持有 Editor 的那个 Container；只有它的子节点会被翻译，
  //    聊天记录（ScrollView）与输入框绝不经过这里。
  const editorClass = candidates["Editor"]?.[0]?.value;
  const editorContainers = new WeakSet<object>();
  const chromeRoots = new WeakSet<object>();
  let chromeCount = 0;
  const markChrome = (container: any, child: any): void => {
    try {
      if (!child || typeof child !== "object") return;
      if (editorClass && child instanceof editorClass) {
        editorContainers.add(container); // 编辑器被加回来 ⇒ 这个容器就是编辑器容器
        return;
      }
      if (!editorContainers.has(container) || chromeRoots.has(child)) return;
      chromeRoots.add(child);
      const Cls = child.constructor;
      if (Cls?.prototype && typeof Cls.prototype.render === "function" && !Cls.prototype[RENDER_FLAG]) {
        if (patchRender(Cls, (self, lines, width) => (chromeRoots.has(self) ? engine("chrome")(lines, width) : lines))) {
          chromeCount++;
          log(`[chrome] ${Cls.name || "(匿名类)"} 加入兜底汉化`);
        }
      }
    } catch (error) {
      log(`[chrome] 标记失败：${errText(error)}`);
    }
  };
  const patchAddChild = (Cls: any): void => {
    const proto = Cls?.prototype;
    if (!proto || typeof proto.addChild !== "function") return;
    const key = Symbol.for("pi.uiZh.addChildPatched");
    if (proto[key]) return;
    const original = proto.addChild;
    proto.addChild = function (this: any, child: any) {
      markChrome(this, child);
      return original.call(this, child);
    };
    proto[key] = true;
  };
  if (editorClass) {
    for (const name of ["Container", "VStack", "Box", "ScrollView"]) {
      for (const cand of candidates[name] ?? []) patchAddChild(cand.value);
    }
    each("Container", (Container) => patchRender(Container, (self, lines, width) => (chromeRoots.has(self) ? engine("chrome")(lines, width) : lines)));
    log(`[chrome] addChild 挂钩就绪；兜底补丁 ${chromeCount} 个类`);
  } else {
    log("[chrome] 未取到 Editor 类，跳过兜底汉化（/trust、/config 等仍为英文）");
  }

  const result: UiZhResult = { piRoot, chunks, patched, missing, code: CODE_VERSION };
  globals[INSTALL_FLAG] = result;
  if (patched.length === 0) {
    log(`[FAIL] 没有安装任何补丁；缺失类：${missing.join(", ") || "（无）"}`);
  } else {
    log(`界面汉化已启用：${patched.length} 处补丁 → ${patched.join(", ")}`);
  }
  return result;
}

/** 逐行翻译：整行精确匹配优先，其次“标签 + 值”行只替换标签列（保持列宽）。 */
function translateLine(
  dict: UiDictionary,
  line: string,
  width: number,
  vw: (s: string) => number,
  truncate: (s: string, w: number, ellipsis?: string) => string,
): string {
  const { plain, map } = analyzeLine(line);
  const trimmed = plain.trim();
  if (!trimmed) return line;

  // 整行匹配先查 texts，再退到 labels（同一个键可能既是列表标签又是独立标题行，例如 “Project trust”）。
  const whole = lookupText(dict, trimmed) ?? lookupLabel(dict, trimmed);
  if (whole) {
    const start = plain.length - plain.trimStart().length;
    const end = plain.trimEnd().length;
    return truncate(splicePlain(line, map, start, end, whole), width);
  }

  for (const [source, replacement] of dict.patterns ?? []) {
    try {
      const re = new RegExp(source);
      if (!re.test(trimmed)) continue;
      const zh = trimmed.replace(re, replacement);
      const start = plain.length - plain.trimStart().length;
      const end = plain.trimEnd().length;
      return truncate(splicePlain(line, map, start, end, zh), width);
    } catch {
      /* 无效正则：跳过 */
    }
  }

  const row = ROW_RE.exec(plain);
  if (row) {
    const zh = lookupLabel(dict, row[2]);
    if (zh) {
      const start = row[1].length;
      const end = start + row[2].length + row[3].length + row[4].length;
      const marker = splitMarker(row[2]).marker;
      // 值列（值词典命中时）同步汉化，并按原宽度补空格，保证后续列不错位。
      const valueMatch = /^(\S+)(\s*)$/.exec(row[4]);
      const zhValue = valueMatch ? lookupValue(dict, valueMatch[1]) : undefined;
      const value = zhValue && valueMatch ? padTo(zhValue, vw(valueMatch[1]), vw) + valueMatch[2] : row[4];
      return truncate(splicePlain(line, map, start, end, padTo(marker + zh, vw(row[2]), vw) + row[3] + value), width);
    }
  }
  return line;
}

/** 中文补齐到指定可视宽度（只补不裁）。 */
function padTo(text: string, target: number, vw: (s: string) => number): string {
  const got = vw(text);
  return got >= target ? text : text + " ".repeat(target - got);
}

export function loadDictionary(url: URL | string = new URL("./ui-zh.json", import.meta.url)): UiDictionary {
  const raw = JSON.parse(readFileSync(url, "utf8")) as UiDictionary;
  return raw;
}

export default installUiZh;
