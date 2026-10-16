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
  /**
   * 第三方扩展自己注册的文案（如 `/hotkeys` 里“扩展”小节的快捷键说明）。
   * 这些字串不在 Pi 源码里，无法做漂移检查，因此单独成段维护。
   */
  extensionTexts?: Record<string, string>;
  /**
   * 多行段落（会被终端按宽度折行的说明文字，如 /bug 的隐私声明）：
   * 引擎把连续非空行按空格拼回整段后查这张表，命中则按原缩进与宽度重新折行。
   */
  paragraphs?: Record<string, string>;
  /** 含动态内容的多行段落：正则 → 替换文本（$1 等可用），与 paragraphs 同一匹配流程。 */
  paragraphPatterns?: [string, string][];
  /** 聊天区极少数界面标题（如 /hotkeys 的 “Keyboard Shortcuts”）：按原文精确匹配，只用于全局主题包装。 */
  chromeTitles?: Record<string, string>;
  /**
   * 聊天区状态行（如 /reload 后的 “Reloaded keybindings, …”）。
   * 这类文本经 `theme.fg("dim", message)` 渲染，按原文精确匹配后由全局主题包装替换。
   */
  statusTexts?: Record<string, string>;
  /** 含动态内容的状态行（如 “Model: claude-x”）：只用于 `theme.fg("dim"/"muted", …)` 全串匹配，必须锚定。 */
  statusPatterns?: [string, string][];
  /**
   * 聊天/全屏区里其余少数界面指示条（如全屏模式的 “↓ Jump to latest message · ^⌘↓”）：
   * 与角色无关的锚定正则，只收录确定是界面控件的整串（不碰模型回复）。
   */
  textPatterns?: [string, string][];
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
  /**
   * 运行时活动主题单例（来自 `ctx.ui.theme`）。
   * 主题单例并未从任何包入口导出，chunk 源在 jiti 下也不可用，
   * 因此必须由调用方传入，否则聊天区标题/状态行的全局主题包装无法安装。
   */
  liveTheme?: unknown;
}

export interface UiZhResult {
  piRoot: string | null;
  chunks: string[];
  patched: string[];
  /** 本次只被“换新逻辑”（包裹早已存在）的补丁数；0 补丁 + already>0 属于正常的 /reload 重装。 */
  already: number;
  missing: string[];
  /** 补丁代码版本：与 ui-zh.ts 的 CODE_VERSION 不一致时，/reload 会重新安装补丁。 */
  code: number;
}

