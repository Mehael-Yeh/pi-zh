/**
 * pi-zh —— Pi 命令菜单与内置界面中文汉化扩展（入口）。
 *
 * 只做装配，两件事各自独立容错：
 *   1. 命令菜单汉化（lib/command-menu.ts）：斜杠命令补全的说明文字；
 *   2. 界面汉化（lib/ui-zh.ts）：设置、主题、模型、思考级别、/hotkeys 等内置界面。
 *
 * 环境变量：PI_UI_ZH=0|off 关闭界面汉化；PI_UI_ZH_LOG=0 关闭诊断日志；
 *           PI_UI_ZH_ROOT=<包目录> 指定 Pi 安装位置；PI_UI_ZH_FORCE=1 在非 TUI 模式下也安装（仅诊断）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installCommandMenu } from "./lib/command-menu.js";
import { installUiZh } from "./lib/ui-zh.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" && process.env.PI_UI_ZH_FORCE !== "1") return;
    installCommandMenu(ctx);
    installUi(ctx);
  });
}

/** 内置界面（设置、主题、模型、思考级别…）中文注释。 */
function installUi(ctx: ExtensionContext): void {
  if (process.env.PI_UI_ZH === "0" || process.env.PI_UI_ZH === "off") return;
  // 主题单例既不是包导出的，也不是 chunk 能拿到的，只能从 ctx.ui.theme 取。
  let liveTheme: unknown;
  try {
    liveTheme = ctx.ui.theme;
  } catch {
    liveTheme = undefined;
  }
  void installUiZh({
    piRoot: process.env.PI_UI_ZH_ROOT,
    liveTheme,
    context: `mode=${ctx.mode} argv1=${process.argv[1] ?? "?"} cwd=${process.cwd()}`,
  }).then((result) => {
    // /reload 重装时 patched 为空是正常的（包裹被换成新实现，计入 already）；
    // 只有“一处都没装上、也没有旧包裹可替换”才是真的失败，必须让用户看到。
    if (result.patched.length === 0 && result.already === 0) {
      ctx.ui.notify("界面汉化未生效：没有找到可打补丁的界面类（详见扩展目录 ui-zh.log）", "warning");
    }
  }).catch((error: unknown) => {
    ctx.ui.notify(`界面汉化未启用：${error instanceof Error ? error.message : String(error)}`, "warning");
  });
}
