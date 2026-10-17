import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Spawn without a shell. Consume stderr continuously and retain only a small tail. */
export async function runMediaProcess(
  binary: string,
  args: string[],
  input: Readable,
  options: {
    signal?: AbortSignal;
    idleTimeout: number;
    onProgress?: (line: string) => boolean;
  }
) {
  options.signal?.throwIfAborted();
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let lineBuffer = '';
  let lastActivity = Date.now();
  let failure: Error;
  let forceKill: NodeJS.Timeout;
  const terminate = (error: Error) => {
    if (failure) return;
    failure = error;
    child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
    forceKill.unref();
  };
  const abort = () => terminate(new Error('合并已暂停'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const watchdog = setInterval(
    () => {
      if (Date.now() - lastActivity > options.idleTimeout * 1000)
        terminate(new Error(`合并连续 ${options.idleTimeout} 秒无进展，已停止。分片缓存已保留，可重试或调整超时。`));
    },
    Math.min(1000, Math.max(25, options.idleTimeout * 100))
  );
  const activity = () => {
    lastActivity = Date.now();
  };
  input.on('data', activity);
  child.stdout.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) if (options.onProgress?.(line)) activity();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_384);
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? -1));
  });
  // Register rejection handlers immediately, including when the process cannot spawn.
  const feeding = pipeline(input, child.stdin, { signal: options.signal }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE' && !options.signal?.aborted) terminate(error);
    return error as Error;
  });
  try {
    const code = await exited;
    const feedError = await feeding;
    options.signal?.throwIfAborted();
    if (failure) throw failure;
    if (code !== 0) throw new Error(`FFmpeg 合并失败（退出码 ${code}）: ${stderr.trim() || '未返回错误详情'}`);
    if (feedError) throw feedError;
  } finally {
    clearInterval(watchdog);
    clearTimeout(forceKill);
    options.signal?.removeEventListener('abort', abort);
    input.removeListener('data', activity);
    input.destroy();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await feeding;
  }
}
