#!/usr/bin/env node
/**
 * privacy-check.mjs —— 提交前隐私自检
 *
 * 扫描被 Git 跟踪的文件（以及可选的提交历史），检查是否混入了：
 *   - 本机绝对路径 / 用户名（C:\Users\<name>、/home/<name>、盘符路径）
 *   - 邮箱、私网 IP
 *   - 凭证：URL 内嵌账号密码、常见 token 前缀、私钥块、password/secret 字面量赋值
 *   - 大体积可疑文件（日志、备份、转储）
 *
 * 用法：
 *   node privacy-check.mjs            # 只查工作区（被跟踪文件）
 *   node privacy-check.mjs --history  # 再查全部提交历史（发现后需要改历史才能清除，如 git filter-repo）
 *
 * 退出码：0 = 未发现；1 = 有发现（见输出）。
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const ROOT = process.cwd();
const withHistory = process.argv.includes("--history");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const userName = basename(homedir());
const home = homedir();

/** 允许出现的“看似敏感但安全”的内容：公共链接、哈希、示例占位符。 */
const ALLOWED = [
  /https:\/\/github\.com\/Mehael-Yeh\/pi-zh(\.git)?/,
  /https:\/\/pi\.dev/,
  /https:\/\/cli\.github\.com/,
  /https:\/\/claude\.ai\/settings\/usage/,
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/, // 公共仓库地址
  /^[0-9a-f]{40,64}$/, // 包文件哈希
];

const RULES = [
  { name: "本机绝对路径（Windows 用户目录）", re: /[A-Za-z]:\\+Users\\+[^\\\s"'`)]+/g },
  { name: "本机绝对路径（POSIX 家目录）", re: /\/home\/[A-Za-z0-9._-]+\//g },
  { name: "家目录字符串", re: new RegExp(escapeRe(home).replace(/\\\\/g, "[/\\\\]+"), "gi") },
  { name: "用户名出现", re: new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(userName)}(?![A-Za-z0-9_-])`, "g") },
  { name: "邮箱地址", re: /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}/g },
  { name: "私网 IP", re: /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/g },
  { name: "URL 内嵌凭证", re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi },
  { name: "常见 token 前缀", re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "password/secret 字面量", re: /\b(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/gi },
];

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const allowed = (text) => {
  // 占位符写法（\<用户名\>、$HOME、%USERPROFILE%）与公共链接/哈希不算泄露。
  if (/<[^<>]{1,20}>|\$HOME|%USERPROFILE%|~[\\/]/.test(text)) return true;
  return ALLOWED.some((re) => re.test(text));
};

const findings = [];
const scanText = (label, text) => {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      const value = match[0];
      if (allowed(value)) continue;
      findings.push({ where: label, rule: rule.name, value: value.length > 160 ? `${value.slice(0, 157)}...` : value });
    }
  }
};

/* ------------------------------------------------------- 1) 被跟踪的文件 -- */
const files = git("ls-files").split("\n").filter(Boolean);
const LARGE = 2 * 1024 * 1024;
const SUSPICIOUS_EXT = /\.(log|bak|zip|tar|gz|7z|sqlite|db|dmp|dump|tmp)$/i;
for (const file of files) {
  let size = 0;
  try { size = statSync(join(ROOT, file)).size; } catch { continue; }
  if (size > LARGE) findings.push({ where: file, rule: "大文件（>2MB）", value: `${Math.round(size / 1024)}KB` });
  if (SUSPICIOUS_EXT.test(file)) findings.push({ where: file, rule: "可疑文件类型（日志/备份/转储）", value: file });
  if (/\.(png|jpg|jpeg|gif|webp|pdf|woff2?|ttf)$/i.test(file)) continue; // 二进制内容跳过文本扫描
  let text = "";
  try { text = execFileSync("git", ["show", `HEAD:${file}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); } catch { continue; }
  scanText(file, text);
}

/* -------------------------------------------------------------- 2) 历史 -- */
if (withHistory) {
  const commits = git("rev-list", "--all").split("\n").filter(Boolean);
  const seen = new Set();
  for (const commit of commits) {
    const names = git("ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);
    for (const name of names) {
      if (/\.(png|jpg|jpeg|gif|webp|pdf|woff2?|ttf)$/i.test(name)) continue;
      let text = "";
      try { text = git("show", `${commit}:${name}`); } catch { continue; }
      const before = findings.length;
      scanText(`${commit.slice(0, 8)}:${name}`, text);
      for (let i = before; i < findings.length; i += 1) {
        const key = `${findings[i].rule}|${findings[i].value}`;
        if (seen.has(key)) findings.splice(i--, 1);
        else seen.add(key);
      }
    }
  }
}

/* --------------------------------------------------------------- 3) 输出 -- */
console.log(`仓库：${ROOT}`);
console.log(`扫描：${files.length} 个被跟踪文件${withHistory ? " + 全部提交历史" : "（未含历史，加 --history 可全量检查）"}`);
const byRule = new Map();
for (const f of findings) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, []);
  byRule.get(f.rule).push(f);
}
if (findings.length === 0) {
  console.log("未发现隐私或凭证泄露风险。");
  process.exit(0);
}
for (const [rule, list] of byRule) {
  console.log(`\n### ${rule}（${list.length}）`);
  for (const item of list.slice(0, 40)) console.log(`  ${item.where}  →  ${JSON.stringify(item.value)}`);
  if (list.length > 40) console.log(`  … 其余 ${list.length - 40} 条省略`);
}
process.exit(1);
