# Lightweight M3U8 downloader

A focused fork of [lzwme/m3u8-dl](https://github.com/lzwme/m3u8-dl): HLS download, resume, lossless merge, and a responsive Chinese WebUI. The embedded player, platform parsers, browser, search, capture userscript, AriaNg and Electron packages have been removed.

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
