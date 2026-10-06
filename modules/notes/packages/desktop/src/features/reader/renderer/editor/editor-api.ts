/**
 * 编辑器挂载后向外暴露的文本读取与交互入口。
 * 外壳保存时向活动表面取文本，不把 ProseMirror / CodeMirror 实例抬到 App。
 */
import type {
  HistoryAction,
  HistoryAvailability,
  MentionRecord,
  SearchLocation,
} from "../../shared/api";
import type { EditorSnapshot } from "../markdown/source-session";
import type { EditorPositionApi } from "./editor-position";

/** 所有可编辑表面共有的保存与历史契约，不要求内容具有文本位置。 */
type ContentEditorApi = {
  /** 操作所属文档的历史；焦点属于普通输入框时返回 false，由输入框处理。 */
  history: (action: HistoryAction) => boolean;
  /** 响应式读取历史可用性；焦点属于普通输入框时返回 null。 */
  historyAvailability: () => HistoryAvailability | null;
  /** 将键盘焦点交给当前内容表面，保留已有选区。 */
  focus: () => void;
  /** 获取当前内容的字节快照与修订号；无法安全序列化时抛错，不生成替代内容。 */
  snapshot: () => EditorSnapshot;
};

/** 白板只提供内容快照与历史，不伪造文本搜索或源码位置能力。 */
export type WhiteboardEditorApi = ContentEditorApi & {
  /** 离开文档前把尚未抬笔的输入提交为完整事务；失败抛出并阻止离开。 */
  finishInput: () => void;
  /** 后台刷新等待当前指针事务结束或取消，不强制提交；卸载时也必须释放等待。 */
  waitForInput: () => Promise<void>;
};

/** 文本表面额外提供源码位置和查找，不将具体编辑器实例暴露给导航。 */
export type TextEditorApi = ContentEditorApi &
  EditorPositionApi & {
    /** 打开文内查找并聚焦查询输入，不改变文档选区。 */
    openSearch: () => void;
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
  /** 在当前正文位置创建独立白板并插入引用，复用附件异步插入与保存门禁。 */
  insertWhiteboard: () => void;
  /** 从当前正文选区打开网页插入对话框，取消不修改文档。 */
  insertWebPage: () => void;
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
  /** 当前滚动视口的章节位置，不使用编辑选区；同名标题仍可区分。 */
  visibleHeading: () => number | null;
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
