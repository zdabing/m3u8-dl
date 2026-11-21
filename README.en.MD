# M3U8 Downloader

A media downloader with a desktop and mobile WebUI, based on [lzwme/m3u8-dl](https://github.com/lzwme/m3u8-dl).

- HLS downloads, AES-128 decryption and FFmpeg merging.
- Direct media and subtitle downloads, including MP4, VTT and SRT.
- Web media extraction and selected platform link parsing.
- Batch queues, pause/resume and retry.
- ScriptCat integration to send media URLs, request information, page titles and source pages.
- WebUI, CLI and SDK.

## Run

Requires Node.js 22.12+, pnpm and FFmpeg.

```sh
pnpm install
pnpm build
pnpm start
```

Open `http://localhost:6600`. Files are saved to `./downloads`.

For Docker, create `.env` with `DS_SECRET=your-password`, then run:

```sh
docker compose -f docker/docker-compose.yml up --build -d
```

Open `http://SERVER-IP:6600`. Docker files and cache are stored in `docker/downloads` and `docker/cache`.

Install the ScriptCat script from the homepage, configure your downloader address and password, then select media on the playback page to send. Short-lived tokens may expire; continuous token renewal through ScriptCat is not implemented. Extraction depends on the source website.

CLI: `node bin/m3u8dl.js --help`. More information: [中文说明](README.MD).

MIT license. See [LICENSE](LICENSE).
