<script lang="ts">
  let {
    type,
    mime,
    bytes,
    remote,
    onInspect,
  }: {
    type: "audio" | "video";
    mime: string;
    bytes?: Uint8Array | undefined;
    remote?: string | undefined;
    onInspect?: (() => void) | undefined;
  } = $props();
  let url = $state(""),
    loaded = $state(false),
    issue = $state("");
  $effect(() => {
    const data = bytes,
      address = remote;
    url = "";
    loaded = false;
    issue = "";
    if (data) {
      const created = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime }));
      url = created;
      loaded = true;
      return () => URL.revokeObjectURL(created);
    }
    url = address ?? "";
  });
</script>

<div class="media-player">
  {#if !loaded}<button
      type="button"
      onclick={() => {
        onInspect?.();
        loaded = true;
      }}>加载{type === "audio" ? "音频" : "视频"}</button
    >
  {:else if type === "audio"}<audio
      controls
      src={url}
      preload="metadata"
      onerror={() => (issue = "音频无法播放，文件可能损坏或编码不受支持。")}
    ></audio>
  {:else}<!-- 原始视频未提供字幕轨，保留播放控件与错误反馈，不生成虚假的字幕。 -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      controls
      src={url}
      preload="metadata"
      onerror={() => (issue = "视频无法播放，文件可能损坏或编码不受支持。")}
    ></video>{/if}
  {#if issue}<p role="alert">{issue}</p>{/if}
</div>

<style>
  .media-player {
    padding: 10px;
  }
  audio,
  video {
    display: block;
    width: 100%;
    max-height: min(60dvh, 32rem);
    border-radius: 8px;
  }
  button {
    border: 0;
    border-radius: 6px;
    padding: 6px 10px;
    color: var(--fg);
    background: var(--bg);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  p {
    margin: 8px 0;
    color: var(--danger);
    font-size: 12px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
</style>
