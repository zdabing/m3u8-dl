# Lightweight M3U8 downloader

A focused fork of [lzwme/m3u8-dl](https://github.com/lzwme/m3u8-dl): HLS/direct-file download, share-link parsing, web media extraction, resume, lossless merge, and a responsive Chinese WebUI. The embedded player/browser, search sites, capture userscript, AriaNg and Electron packages remain removed.

Douyin, Weibo and Pipixia share links automatically select a platform parser; Weibo requires a valid Cookie. The WebUI's extraction mode accepts up to 20 pages/share links and supports 0–3 levels of same-origin links and player iframes, with selectable batch results. Each extraction is bounded by 30 pages, 100 results, 5 MB per decoded page and 60 seconds. Remote scripts are never executed. Platform/login changes can prevent parsing, and watermark-free output depends on the source response. SDK exports include `VideoParser`, `getM3u8Urls` and structured `extractMedia`; the CLI provides `extract <urls...> --depth 2`. Source credentials are stripped when visiting another origin or downloading from a CDN.

Direct media and subtitle files (including MP4 and VTT) are supported in the same queue. Auto mode detects common media/subtitle extensions from the URL path; use `-T file` or the WebUI file mode for extensionless URLs, and `-T m3u8` for playlists disguised as media files. Files stream to disk unchanged, with progress, cancellation and validated Range resume when supported. VTT remains a separate subtitle file. The SDK exports `downloadResource` and `fileDownload`; batch downloads accept mixed links. Task selection supports batch pause, resume/retry and confirmed removal on desktop and mobile.

Requires Node.js 22.12+, pnpm, and preferably FFmpeg on PATH.

```sh
pnpm install
pnpm build
pnpm start
```

Open http://localhost:6600. Automatic browser User-Agent and same-origin Referer are sent for manifests, keys and fragments. Custom headers override defaults; configure the actual source page or Cookie if needed. Both line-based headers and JSON are accepted. Disguised extensions are supported.

Merging uses streaming input, bounded memory, one asynchronous FFmpeg process at a time, progress reporting, cancellation and a configurable idle timeout. Failed or cancelled merges preserve caches; only completed output is published. Without FFmpeg, TS is concatenated to `.ts` and fMP4 is joined with its initialization segment.

CLI: `node bin/m3u8dl.js --help`. Server: `pnpm start`. Data lives in `~/.m3u8-dl/cache`, videos in `./downloads`. Set `DS_SECRET` for access control. Environment variables and further details: [中文文档](README.MD).

Checks: `pnpm test`, `pnpm lint:all`, `pnpm typecheck`, `pnpm build`. MIT license.
