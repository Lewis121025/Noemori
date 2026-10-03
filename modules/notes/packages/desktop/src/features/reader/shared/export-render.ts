/** 隔离页面只处理宿主传入的内容，不获得磁盘、笔记库或网络能力。 */
export type ExportAnchor = { position: number; id: string };
/** 页面渲染的有限请求集合。 */
export type ExportRenderRequest =
  | { kind: "document"; doc: unknown; anchors: ExportAnchor[]; destinations?: string[] }
  | { kind: "mermaid"; source: string }
  | { kind: "raster"; source: string; scale: number }
  | { kind: "image"; source: string }
  | { kind: "pdf"; bytes: number[]; page: number }
  | { kind: "html"; source: string; inline: boolean }
  | { kind: "inlineHtml"; parent: unknown };
/** 图片响应携带尺寸用于像素预算复核；文档成功仅代表资源与布局已就绪。 */
export type ExportRenderReply =
  | { kind: "ready" }
  | { kind: "svg"; svg: string }
  | { kind: "image"; data: string; width: number; height: number }
  | { kind: "html"; doc: unknown };
