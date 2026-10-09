<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { tableInsertLimits, validTableInsertOptions, type TableInsertOptions } from "./table";
  import { createCompositionGuard } from "../../../shared/composition";

  let {
    id,
    onInsert,
    onClose,
  }: {
    id: string;
    /** 确认配置后由所属编辑器执行插入；错误抛回浮层，保留配置供修正。 */
    onInsert: (options: TableInsertOptions) => void;
    /** 关闭时释放插入书签；显式取消或确认才把焦点交回正文。 */
    onClose: (restoreFocus: boolean) => void;
  } = $props();
  let popover: HTMLDivElement;
  let grid: HTMLButtonElement;
  let opened = $state(false);
  let rows = $state<number | undefined>(3);
  let columns = $state<number | undefined>(3);
  let align = $state<TableInsertOptions["align"]>("left");
  let preview = $state<{ rows: number; columns: number } | null>(null);
  let error = $state("");
  let restoreFocus = false;
  let anchor: HTMLButtonElement | null = null;
  let previousAnchor = "";
  const instanceId = $props.id();
  const anchorName = `--table-insert-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const composition = createCompositionGuard();
  const options = $derived<TableInsertOptions>({
    rows: rows ?? NaN,
    columns: columns ?? NaN,
    align,
  });
  const valid = $derived(validTableInsertOptions(options));
  const visible = $derived(preview ?? options);
  const cells = Array.from({ length: 48 }, (_, index) => ({
    row: Math.floor(index / 8) + 1,
    column: (index % 8) + 1,
  }));
  const alignments = [
    { value: "left", label: "左对齐", path: "M4 6h16M4 10h10M4 14h16M4 18h10" },
    { value: "center", label: "居中", path: "M4 6h16M7 10h10M4 14h16M7 18h10" },
    { value: "right", label: "右对齐", path: "M4 6h16M10 10h10M4 14h16M10 18h10" },
  ] as const;

  /**
   * 从所属工具栏打开尺寸浮层；打开和预览不会执行插入。
   * @param source 提供原生锚点的工具栏按钮。
   * @returns 无返回值；浮层打开后聚焦网格，支持直接使用方向键。
   * @throws 原生浮层不可用时沿用浏览器异常，不降级为无锚点浮层。
   */
  export function open(source: HTMLButtonElement): void {
    preview = null;
    error = "";
    restoreFocus = false;
    // 独立 CSS 锚点保留插入按钮已有的菜单关系，各分栏的浮层不会共享锚点。
    anchor = source;
    previousAnchor = source.style.getPropertyValue("anchor-name");
    source.style.setProperty("anchor-name", anchorName);
    popover.style.setProperty("position-anchor", anchorName);
    popover.showPopover();
    void tick().then(() => {
      if (opened && grid.isConnected) grid.focus();
    });
  }

  /**
   * 关闭浮层并释放插入上下文，不修改正文。
   * @param focus 显式取消或确认时交回正文焦点；系统轻触关闭使用 false。
   * @returns 无返回值；输入法组词期间保留浮层，不中断输入。
   */
  export function close(focus = false): void {
    if (!opened || composition.active) return;
    restoreFocus = focus;
    if (popover.isConnected) popover.hidePopover();
    else {
      opened = false;
      releaseAnchor();
      onClose(focus);
    }
  }

  function releaseAnchor(): void {
    if (!anchor) return;
    if (previousAnchor) anchor.style.setProperty("anchor-name", previousAnchor);
    else anchor.style.removeProperty("anchor-name");
    anchor = null;
  }

  function choose(row: number, column: number): void {
    rows = row;
    columns = column;
    preview = null;
    error = "";
  }
  function cellAt(event: PointerEvent | MouseEvent): { rows: number; columns: number } | null {
    if (!(event.target instanceof Element)) return null;
    const cell = event.target.closest<HTMLElement>("[data-table-rows][data-table-columns]");
    return cell
      ? { rows: Number(cell.dataset["tableRows"]), columns: Number(cell.dataset["tableColumns"]) }
      : null;
  }
  function gridKeydown(event: KeyboardEvent): void {
    if (
      event.isComposing ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const nextRows =
      (rows ?? 3) + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0);
    const nextColumns =
      (columns ?? 3) + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0);
    choose(
      Math.max(1, Math.min(tableInsertLimits.rows, nextRows)),
      Math.max(1, Math.min(tableInsertLimits.columns, nextColumns)),
    );
  }
  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (!valid || composition.active) return;
    try {
      onInsert(options);
      close(true);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  onDestroy(() => {
    releaseAnchor();
    onClose(false);
  });
</script>

<div
  {id}
  bind:this={popover}
  class="reader-popover table-insert-picker"
  popover="auto"
  role="dialog"
  aria-label="插入表格"
  tabindex="-1"
  onbeforetoggle={(event) => {
    opened = event.newState === "open";
    if (!opened) {
      preview = null;
      releaseAnchor();
      onClose(restoreFocus);
      restoreFocus = false;
    }
  }}
  onkeydown={(event) => {
    if (event.key !== "Escape" || event.isComposing || composition.active) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }}
>
  <form onsubmit={submit} use:composition.bind>
    <header>
      <h2>插入表格</h2>
      <button
        class="reader-button icon-button"
        type="button"
        aria-label="关闭表格设置"
        onclick={() => close(true)}
      >
        <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="m6 6 12 12M18 6 6 18" /></svg
        >
      </button>
    </header>
    <output aria-live="polite"
      >{valid || preview ? `${visible.columns} 列 × ${visible.rows} 行` : "选择表格尺寸"}</output
    >
    <button
      bind:this={grid}
      class="table-size-picker"
      type="button"
      aria-label="选择表格尺寸：{valid ? `${columns} 列 ${rows} 行` : '未选择'}，方向键调整"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
      onpointerover={(event) => {
        if (event.pointerType === "mouse") preview = cellAt(event);
      }}
      onpointerleave={() => (preview = null)}
      onclick={(event) => {
        const cell = cellAt(event);
        if (cell) choose(cell.rows, cell.columns);
      }}
      onkeydown={gridKeydown}
    >
      {#each cells as cell (cell.row * 8 + cell.column)}
        <span
          class:selected={cell.row <= visible.rows && cell.column <= visible.columns}
          data-table-rows={cell.row}
          data-table-columns={cell.column}
          aria-hidden="true"
        ></span>
      {/each}
    </button>
    <div class="alignment-row">
      <span>列对齐</span>
      <div role="group" aria-label="列对齐">
        {#each alignments as alignment (alignment.value)}
          <button
            class="reader-button icon-button"
            type="button"
            aria-label={alignment.label}
            title={alignment.label}
            aria-pressed={align === alignment.value}
            onclick={() => (align = alignment.value)}
          >
            <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
              ><path d={alignment.path} /></svg
            >
          </button>
        {/each}
      </div>
    </div>
    <p class="header-note">首行为表头，计入行数</p>
    <details>
      <summary>精确尺寸</summary>
      <div class="dimensions">
        <label
          >列数<input
            class="reader-input"
            aria-label="列数"
            type="number"
            min="1"
            max={tableInsertLimits.columns}
            step="1"
            required
            bind:value={columns}
          /></label
        >
        <label
          >行数（含表头）<input
            class="reader-input"
            aria-label="行数（含表头）"
            type="number"
            min="1"
            max={tableInsertLimits.rows}
            step="1"
            required
            bind:value={rows}
          /></label
        >
      </div>
    </details>
    {#if !valid}<p class="error" role="alert">
        行数须为 1–{tableInsertLimits.rows}、列数须为 1–{tableInsertLimits.columns} 的整数。
      </p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <button
        class="reader-button"
        type="button"
        aria-label="取消插入表格"
        onclick={() => close(true)}>取消</button
      >
      <button class="reader-button primary" type="submit" aria-label="插入表格" disabled={!valid}
        >插入表格</button
      >
    </footer>
  </form>
</div>

<style>
  .table-insert-picker {
    width: 260px;
    padding: 12px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 500;
  }
  output {
    display: block;
    margin-bottom: 10px;
    font-size: 12px;
    font-weight: 500;
  }
  .table-size-picker {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    grid-template-rows: repeat(6, 1fr);
    gap: 4px;
    width: 100%;
    height: 140px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  .table-size-picker span {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--surface);
  }
  .table-size-picker span.selected {
    border-color: var(--accent);
    background: var(--selected);
  }
  .table-size-picker:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .alignment-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    gap: 8px;
  }
  .alignment-row > span,
  .header-note,
  summary,
  label {
    font-size: 12px;
    color: var(--muted);
  }
  .alignment-row > div {
    display: flex;
    gap: 2px;
  }
  .header-note {
    margin: 6px 0 10px;
  }
  details {
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  summary {
    cursor: pointer;
  }
  .dimensions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 10px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  input {
    width: 100%;
  }
  .error {
    color: var(--danger);
    font-size: 12px;
    margin: 10px 0 0;
  }
  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 12px;
  }
  footer button {
    font-size: 12px;
  }
</style>