const RENDER_FLAG = Symbol.for("pi.uiZh.renderPatched");
const TRUE_RENDER_FLAG = Symbol.for("pi.uiZh.trueRender");
const THEME_FLAG = Symbol.for("pi.uiZh.themePatched");
const ITEM_FLAG = Symbol.for("pi.uiZh.renderItemPatched");
const HINT_FLAG = Symbol.for("pi.uiZh.hintPatched");
const INSTALL_FLAG = Symbol.for("pi.uiZh.installed");
const DICT_FLAG = Symbol.for("pi.uiZh.dict");
// 已安装的包裹统一从这些 globalThis 槽位取“当前实现”，所以 /reload 换成新代码后，
// 老包裹（类原型上的旧闭包）会立刻用上新逻辑 —— 只改词典/翻译逻辑时无需重启 pi。
const ENGINE_FLAG = Symbol.for("pi.uiZh.engine");
const LINE_FLAG = Symbol.for("pi.uiZh.line");
const TABLE_FLAG = Symbol.for("pi.uiZh.table");
const CHROME_FLAG = Symbol.for("pi.uiZh.chrome");
const ADDCHILD_FLAG = Symbol.for("pi.uiZh.trueAddChild");
// 补丁点（新增/变更要打补丁的类或方法）有改动时 +1：
// /reload 会在同一进程重跑安装，版本号不同就重新安装新补丁（已有补丁不会重复套娃）。
const CODE_VERSION = 10;

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
const lookupExtensionText = (d: UiDictionary, text: string): string | undefined => d.extensionTexts?.[text.trim()];
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
  if (!proto) return false;
  // 记录“真正的原方法”：/reload 后旧包裹需要被换成新逻辑，靠它避免一层层套娃。
  const trueOriginal = proto[TRUE_RENDER_FLAG] ?? proto.render;
  if (typeof trueOriginal !== "function") return false;
  if (!proto[TRUE_RENDER_FLAG]) {
    Object.defineProperty(proto, TRUE_RENDER_FLAG, { configurable: true, writable: true, value: trueOriginal });
  }
  Object.defineProperty(proto, "render", {
    configurable: true,
    writable: true,
    value: function (this: any, width: number) {
      const lines = trueOriginal.call(this, width);
      if (!Array.isArray(lines)) return lines;
      try {
        return wrap(this, lines, width);
      } catch {
        return lines;
      }
    },
  });
  // 已装过补丁的类：包裹已被换成当前代码的新实现，但不算新补丁（调用方会记为“已存在”）。
  if (proto[RENDER_FLAG]) return false;
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
      `patterns=${size(loadedDict.patterns)} values=${size(loadedDict.values)} ` +
      `extensionTexts=${size(loadedDict.extensionTexts)} chromeTitles=${size(loadedDict.chromeTitles)} statusTexts=${size(loadedDict.statusTexts)} statusPatterns=${size(loadedDict.statusPatterns)} textPatterns=${size(loadedDict.textPatterns)} paragraphs=${size(loadedDict.paragraphs)}`,
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
    "Markdown", "theme",
    "SettingsSelectorComponent", "ThemeSelectorComponent", "ShowImagesSelectorComponent",
    "ThinkingSelectorComponent", "LoginDialogComponent", "ModelSelectorComponent",
    "SessionSelectorComponent", "TreeSelectorComponent", "OAuthSelectorComponent",
    "ExtensionSelectorComponent", "UserMessageSelectorComponent",
    "visibleWidth", "truncateToWidth", "wrapTextWithAnsi",
  ];
  const { candidates, chunks } = await collectCandidates(piRoot, wanted, log);
  // 主题单例：既不在包入口，也不在 chunk 导出里。
  // theme.js 里 `export const theme = new Proxy({}, { get: (_, p) => globalThis[THEME_KEY][p] })`，
  // 真实主题对象只存在 globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")] 下。
  const themeKeys = [
    Symbol.for("@earendil-works/pi-coding-agent:theme"),
    Symbol.for("@mariozechner/pi-coding-agent:theme"),
  ];
  const themed: unknown[] = [];
  for (const key of themeKeys) {
    const value = (globalThis as Record<symbol, unknown>)[key];
    if (value) themed.push(value);
  }
  if (options.liveTheme) themed.push(options.liveTheme);
  if (themed.length > 0) {
    const entry = candidates["theme"] ?? (candidates["theme"] = []);
    for (const value of themed) {
      if (!entry.some((cand) => cand.value === value)) {
        entry.push({ value: value as any, label: "globalThis:theme" });
      }
    }
    log(`[theme] 活动主题单例候选共 ${entry.length} 份（globalThis / ctx.ui.theme）`);
  }
  // `theme`/`wrapTextWithAnsi` 只用于增强（聊天区标题、折行）：bundle 运行时取不到属于正常，
  // 不计入 missing，避免日志里出现“缺失类”误导（离线验证时它们能取到）。
  const OPTIONAL_NAMES = new Set(["theme", "wrapTextWithAnsi"]);
  const missing = wanted.filter((name) => !OPTIONAL_NAMES.has(name) && !(candidates[name]?.length));

  const metric = (name: string, fallback: (...args: any[]) => any) => {
    const found = candidates[name]?.find((c) => typeof c.value === "function");
    return (found?.value ?? fallback) as (...args: any[]) => any;
  };
  const visibleWidth: (s: string) => number = metric("visibleWidth", (s: string) => s.length);
  const truncateToWidth: (s: string, w: number, ellipsis?: string) => string = metric("truncateToWidth", (s: string, w: number) => s.slice(0, w));
  /** 折行用（多行段落汉化后按同样宽度重新折行）。 */
  const wrapText: (s: string, w: number) => string[] = metric("wrapTextWithAnsi", (s: string, w: number) => {
    const out: string[] = [];
    let rest = s;
    while (visibleWidth(rest) > w) {
      let cut = rest.length;
      while (cut > 1 && visibleWidth(rest.slice(0, cut)) > w) cut -= 1;
      const space = rest.lastIndexOf(" ", cut);
      if (space > 0) cut = space;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, "");
    }
    if (rest) out.push(rest);
    return out.length ? out : [s];
  });

  const patched: string[] = [];
  const done = new Set<any>();
  let alreadyPatched = 0;
  const each = (name: string, install: (value: any) => boolean): void => {
    for (const cand of candidates[name] ?? []) {
      if (done.has(cand.value)) continue;
      const before = !!cand.value?.prototype?.[RENDER_FLAG];
      let ok = false;
      try {
        ok = install(cand.value);
      } catch (error) {
        log(`[patch] ${name}@${cand.label} 失败：${errText(error)}`);
      }
      if (ok) {
        done.add(cand.value);
        patched.push(`${name}@${cand.label}`);
      } else if (before) {
        // 旧代码在本进程早先已装过这个包裹；其内部逻辑是旧的，只能等完全重启 pi。
        alreadyPatched += 1;
      }
    }
  };

  /**
   * 多行段落：终端折行位置随宽度变化，逐行匹配不可能命中，因此先把连续非空行按空格拼回整段，
   * 再查 `paragraphs`（精确）或 `paragraphPatterns`（正则，支持 $1 等动态部分）；命中后按原缩进与宽度重新折行。
   */
  const translateBlocks = (dictionary: UiDictionary, lines: string[], width: number): string[] => {
    const hasBlocks =
      !!(dictionary.paragraphs && Object.keys(dictionary.paragraphs).length) || !!(dictionary.paragraphPatterns?.length);
    if (!hasBlocks) return lines;
    const blockPatterns = dictionary.paragraphPatterns ?? [];
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const raw = analyzeLine(lines[i]).plain;
      const first = raw.trim();
      if (first) {
        let joined = first;
        let end = i;
        let hit: string | undefined;
        for (let j = i; j < lines.length && j < i + 8; j += 1) {
          if (j > i) {
            const next = analyzeLine(lines[j]).plain.trim();
            if (!next) break;
            joined = `${joined} ${next}`;
          }
          const exact = dictionary.paragraphs?.[joined];
          if (exact) {
            hit = exact;
            end = j;
            break;
          }
          for (const [source, replacement] of blockPatterns) {
            try {
              const re = new RegExp(source);
              if (re.test(joined)) {
                hit = joined.replace(re, replacement);
                end = j;
                break;
              }
            } catch {
              // 词典正则写错时跳过这条
            }
          }
          if (hit) break;
        }
        if (hit) {
          const indent = raw.slice(0, raw.length - raw.trimStart().length);
          for (const piece of wrapText(hit, Math.max(1, width - visibleWidth(indent)))) out.push(indent + piece);
          i = end;
          continue;
        }
      }
      out.push(lines[i]);
    }
    return out;
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
    return translateBlocks(dict, lines, width).map((line) => {
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

  // 已安装的补丁都通过下面的间接层取实现：/reload 载入新代码后，
  // 只更新 globalThis 槽位即可让旧包裹用上新词典与新逻辑（无需重启 pi）。
  globals[ENGINE_FLAG] = (label: string, lines: string[], width: number) => engine(label)(lines, width);
  globals[LINE_FLAG] = (line: string, width: number) => translateLine(dict, line, width, visibleWidth, truncateToWidth);
  globals[TABLE_FLAG] = (line: string) => translateTableRow(dict, line, visibleWidth, truncateToWidth);
  const eng = (label: string) => {
    const impl = globals[ENGINE_FLAG] as ((l: string, lines: string[], w: number) => string[]) | undefined;
    return (lines: string[], width: number) => (impl ? impl(label, lines, width) : engine(label)(lines, width));
  };
  const lineZh = (text: string, width: number): string => {
    const impl = globals[LINE_FLAG] as ((l: string, w: number) => string) | undefined;
    return impl ? impl(text, width) : translateLine(dict, text, width, visibleWidth, truncateToWidth);
  };
  const tableZh = (text: string): string => {
    const impl = globals[TABLE_FLAG] as ((l: string) => string) | undefined;
    return impl ? impl(text) : translateTableRow(dict, text, visibleWidth, truncateToWidth);
  };

  // 1) 设置界面主列表 + 其子菜单（子菜单由 SelectSubmenu 渲染后经 SettingsList.render 返回）
  each("SettingsList", (SettingsList) => {
    let applied = false;
    if (patchRender(SettingsList, (self, lines, width) => {
      wrapSettingsTheme(self, dict, visibleWidth);
      return eng("SettingsList")(lines, width);
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
    if (patchRender(SelectList, (_self, lines, width) => eng("SelectList")(lines, width))) {
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
    each(name, (Cls) => patchRender(Cls, (_self, lines, width) => eng(name)(lines, width)));
  }

  // 5) 兜底：挂到“编辑器容器”里的屏幕（/trust、/config、首次运行等类未导出的对话框）。
  //    editorContainer = 持有 Editor 的那个 Container；只有它的子节点会被翻译，
  //    聊天记录（ScrollView）与输入框绝不经过这里。
  const editorClass = candidates["Editor"]?.[0]?.value;
  // 这两个 WeakSet 必须跨 /reload 共享：addChild 挂钩是旧代码装的，包裹会被换成新代码，
  // 若各用各的新实例，旧挂钩写进旧集合、新包裹读新集合，兜底汉化会直接失效。
  const chromeState = ((globals as any)[CHROME_FLAG] ??= {
    editorContainers: new WeakSet<object>(),
    chromeRoots: new WeakSet<object>(),
  });
  const editorContainers: WeakSet<object> = chromeState.editorContainers;
  const chromeRoots: WeakSet<object> = chromeState.chromeRoots;
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
      if (Cls?.prototype && typeof Cls.prototype.render === "function") {
        if (patchRender(Cls, (self, lines, width) => (chromeRoots.has(self) ? eng("chrome")(lines, width) : lines))) {
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
    // 同样要可替换：/reload 后旧挂钩写的旧 WeakSet 会失效，必须换成引用新共享状态的新挂钩。
    const trueOriginal = proto[ADDCHILD_FLAG] ?? proto.addChild;
    if (typeof trueOriginal !== "function") return;
    if (!proto[ADDCHILD_FLAG]) {
      Object.defineProperty(proto, ADDCHILD_FLAG, { configurable: true, writable: true, value: trueOriginal });
    }
    proto.addChild = function (this: any, child: any) {
      markChrome(this, child);
      return trueOriginal.call(this, child);
    };
  };
  if (editorClass) {
    for (const name of ["Container", "VStack", "Box", "ScrollView"]) {
      for (const cand of candidates[name] ?? []) patchAddChild(cand.value);
    }
    each("Container", (Container) => patchRender(Container, (self, lines, width) => (chromeRoots.has(self) ? eng("chrome")(lines, width) : lines)));
    log(`[chrome] addChild 挂钩就绪；兜底补丁 ${chromeCount} 个类`);
  } else {
    log("[chrome] 未取到 Editor 类，跳过兜底汉化（/trust、/config 等仍为英文）");
  }

  // 6) /hotkeys 这类“打印到聊天区”的界面输出：只处理含 Key|Action 画框表格的 Markdown 块，
  //    所以模型回复（普通 Markdown）绝不受影响；标题行 “Keyboard Shortcuts” 走全局主题包装。
  each("Markdown", (Markdown) =>
    patchRender(Markdown, (_self, lines, width) => {
      let isHotkeys = false;
      for (const line of lines) {
        if (HOTKEY_HEADER_RE.test(analyzeLine(line).plain.trim())) {
          isHotkeys = true;
          break;
        }
      }
      if (!isHotkeys) return lines;
      let misses = 0;
      return lines.map((line) => {
        const table = tableZh(line);
        const out = table !== line ? table : lineZh(line, width);
        // 诊断：把仍未汉化的表格行原文记进日志（最多 5 行），便于定位漏掉的文案。
        if (out === line && misses < 5) {
          const plain = analyzeLine(line).plain;
          if (plain.includes("│") && /[A-Za-z]/.test(plain)) {
            misses += 1;
            log(`[table-miss] ${JSON.stringify(plain.trim())}`);
          }
        }
        return out;
      });
    }),
  );
  const chromeTitles = dict.chromeTitles ?? {};
  const statusTexts = dict.statusTexts ?? {};
  const statusPatterns = dict.statusPatterns ?? [];
  const textPatterns = dict.textPatterns ?? [];
  // showError/showWarning 把消息拼成 `Error: …` / `Warning: …` 后走 theme.fg("error"/"warning", …)：
  // 单独拆出前缀与正文，正文查词典后才翻译，未收录的正文保持英文。
  const MESSAGE_PREFIXES: [string, string][] = [
    ["Error: ", "错误："],
    ["Warning: ", "警告："],
  ];
  const applyPattern = (list: [string, string][], text: string): string | undefined => {
    for (const [source, replacement] of list) {
      let re: RegExp;
      try {
        re = new RegExp(source);
      } catch {
        continue;
      }
      if (re.test(text)) return text.replace(re, replacement);
    }
    return undefined;
  };
  const translatePrefixed = (method: string, role: unknown, trimmed: string): string | undefined => {
    if (method !== "fg" || (role !== "error" && role !== "warning")) return undefined;
    for (const [en, zh] of MESSAGE_PREFIXES) {
      if (!trimmed.startsWith(en)) continue;
      const body = trimmed.slice(en.length);
      const hit =
        chromeTitles[body] ??
        statusTexts[body] ??
        dict.texts?.[body] ??
        dict.extensionTexts?.[body] ??
        applyPattern(textPatterns, body) ??
        applyPattern(statusPatterns, body);
      if (hit) return `${zh}${hit}`;
    }
    return undefined;
  };
  if (Object.keys(chromeTitles).length > 0 || Object.keys(statusTexts).length > 0 || statusPatterns.length > 0 || textPatterns.length > 0) {
    const translateTitle = (method: string, original: (...args: any[]) => any) =>
      function (this: any, ...args: any[]) {
        const last = args.length - 1;
        const text = args[last];
        if (typeof text === "string") {
          const trimmed = text.trim();
          const zh =
            // 界面标题（theme.fg("accent", "…") / theme.bold("…")）
            (text.length <= 80 ? chromeTitles[trimmed] : undefined) ??
            // 聊天区状态行：只认 theme.fg("dim"/"muted", message) 这种整串调用，避免动到其它着色文本。
            (method === "fg" && (args[0] === "dim" || args[0] === "muted")
              ? statusTexts[trimmed] ?? applyPattern(statusPatterns, trimmed)
              : undefined) ??
            // showError/showWarning 的 `Error: …` / `Warning: …`（正文查词典）
            translatePrefixed(method, args[0], trimmed) ??
            // 其它被明确收录的界面指示条（锚定正则，与角色无关）。
            applyPattern(textPatterns, trimmed);
          // 保留原字符串首尾空白（如全屏指示条两侧的 padding），避免布局位移。
          if (zh) {
            const leading = text.slice(0, text.length - text.trimStart().length);
            const trailing = text.slice(text.trimEnd().length);
            args[last] = leading + zh + trailing;
          }
        }
        return original.apply(this, args);
      };
    for (const cand of candidates["theme"] ?? []) {
      const themeObject = cand.value;
      // theme 单例是跨 realm 代理（对实例赋值/defineProperty 都无效）：只能改它的原型。
      const proto = themeObject?.constructor?.prototype;
      if (!proto) continue;
      for (const method of ["fg", "bold"]) {
        // 与 patchRender 同理：记住真正的原方法，每次安装都用它包一层新实现，
        // 这样 /reload 后新加的词（如状态行 statusTexts）才会立即生效，且不会套娃。
        const originalKey = Symbol.for(`pi.uiZh.titleOriginal.${method}`);
        const original = (proto[originalKey] as ((...args: any[]) => any) | undefined) ?? proto[method];
        if (typeof original !== "function") continue;
        const firstInstall = !proto[originalKey];
        proto[originalKey] = original;
        try {
          Object.defineProperty(proto, method, {
            value: translateTitle(method, original),
            configurable: true,
            writable: true,
          });
        } catch (error) {
          log(`[patch] theme.${method} 失败：${errText(error)}`);
          continue;
        }
        // 自检：必须用「属性查找」走真实读路径（原型链），不能直接调 proto.fg——
        // 那样只是调我们自己的函数，代理/原型没挂对也会假成功。
        try {
          const sample = Object.keys(chromeTitles)[0];
          const probe =
            method === "fg"
              ? String((themeObject as Record<string, any>).fg("accent", sample))
              : String((themeObject as Record<string, any>).bold(sample));
          if (!probe.includes(chromeTitles[sample])) {
            log(`[patch] theme.${method} 包装未生效（跨 realm 代理拦截），跳过`);
            continue;
          }
        } catch (error) {
          log(`[patch] theme.${method} 自检异常：${errText(error)}`);
          continue;
        }
        const already = !firstInstall;
        if (already) alreadyPatched += 1;
        else patched.push(`theme.${method}@${cand.label}`);
      }
    }
  }

  const result: UiZhResult = { piRoot, chunks, patched, already: alreadyPatched, missing, code: CODE_VERSION };
  globals[INSTALL_FLAG] = result;
  if (missing.length) log(`[warn] 未取到：${missing.join(", ")}（相关功能跳过，其余照常）`);
  if (patched.length === 0) {
    if (alreadyPatched > 0) {
      log("[info] 补丁早已安装在类原型上（本进程早先的安装）：本次只更新了词典。若界面仍缺新功能，请 /reload；只有补丁点（新增要挂钩的类）才需要完全重启 pi。");
    } else {
      log(`[FAIL] 没有安装任何补丁；缺失类：${missing.join(", ") || "（无）"}`);
    }
  } else {
    log(`界面汉化已启用：${patched.length} 处补丁 → ${patched.join(", ")}`);
    if (alreadyPatched > 0) {
      log(`[info] 另有 ${alreadyPatched} 处由早先的安装提供（已换成新实现；/reload 即可生效）`);
    }
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
  const whole = lookupText(dict, trimmed) ?? lookupLabel(dict, trimmed) ?? lookupExtensionText(dict, trimmed);
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

/** /hotkeys 的画框表格表头：`│ Key │ Action │` —— 只有这种表格才允许被翻译。 */
const HOTKEY_HEADER_RE = /^│\s*Key\s*│\s*Action\s*│/;

/**
 * 画框表格行（`│ 按键 │ 说明 │`）的单元格汉化：
 * 只替换命中词典的单元格，并保持该单元格的可视宽度不变（否则右侧边框会错位）。
 * 从右往左替换，左侧单元格的原始下标因此始终有效。
 */
function translateTableRow(
  dict: UiDictionary,
  line: string,
  vw: (s: string) => number,
  truncate: (s: string, w: number, ellipsis?: string) => string,
): string {
  const { plain, map } = analyzeLine(line);
  if (!plain.includes("│")) return line;
  const cells: { text: string; start: number }[] = [];
  let index = 0;
  for (const text of plain.split("│")) {
    cells.push({ text, start: index });
    index += text.length + 1;
  }
  if (cells.length !== 4) return line;
  let out = line;
  for (let i = 2; i >= 1; i--) {
    const cell = cells[i];
    const body = cell.text.trim();
    if (!body) continue;
    const zh = lookupText(dict, body) ?? lookupLabel(dict, body) ?? lookupExtensionText(dict, body);
    if (!zh) continue;
    const cellWidth = vw(cell.text);
    const zhText = truncate(zh, Math.max(1, cellWidth - 1), "");
    const rebuilt = ` ${zhText}${padTo("", cellWidth - 1 - vw(zhText), vw)}`;
    const next = splicePlain(out, map, cell.start, cell.start + cell.text.length, rebuilt);
    if (next !== out) out = next;
  }
  return out;
}

export function loadDictionary(url: URL | string = new URL("./ui-zh.json", import.meta.url)): UiDictionary {
  const raw = JSON.parse(readFileSync(url, "utf8")) as UiDictionary;
  return raw;
}

export default installUiZh;
