/** Shared cancellation and duplicate protection for HLS and direct files. */
export const activeDownloads = new Map<string, AbortController>();
