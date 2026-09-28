/**
 * 图片 NodeView：打开时把 src 解析成可加载 URL，滚动不再卸载。
 * 加载只改 this.dom，不 dispatch；失败时留下 alt。
 */
import type { Node as PmNode } from "prosemirror-model";
import type { EditorView, NodeView, NodeViewConstructor } from "prosemirror-view";
import type { MediaKind } from "../media/media";

type LoadMedia = (src: string, kind: MediaKind) => Promise<string | null>;

class ImageNodeView implements NodeView {
  readonly dom: HTMLImageElement;
  private src: string;
  private alt: string;
  private title: string | null;
  private readonly kind: MediaKind;
  private objectUrl: string | null = null;
  private loadedSrc: string | null = null;
  private loadGen = 0;

  constructor(
    node: PmNode,
    _view: EditorView,
    _getPos: () => number | undefined,
    private readonly loadMedia: LoadMedia,
  ) {
    this.src = String(node.attrs["src"] ?? "");
    this.alt = String(node.attrs["alt"] ?? "");
    const title = node.attrs["title"];
    this.title = typeof title === "string" && title !== "" ? title : null;
    this.kind = node.attrs["kind"] === "wiki" ? "wiki" : "md";
    this.dom = document.createElement("img");
    this.dom.className = "note-image";
    this.dom.alt = this.alt;
    if (this.title !== null) {
      this.dom.title = this.title;
    }
    this.dom.dataset.imageSrc = this.src;
    this.dom.dataset.imageKind = this.kind;
    this.dom.contentEditable = "false";
    this.dom.style.minWidth = "1.5rem";
    this.dom.style.minHeight = "1.5rem";
    this.startLoad();
  }

  update(node: PmNode): boolean {
    if (node.type.name !== "image") {
      return false;
    }
    const nextSrc = String(node.attrs["src"] ?? "");
    const nextAlt = String(node.attrs["alt"] ?? "");
    const title = node.attrs["title"];
    const nextTitle = typeof title === "string" && title !== "" ? title : null;
    const nextKind = node.attrs["kind"] === "wiki" ? "wiki" : "md";
    if (nextKind !== this.kind) {
      return false;
    }
    this.alt = nextAlt;
    this.title = nextTitle;
    this.dom.alt = nextAlt;
    if (nextTitle === null) {
      this.dom.removeAttribute("title");
    } else {
      this.dom.title = nextTitle;
    }
    if (nextSrc !== this.src) {
      this.src = nextSrc;
      this.dom.dataset.imageSrc = nextSrc;
      this.startLoad();
    }
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.loadGen += 1;
    this.revoke();
  }

  private startLoad(): void {
    if (this.loadedSrc === this.src) {
      return;
    }
    const gen = ++this.loadGen;
    this.revoke();
    this.loadedSrc = null;
    this.dom.removeAttribute("src");
    const requested = this.src;
    void this.loadMedia(requested, this.kind).then((url) => {
      if (gen !== this.loadGen) {
        if (url !== null && url.startsWith("blob:")) {
          URL.revokeObjectURL(url);
        }
        return;
      }
      if (url === null) {
        return;
      }
      if (url.startsWith("blob:")) {
        this.objectUrl = url;
      }
      this.dom.style.removeProperty("min-width");
      this.dom.style.removeProperty("min-height");
      this.loadedSrc = requested;
      this.dom.src = url;
    });
  }

  private revoke(): void {
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

/**
 * 行内图片 NodeView。
 *
 * @param loadMedia 把节点 src 变成可加载 URL。
 */
export function createImageNodeViews(loadMedia: LoadMedia): Record<string, NodeViewConstructor> {
  return {
    image: (node, view, getPos) => new ImageNodeView(node, view, getPos, loadMedia),
  };
}
