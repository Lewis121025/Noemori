<script lang="ts">
  import { renderMessageMedia } from "../shared/native-media";
  import type { AgentApi, MessageMedia } from "../shared/api";
  import ContentCard from "./ContentCard.svelte";
  import MediaPlayer from "./MediaPlayer.svelte";
  let {
    media,
    api,
    session = "",
    onInspect,
  }: {
    media: MessageMedia;
    api?: AgentApi | undefined;
    session?: string;
    onInspect?: (() => void) | undefined;
  } = $props();
  // 同一媒体的快照更新不重建 Blob，避免轮询时播放器和图片反复重置。
  const encoded = $derived(JSON.stringify(media));
  const resource = $derived.by(() => {
    try {
      const value: unknown = JSON.parse(encoded);
      return { value: renderMessageMedia(value), error: "" };
    } catch (cause) {
      return { value: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });
</script>

{#if resource.error}<p class="media-error" role="alert">{resource.error}</p>
{:else if resource.value?.type === "image"}<ContentCard
    source={{ type: "inline", file: resource.value.file, preview: resource.value.preview }}
    {api}
    {session}
    {onInspect}
  />
{:else if resource.value}<figure class="media-content">
    <figcaption>{resource.value.type === "audio" ? "音频" : "视频"}</figcaption>
    <MediaPlayer
      type={resource.value.type}
      mime={resource.value.mime}
      bytes={resource.value.file?.bytes}
      remote={resource.value.url ?? undefined}
      {onInspect}
    />
  </figure>{/if}

<style>
  .media-content {
    margin: 12px 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }
  figcaption {
    color: var(--muted);
    font-size: 11px;
    margin-bottom: 8px;
  }
  .media-error {
    margin: 8px 0;
    color: var(--danger);
    font-size: 12px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
</style>
