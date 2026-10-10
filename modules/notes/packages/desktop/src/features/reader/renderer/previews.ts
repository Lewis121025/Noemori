/**
 * PDF 预览的公开入口；来源与读取权限由调用方核验，组件只处理字节快照。
 * @param bytes 完整 PDF 内容，组件不读取工作区或文件路径。
 * @param compact 是否使用适合内嵌内容的紧凑工具栏，缺省为 false。
 * @param registerToolbar 可选工具栏注册回调；提供时由宿主展示，卸载时传入 null。
 * @returns 支持翻页和缩放的 PDF 预览；卸载时释放解析任务与绘制资源。
 * @throws 不向调用方抛出解析或绘制错误；失败在预览区显示。
 */
export { default as PdfPreview } from "./preview/PdfPreview.svelte";

/**
 * 图片预览的公开入口；来源与读取权限由调用方核验，组件只处理字节快照。
 * @param path 用于判断图片格式和提供替代文本的名称，不作为文件读取路径。
 * @param bytes 完整图片内容，组件独立管理其对象 URL。
 * @param registerToolbar 可选工具栏注册回调；提供时由宿主展示，卸载时传入 null。
 * @returns 支持缩放和拖动的图片预览；内容替换或卸载时释放对象 URL。
 * @throws 不向调用方抛出图片加载错误；失败在预览区显示。
 */
export { default as ImagePreview } from "./preview/ImagePreview.svelte";

/** 图表预览的公开入口；参数、结果与异常契约见共用 Mermaid 排版器。 */
export { renderMermaid } from "./markdown/views/mermaid";
/** 公式预览的公开入口；返回独立 CHTML 节点，非法 TeX 返回可见错误节点。 */
export { renderTex } from "./markdown/views/mathjax";
