import { readFileSync } from "node:fs";
import { thirdParty } from "./third-party.js";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
    if (ctx.mode !== "tui") return;
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
  });
}
