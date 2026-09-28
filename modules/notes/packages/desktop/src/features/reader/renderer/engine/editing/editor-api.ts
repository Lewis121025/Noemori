/**
 * 编辑器挂载后向外暴露的文本读取与交互入口。
 * 外壳保存时向活动表面取文本，不把 ProseMirror / CodeMirror 实例抬到 App。
 */
import type {
  HistoryAction,
  HistoryAvailability,
  MentionRecord,
  SearchLocation,
} from "../../../shared/api";
import type { EditorSnapshot } from "../markdown/source-session";
import type { EditorPositionApi } from "./editor-position";

/** 两种文本表面的公共契约；导航只依赖快照、定位与交互能力，不依赖具体编辑器。 */
export type TextEditorApi = EditorPositionApi & {
  /** 操作所属文档的历史；焦点属于普通输入框时返回 false，由输入框处理。 */
  history: (action: HistoryAction) => boolean;
  /** 响应式读取历史可用性；焦点属于普通输入框时返回 null。 */
  historyAvailability: () => HistoryAvailability | null;
  /** 将键盘焦点交给文本表面，保留已有选区。 */
  focus: () => void;
  /** 打开文内查找并聚焦查询输入，不改变文档选区。 */
  openSearch: () => void;
  /** 获取当前内容的字节快照与修订号，保留源码格式；无法安全映射时抛错。 */
  snapshot: () => EditorSnapshot;
  /**
   * 选中经过内容哈希核对的搜索范围；编辑版本变化或无法精确映射时抛错，保留原选区。
   * @param location 索引返回的 UTF-8 范围。
   * @param snapshot 导航器已核对内容哈希的编辑快照。
   */
  jumpToSearch: (location: SearchLocation, snapshot: EditorSnapshot) => void;
};

/**
 * Markdown 文档表面：普通正文和就地源码共用历史，支持附件、大纲与引用导航。
 * 重复打开查找时保留已有查询词，便于连续阅读与编辑。
 */
export type MarkdownEditorApi = TextEditorApi & {
  /** 从当前文档选区打开附件选择器，取消不改动正文。 */
  openAttachments: () => void;
  /** 等待附件导入与引用插入；失败返回 false，必须先重试或关闭失败提示。 */
  settleAttachments: () => Promise<boolean>;
  /** 把选区移到标题内，并把该标题滚到阅读区顶部。 */
  jumpTo: (pos: number) => void;
  /**
   * 跳到入链/未链接命中。
   *
   * @param mention 提及记录。
   * @param occurrence 同一文件里同类命中的次序（从 1 计）。
   */
  jumpToMention: (mention: MentionRecord, occurrence: number) => void;
  /**
   * 按标题锚点或 `^` 块引用跳转：对齐到阅读区顶部，与大纲跳转一致。
   *
   * @param anchor 标题原文，或以 `^` 开头的块标识。标题匹配忽略大小写；块标识按原文精确匹配。
   * @returns 是否找到并跳转；调用方据此提示锚点失效。
   */
  jumpToHeading: (anchor: string) => boolean;
  /** 选区所在章节的标题文本（大纲同一口径）；选区在首个标题之前时为 `null`。 */
  currentHeading: () => string | null;
};

/** 代码表面：快照保留原始换行，并支持源码字节位置跳转。 */
export type CodeEditorApi = TextEditorApi & {
  /**
   * 把光标移到 UTF-8 字节对应的位置。
   *
   * @param byteOffset 源文件 UTF-8 字节下标。
   */
  jumpToByte: (byteOffset: number) => void;
};
