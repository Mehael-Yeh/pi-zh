import { readFileSync } from "node:fs";
import { thirdParty } from "./third-party.js";
import { installUiZh } from "./ui-zh.js";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

export function translateSuggestions(result: AutocompleteSuggestions | null, dictionary: Record<string, string>): AutocompleteSuggestions | null {
  if (!result || !result.prefix.startsWith("/") || /\s/.test(result.prefix)) return result;
  return {
    ...result,
    items: result.items.map((item) => {
      // Pi returns bare command names; never alter values or labels.
      const name = item.value.replace(/^\//, "");
      const chinese = dictionary[name] ?? (name.startsWith("skill:") ? dictionary[name.slice(6)] ?? dictionary["skill:"] : undefined);
      if (!chinese || item.description?.includes(chinese)) return item;
      return { ...item, description: item.description ? `${chinese} · ${item.description}` : chinese };
    }),
  };
}

export function wrapProvider(provider: AutocompleteProvider, dictionary: Record<string, string>): AutocompleteProvider {
  return {
    triggerCharacters: provider.triggerCharacters,
    async getSuggestions(...args) {
      return translateSuggestions(await provider.getSuggestions(...args), dictionary);
    },
    applyCompletion: (...args) => provider.applyCompletion(...args),
    ...(provider.shouldTriggerFileCompletion ? {
      shouldTriggerFileCompletion: (...args: Parameters<NonNullable<AutocompleteProvider["shouldTriggerFileCompletion"]>>) => provider.shouldTriggerFileCompletion!(...args),
    } : {}),
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // PI_UI_ZH_FORCE=1 是诊断开关：非 TUI 模式下也安装（只写日志，不改界面）。
    if (ctx.mode !== "tui" && process.env.PI_UI_ZH_FORCE !== "1") return;
    installCommandMenu(ctx);
    installUi(ctx);
  });
}

/** 命令菜单（斜杠命令补全）中文说明。 */
function installCommandMenu(ctx: ExtensionContext): void {
  try {
    const dictionary: unknown = JSON.parse(readFileSync(new URL("./translations.json", import.meta.url), "utf8"));
    if (!dictionary || typeof dictionary !== "object" || Array.isArray(dictionary) ||
        !Object.values(dictionary).every((value) => typeof value === "string")) {
      throw new Error("translations.json 必须是命令名称到中文说明的对象");
    }
    if (typeof ctx.ui.setEditorComponent !== "function" || typeof CustomEditor.prototype.setAutocompleteProvider !== "function") {
      throw new Error("当前 Pi 不支持所需的编辑器接口");
    }
    class ChineseCommandEditor extends CustomEditor {
      override setAutocompleteProvider(provider: AutocompleteProvider): void {
        super.setAutocompleteProvider(wrapProvider(provider, { ...thirdParty, ...dictionary as Record<string, string> }));
      }
    }
    ctx.ui.setEditorComponent((tui, theme, kb) => new ChineseCommandEditor(tui, theme, kb));
  } catch (error) {
    ctx.ui.notify(`命令菜单汉化未启用：${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

/** 内置界面（设置、主题、模型、思考级别…）中文注释。设置 PI_UI_ZH=0 可临时关闭，PI_UI_ZH_LOG=0 关闭诊断日志。 */
function installUi(ctx: ExtensionContext): void {
  if (process.env.PI_UI_ZH === "0" || process.env.PI_UI_ZH === "off") return;
  void installUiZh({ piRoot: process.env.PI_UI_ZH_ROOT, context: `mode=${ctx.mode} argv1=${process.argv[1] ?? "?"} cwd=${process.cwd()}` }).then((result) => {
    // /reload 重装时 patched 为空是正常的（包裹被换成新实现，计入 already）；
    // 只有“一处都没装上、也没有旧包裹可替换”才是真的失败，必须让用户看到。
    if (result.patched.length === 0 && result.already === 0) {
      ctx.ui.notify("界面汉化未生效：没有找到可打补丁的界面类（详见扩展目录 ui-zh.log）", "warning");
    }
  }).catch((error: unknown) => {
    ctx.ui.notify(`界面汉化未启用：${error instanceof Error ? error.message : String(error)}`, "warning");
  });
}
