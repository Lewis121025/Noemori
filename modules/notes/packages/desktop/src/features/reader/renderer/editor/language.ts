/**
 * 按文件名加载 CodeMirror 语言扩展。
 */
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

/**
 * 根据库内相对路径选择高亮语言。
 *
 * @param path 库内相对路径（用文件名匹配扩展名）。
 * @returns 语言扩展；无法识别或语言包加载失败时为空数组，编辑器按纯文本工作。
 */
export async function languageExtensions(path: string): Promise<Extension[]> {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  const matched = LanguageDescription.matchFilename(languages, name);
  if (matched === null) {
    return [];
  }
  try {
    return [await matched.load()];
  } catch {
    return [];
  }
}
