<script setup lang="ts">
import type { ApiResponse, SegmentSnapshot, ServerConfig, TaskItem } from '@lzwme/m3u8-dl/contract';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';

const tasks = ref<Record<string, TaskItem>>({});
const connection = ref<'connecting' | 'online' | 'offline'>('connecting');
const loading = ref(true);
const tab = ref<'active' | 'done' | 'error'>('active');
const search = ref('');
const busy = ref(false);
const pending = reactive(new Set<string>());
const notice = ref('');
const noticeError = ref(false);
const formError = ref('');
const modalError = ref('');
const modalBusy = ref(false);
const urls = ref('');
const title = ref('');
const source = ref('');
const headers = ref('');
const advanced = ref(false);
const settingsOpen = ref(false);
const newDownloadOpen = ref(false);
const detailsUrl = ref('');
const detailsTask = computed(() => tasks.value[detailsUrl.value]);
const segments = ref<SegmentSnapshot>({ fingerprint: '', items: [] });
const segmentLoading = ref(false);
const segmentError = ref('');
const segmentFilter = ref<'all' | 'done' | 'error' | 'pending'>('all');
const segmentPage = ref(1);
const selectedSegment = ref<number | null>(null);
let segmentTimer: ReturnType<typeof setInterval>;
const segmentCounts = computed(() => ({ done: segments.value.items.filter(item => item.status === 'done').length, error: segments.value.items.filter(item => item.status === 'error').length, pending: segments.value.items.filter(item => item.status === 'pending' || item.status === 'downloading').length }));
const filteredSegments = computed(() => segments.value.items.filter(item => segmentFilter.value === 'all' || (segmentFilter.value === 'pending' ? ['pending', 'downloading'].includes(item.status) : item.status === segmentFilter.value)));
const pageSegments = computed(() => filteredSegments.value.slice((segmentPage.value - 1) * 100, segmentPage.value * 100));
const segmentPages = computed(() => Math.max(1, Math.ceil(filteredSegments.value.length / 100)));
const inspectedSegment = computed(() => segments.value.items.find(item => item.index === selectedSegment.value));
const segmentLabels = { pending: '未完成', downloading: '下载中', done: '已完成', error: '下载失败' };
watch(() => detailsTask.value?.status, (status, previous) => { if (detailsUrl.value && previous && status !== previous) void loadSegments(); });

const loginOpen = ref(false);
const editTask = ref<TaskItem | null>(null);
const editHeaders = ref('');
const removeTask = ref<TaskItem | null>(null);
const removeFile = ref(false);
const removeCache = ref(true);
const password = ref('');
const token = ref(sessionStorage.getItem('m3u8-token') || localStorage.getItem('token') || '');
const inputRef = ref<HTMLTextAreaElement>();
const modalRef = ref<HTMLDialogElement>();
const config = reactive<ServerConfig>({ saveDir: './downloads', threadNum: 4, maxDownloads: 2, delCache: true, ffmpegPath: '', headers: '', mergeTimeout: 180, proxyMode: 'system', proxyUrl: '', noProxy: '' });
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout>;
let noticeTimer: ReturnType<typeof setTimeout>;
let stopped = false;
const all = computed(() => Object.values(tasks.value));
const active = computed(() => all.value.filter(task => task.status !== 'done'));
const complete = computed(() => all.value.filter(task => task.status === 'done'));
const failedSegmentTasks = computed(() => active.value.filter(task => task.status === 'error' && task.tsFailed && task.hasSegmentDetails));
const errors = computed(() => active.value.filter(task => task.status === 'error').length);
const running = computed(() => active.value.filter(task => task.status === 'resume').length);
const speed = computed(() => active.value.reduce((sum, task) => sum + (task.status === 'resume' ? task.speed || 0 : 0), 0));
const visible = computed(() => (tab.value === 'done' ? complete.value : tab.value === 'error' ? active.value.filter(task => task.status === 'error') : active.value)
  .filter(task => `${name(task)} ${task.url}`.toLowerCase().includes(search.value.toLowerCase()))
  .sort((a, b) => (b.startTime || 0) - (a.startTime || 0)));
const modalOpen = computed(() => newDownloadOpen.value || !!detailsUrl.value || settingsOpen.value || loginOpen.value || !!editTask.value || !!removeTask.value);
const lines = computed(() => urls.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
const originHint = computed(() => { try { return `${new URL(lines.value[0]).origin}/`; } catch { return '自动使用资源域名'; } });
function bytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][index]}`;
}
function host(url: string) { try { return new URL(url).hostname; } catch { return url; } }
function name(task: TaskItem) {
  const filename = task.filename || task.options?.filename || '';
  return /^[a-f\d]{32}\.mp4$/.test(filename) || !filename ? `视频 · ${host(task.url)}` : filename;
}
function label(task: TaskItem) {
  if (task.status === 'done') return '已完成';
  if (task.status === 'pause') return '已暂停';
  if (task.status === 'error') return '需要重试';
  if (task.status === 'pending') return '排队中';
  return task.phase === 'merging' ? '正在合并' : task.phase === 'parsing' ? '解析链接' : '下载中';
}
function progress(task: TaskItem) { return task.status === 'done' ? 100 : task.phase === 'merging' ? task.mergeProgress || 0 : Math.min(99, task.progress || 0); }
function notify(message: string, error = false) {
  notice.value = message; noticeError.value = error; clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 5000);
}
async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: token.value },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json() as ApiResponse<T>;
  if (response.status === 401) { loginOpen.value = true; await openModal(); }
  if (!response.ok || result.code) throw new Error(result.message || '请求失败，请重试');
  return result.data as T;
}
async function load() {
  try {
    const [items, settings] = await Promise.all([api<Record<string, TaskItem>>('tasks'), api<ServerConfig>('config')]);
    tasks.value = items; Object.assign(config, settings); loginOpen.value = false;
  } catch (error) { if (!loginOpen.value) notify((error as Error).message, true); }
  finally { loading.value = false; }
}
function connect() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  socket?.close();
  connection.value = 'connecting';
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token.value)}`);
  socket = ws;
  ws.onmessage = event => {
    if (socket !== ws) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'serverInfo') connection.value = 'online';
      if (message.type === 'tasks') tasks.value = message.data;
    } catch { notify('任务数据接收失败，正在重新同步', true); void load(); }
  };
  ws.onclose = event => {
    if (stopped || socket !== ws) return;
    connection.value = 'offline';
    if (event.code === 1008) { loginOpen.value = true; void openModal(); return; }
    reconnectTimer = setTimeout(() => { connect(); void load(); }, 3000);
  };
  ws.onerror = () => { connection.value = 'offline'; };
}
function combinedHeaders() {
  const text = headers.value.trim();
  const parsed: Record<string, string> = {};
  if (text.startsWith('{')) Object.assign(parsed, JSON.parse(text));
  else for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const index = line.indexOf(':');
    if (index < 1) throw new Error('请求头格式不正确，请每行填写「名称: 值」');
    parsed[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  if (source.value.trim()) {
    const url = new URL(source.value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('来源页应为 http 或 https 地址');
    for (const key of Object.keys(parsed)) if (key.toLowerCase() === 'referer') delete parsed[key];
    parsed.referer = url.href;
  }
  return JSON.stringify(parsed);
}
async function submit() {
  if (!lines.value.length) { inputRef.value?.focus(); return; }
  busy.value = true; formError.value = '';
  try {
    if (lines.value.length > 100) throw new Error('一次最多添加 100 个链接');
    const custom = combinedHeaders();
    await api('download', { list: lines.value.map((url, index) => ({ url, headers: custom, ...(title.value.trim() ? { filename: `${title.value.trim()}${lines.value.length > 1 ? `-${index + 1}` : ''}` } : {}) })) });
    urls.value = ''; title.value = ''; tab.value = 'active';
    notify('已加入队列，下载完成后会自动合并'); await load();
  } catch (error) { formError.value = (error as Error).message; }
  finally { busy.value = false; }
}
async function action(task: TaskItem, type: 'pause' | 'resume' | 'retry-failed') {
  pending.add(task.url);
  try { await api(type, { urls: [task.url] }); await load(); }
  catch (error) { notify((error as Error).message, true); }
  finally { pending.delete(task.url); }
}
async function batch(type: 'pause' | 'resume' | 'retry-failed') {
  modalBusy.value = true;
  try { await api(type, { all: true }); await load(); }
  catch (error) { notify((error as Error).message, true); }
  finally { modalBusy.value = false; }
}
async function openModal() {
  await nextTick();
  if (!modalRef.value?.open) modalRef.value?.showModal();
}
async function settings() { settingsOpen.value = true; modalError.value = ''; await openModal(); }
function closeModal() {
  if (loginOpen.value || modalBusy.value) return;
  clearInterval(segmentTimer); detailsUrl.value = ''; newDownloadOpen.value = false; settingsOpen.value = false; editTask.value = null; removeTask.value = null; modalError.value = ''; modalRef.value?.close();
}
async function edit(task: TaskItem) {
  editTask.value = task; modalError.value = '';
  editHeaders.value = typeof task.options?.headers === 'string' ? task.options.headers : JSON.stringify(task.options?.headers || {}, null, 2);
  await openModal();
}
async function remove(task: TaskItem) { removeTask.value = task; removeFile.value = false; removeCache.value = true; modalError.value = ''; await openModal(); }
async function modalSubmit() {
  modalBusy.value = true; modalError.value = '';
  try {
    if (loginOpen.value) {
      token.value = password.value.trim();
      if (!token.value) throw new Error('请输入访问密码');
      await api('tasks'); sessionStorage.setItem('m3u8-token', token.value); password.value = ''; loginOpen.value = false;
      connect(); await load();
    } else if (newDownloadOpen.value) { await submit(); if (formError.value) throw new Error(formError.value); }
    else if (settingsOpen.value) { await api('config', { ...config }); notify('下载设置已保存'); }
    else if (editTask.value) {
      await api('download', { list: [{ url: editTask.value.url, ...editTask.value.options, headers: editHeaders.value }] });
      notify('请求头已更新，任务已继续'); await load();
    } else if (removeTask.value) {
      await api('delete', { urls: [removeTask.value.url], deleteCache: removeCache.value, deleteVideo: removeFile.value });
      notify('任务已移除'); await load();
    }
    modalBusy.value = false; closeModal();
  } catch (error) { modalError.value = (error as Error).message; }
  finally { modalBusy.value = false; }
}
function eta(seconds = 0) {
  if (!seconds || !Number.isFinite(seconds)) return '计算中';
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
async function newDownload() { newDownloadOpen.value = true; modalError.value = ''; formError.value = ''; await openModal(); inputRef.value?.focus(); }
async function loadSegments() {
  const current = detailsUrl.value;
  if (!current) return;
  try {
    const response = await api<SegmentSnapshot>(`segments?url=${encodeURIComponent(current)}`);
    if (detailsUrl.value === current) { segments.value = response; segmentPage.value = Math.min(segmentPage.value, segmentPages.value); segmentError.value = ''; }
  } catch (error) { if (detailsUrl.value === current) segmentError.value = (error as Error).message; }
  finally { segmentLoading.value = false; }
}
async function details(task: TaskItem) {
  clearInterval(segmentTimer); detailsUrl.value = task.url; segmentLoading.value = true;
  segments.value = { fingerprint: '', items: [] }; selectedSegment.value = null; segmentFilter.value = 'all'; segmentPage.value = 1;
  await openModal(); await loadSegments();
  if (detailsUrl.value) segmentTimer = setInterval(() => { void loadSegments(); }, 1000);
}
function filterSegments(filter: 'all' | 'done' | 'error' | 'pending') { segmentFilter.value = filter; segmentPage.value = 1; }
function fileUrl(task: TaskItem) { return `/api/file?url=${encodeURIComponent(task.url)}&token=${encodeURIComponent(token.value)}`; }
function onVisible() { if (!document.hidden) { void load(); if (connection.value !== 'online') connect(); } }
onMounted(() => { void load(); connect(); document.addEventListener('visibilitychange', onVisible); });
onBeforeUnmount(() => { stopped = true; clearInterval(segmentTimer); clearTimeout(reconnectTimer); clearTimeout(noticeTimer); socket?.close(); document.removeEventListener('visibilitychange', onVisible); });
</script>

<template>
  <div class="app-shell">
    <header class="app-header"><a class="brand" href="/" aria-label="M3U8 下载器首页"><span class="brand-mark"><AppIcon name="bolt" :size="28" /></span><strong>M3U8 <span>DL</span></strong></a><div class="header-actions"><button type="button" class="button primary new-button" @click="newDownload"><AppIcon name="plus" :size="17" />新建下载</button><button type="button" class="button secondary settings-button" aria-label="打开下载设置" @click="settings"><AppIcon name="settings" :size="17" /><span>设置</span></button></div></header>
    <main class="workspace">
      <div v-if="connection === 'offline'" class="offline-banner" role="status"><AppIcon name="info" :size="16" />服务连接已断开，正在自动重连。<button type="button" @click="connect(); load()">重新连接</button></div>
      <div class="list-navigation"><div class="tabs" role="tablist" aria-label="任务分类"><button id="active-tab" type="button" role="tab" :aria-selected="tab === 'active'" :class="{ selected: tab === 'active' }" aria-controls="task-panel" @click="tab = 'active'">下载中 <span>({{ active.length }})</span></button><button id="done-tab" type="button" role="tab" :aria-selected="tab === 'done'" :class="{ selected: tab === 'done' }" aria-controls="task-panel" @click="tab = 'done'">下载完成 <span>({{ complete.length }})</span></button><button id="error-tab" type="button" role="tab" :aria-selected="tab === 'error'" :class="{ selected: tab === 'error' }" aria-controls="task-panel" @click="tab = 'error'">失败 <span>({{ errors }})</span></button></div><div class="connection" :class="connection" role="status"><i />{{ connection === 'online' ? '已连接' : connection === 'connecting' ? '连接中' : '未连接' }}</div></div>
      <div class="list-toolbar"><div class="batch-actions"><template v-if="tab !== 'done'"><button type="button" class="toolbar-button" :disabled="!active.length || modalBusy" @click="batch('resume')"><AppIcon name="resume" :size="14" />全部继续</button><button type="button" class="toolbar-button" :disabled="!running || modalBusy" @click="batch('pause')"><AppIcon name="pause" :size="14" />全部暂停</button><button v-if="failedSegmentTasks.length" type="button" class="toolbar-button retry-all" :disabled="modalBusy" @click="batch('retry-failed')"><AppIcon name="retry" :size="14" />重试失败分片</button></template><span v-else class="completed-note">文件已合并，可直接保存到当前设备</span></div><label class="search"><AppIcon name="search" :size="16" /><input v-model="search" type="search" placeholder="搜索文件名或链接" aria-label="搜索下载任务" /></label></div>
      <section id="task-panel" class="download-panel" role="tabpanel" :aria-labelledby="`${tab}-tab`" :aria-busy="loading">
        <table class="download-table"><colgroup><col class="col-file" /><col class="col-progress" /><col class="col-speed" /><col class="col-status" /><col class="col-actions" /></colgroup><thead><tr><th>文件名</th><th>进度</th><th>下载速度</th><th>状态</th><th>操作</th></tr></thead><tbody>
          <tr v-if="loading" class="empty-row"><td colspan="5"><div class="empty-state"><span class="spinner" /><p>正在同步下载任务…</p></div></td></tr>
          <tr v-else-if="!visible.length" class="empty-row"><td colspan="5"><div class="empty-state"><AppIcon :name="search ? 'search' : 'arrow'" :size="36" /><h2>{{ search ? '没有找到相关任务' : tab === 'done' ? '暂无已完成的下载' : tab === 'error' ? '没有失败的任务' : '暂无下载任务' }}</h2><p>{{ search ? '试试其他文件名或链接' : tab === 'done' ? '下载和合并完成的文件会显示在这里' : tab === 'error' ? '下载失败时，可在这里仅重试失败的分片' : '添加 M3U8 链接，开始下载视频' }}</p><button v-if="!search && tab === 'active'" type="button" class="button primary" @click="newDownload"><AppIcon name="plus" :size="16" />新建下载</button><button v-else-if="search" type="button" class="text-button" @click="search = ''">清除搜索</button></div></td></tr>
          <tr v-for="task in visible" :key="task.url" class="task-row" :class="{ failed: task.status === 'error' }">
            <td class="file-cell"><div class="file-layout"><span class="hls-tag">HLS</span><div class="file-description"><button type="button" class="file-name" :title="name(task)" @click="details(task)">{{ name(task) }}</button><span class="file-source">{{ host(task.url) }}</span></div></div></td>
            <td class="progress-cell"><div class="progress-line"><div class="progress-track" role="progressbar" :aria-label="`${name(task)} ${label(task)}`" :aria-valuenow="progress(task)" aria-valuemin="0" aria-valuemax="100"><div :style="{ width: `${progress(task)}%` }" /></div><span>{{ progress(task) }}%</span></div><button type="button" class="fragment-link" :aria-label="`查看 ${name(task)} 的分片详情`" @click="details(task)"><AppIcon name="info" :size="13" /><span>{{ task.tsSuccess || 0 }}/{{ task.tsCount || '—' }} 分片</span><b v-if="task.tsFailed" class="failure-number">{{ task.tsFailed }} 失败</b><span class="progress-size">| {{ bytes(task.downloadedSize) }}</span></button></td>
            <td class="speed-cell" data-label="速度"><strong>{{ task.status === 'resume' && task.phase === 'downloading' ? task.speedDesc || '0 B/s' : '—' }}</strong><small v-if="task.status === 'resume' && task.phase === 'downloading'">剩余 {{ eta(task.remainingTime) }}</small></td>
            <td class="status-cell" data-label="状态"><span class="status" :class="[task.status, { merging: task.phase === 'merging' && task.status === 'resume' }]"><span v-if="task.status === 'resume' && task.phase === 'merging'" class="spinner mini" />{{ label(task) }}</span><small v-if="task.startTime">{{ new Date(task.endTime || task.startTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) }}</small><p v-if="task.status === 'error' && task.errmsg" class="task-error" :title="task.errmsg">{{ task.errmsg }}</p><small v-if="task.phase === 'merging' && task.status === 'resume'">{{ task.mergeMessage || '等待合并' }}</small></td>
            <td class="actions-cell"><div class="task-actions"><button type="button" class="icon-button" :aria-label="`查看 ${name(task)} 的分片详情`" title="分片详情" @click="details(task)"><AppIcon name="info" :size="17" /></button><a v-if="task.status === 'done'" class="icon-button" :href="fileUrl(task)" :aria-label="`保存 ${name(task)}`" title="保存文件" download><AppIcon name="arrow" :size="18" /></a><button v-else-if="['resume','pending'].includes(task.status)" type="button" class="icon-button" :disabled="pending.has(task.url)" :aria-label="`暂停 ${name(task)}`" title="暂停" @click="action(task, 'pause')"><AppIcon name="pause" :size="17" /></button><button v-else type="button" class="icon-button" :disabled="pending.has(task.url)" :aria-label="task.status === 'error' && task.tsFailed && task.hasSegmentDetails ? `仅重试 ${name(task)} 的失败分片` : `继续 ${name(task)}`" :title="task.status === 'error' && task.tsFailed && task.hasSegmentDetails ? '仅重试失败分片' : '继续下载'" @click="action(task, task.status === 'error' && task.tsFailed && task.hasSegmentDetails ? 'retry-failed' : 'resume')"><AppIcon :name="task.status === 'error' ? 'retry' : 'resume'" :size="17" /></button><button v-if="['pause','error'].includes(task.status)" type="button" class="icon-button" :aria-label="`编辑 ${name(task)} 的请求头`" title="编辑请求头" @click="edit(task)"><AppIcon name="edit" :size="16" /></button><button type="button" class="icon-button remove-button" :aria-label="`移除 ${name(task)}`" title="移除任务" @click="remove(task)"><AppIcon name="close" :size="17" /></button></div></td>
          </tr>
        </tbody></table>
      </section>
      <footer class="list-footer"><span>共 {{ visible.length }} 个任务<span v-if="running"> · {{ running }} 个正在运行</span></span><span class="total-speed"><AppIcon name="arrow" :size="13" />{{ bytes(speed) }}/s</span></footer>
    </main>
    <div v-if="notice" class="toast" :class="{ error: noticeError }" role="status"><AppIcon :name="noticeError ? 'info' : 'check'" :size="18" />{{ notice }}<button type="button" class="icon-button" aria-label="关闭提示" @click="notice = ''"><AppIcon name="close" :size="16" /></button></div>
    <dialog ref="modalRef" class="dialog" :class="{ 'settings-dialog': settingsOpen, 'segment-dialog': !!detailsUrl }" :aria-label="loginOpen ? '服务访问密码' : newDownloadOpen ? '新建下载' : detailsUrl ? '下载分片详情' : settingsOpen ? '下载设置' : editTask ? '修改请求头' : '移除任务'" @cancel.prevent="closeModal" @keydown.esc.prevent="closeModal" @click="($event.target === modalRef) && closeModal()">
      <form v-if="modalOpen" @submit.prevent="modalSubmit">
        <div class="dialog-header"><div><p class="eyebrow">{{ loginOpen ? '连接服务' : newDownloadOpen ? 'M3U8 / HLS' : detailsUrl ? '下载详情' : settingsOpen ? 'PREFERENCES' : editTask ? 'REQUEST HEADERS' : 'REMOVE TASK' }}</p><h2>{{ loginOpen ? '连接下载器' : newDownloadOpen ? '新建下载' : detailsUrl ? '下载分片' : settingsOpen ? '下载设置' : editTask ? '修改请求头并继续' : '移除这个任务？' }}</h2></div><button v-if="!loginOpen" type="button" class="icon-button" aria-label="关闭对话框" :disabled="modalBusy" @click="closeModal"><AppIcon name="close" /></button></div>
        <div class="dialog-body">
          <template v-if="loginOpen"><p class="dialog-intro">服务已启用密码保护。密码仅在当前浏览器会话中保存。</p><label for="password">访问密码</label><input id="password" v-model="password" type="password" autocomplete="current-password" required autofocus /></template>
          <template v-else-if="newDownloadOpen">
            <label for="urls">下载链接 <span class="field-note">一行一个，支持批量</span></label>
            <textarea id="urls" ref="inputRef" v-model="urls" class="url-input" rows="4" placeholder="https://example.com/index.m3u8" required spellcheck="false" autocapitalize="off" />
            <label for="filename">文件名称 <span class="field-note">可选</span></label><input id="filename" v-model="title" placeholder="不填则自动生成" maxlength="150" />
            <button type="button" class="advanced-toggle" :aria-expanded="advanced" aria-controls="request-options" @click="advanced = !advanced"><span>请求头设置 <small>自动携带 Referer 与 User-Agent</small></span><AppIcon name="chevron" :size="16" :class="{ rotated: advanced }" /></button>
            <div v-show="advanced" id="request-options"><label for="referer">来源页 Referer</label><input id="referer" v-model="source" type="url" :placeholder="originHint" /><p class="field-help">有防盗链时填视频的实际播放页面；留空使用资源域名。</p><label for="headers">附加请求头</label><textarea id="headers" v-model="headers" class="mono" rows="3" placeholder="Cookie: ...&#10;User-Agent: ..." spellcheck="false" /><p class="field-help">支持每行「名称: 值」或 JSON，同名字段覆盖默认设置。</p></div>
          </template>
          <template v-else-if="detailsUrl && detailsTask">
            <div class="detail-file"><span class="hls-tag">HLS</span><strong>{{ name(detailsTask) }}</strong><span class="status" :class="detailsTask.status">{{ label(detailsTask) }}</span></div>
            <div class="segment-summary"><strong>已下载分片 <b>{{ segmentCounts.done }}</b><span>/ {{ segments.items.length || detailsTask.tsCount || 0 }}</span></strong><span>{{ bytes(detailsTask.downloadedSize) }}</span></div>
            <fieldset class="segment-legend"><legend class="sr-only">筛选分片</legend><button type="button" :class="{ selected: segmentFilter === 'all' }" @click="filterSegments('all')">全部</button><button type="button" class="done" :class="{ selected: segmentFilter === 'done' }" @click="filterSegments('done')"><i />已完成 {{ segmentCounts.done }}</button><button type="button" class="error" :class="{ selected: segmentFilter === 'error' }" @click="filterSegments('error')"><i />失败 {{ segmentCounts.error }}</button><button type="button" class="pending" :class="{ selected: segmentFilter === 'pending' }" @click="filterSegments('pending')"><i />未完成 {{ segmentCounts.pending }}</button></fieldset>
            <p v-if="segmentError" class="form-error" role="alert">{{ segmentError }}</p>
            <div v-if="segmentLoading" class="segment-empty"><span class="spinner" />正在读取分片状态…</div>
            <div v-else-if="!pageSegments.length" class="segment-empty">{{ segments.items.length ? '没有符合条件的分片' : '解析完成后将在这里显示分片状态' }}</div>
            <div v-else class="segment-grid"><button v-for="segment in pageSegments" :key="segment.index" type="button" :class="[segment.status, { inspected: selectedSegment === segment.index }]" :aria-label="`分片 ${segment.index + 1}：${segmentLabels[segment.status]}`" :title="segment.error || `分片 ${segment.index + 1} · ${segmentLabels[segment.status]}`" @click="selectedSegment = segment.index">{{ segment.index + 1 }}</button></div>
            <div v-if="segmentPages > 1" class="segment-pagination"><button type="button" class="button secondary" :disabled="segmentPage === 1" @click="segmentPage--">上一页</button><span>{{ segmentPage }} / {{ segmentPages }}</span><button type="button" class="button secondary" :disabled="segmentPage === segmentPages" @click="segmentPage++">下一页</button></div>
            <div v-if="inspectedSegment" class="segment-inspector"><strong>分片 {{ inspectedSegment.index + 1 }} · {{ segmentLabels[inspectedSegment.status] }}</strong><span>{{ bytes(inspectedSegment.size) }} · {{ inspectedSegment.attempts }} 次下载尝试</span><p v-if="inspectedSegment.error">{{ inspectedSegment.error }}</p></div>
            <p class="field-help">绿色已完成，蓝色正在下载，红色失败，灰色尚未完成。点击编号可查看详情。</p>
          </template>
          <template v-else-if="settingsOpen"><label for="save-dir">文件保存目录</label><input id="save-dir" v-model="config.saveDir" required /><p class="field-help">这是运行下载器的服务器目录。</p><div class="form-grid"><div><label for="threads">每任务并发分片</label><input id="threads" v-model.number="config.threadNum" type="number" min="1" max="16" required /></div><div><label for="parallel">同时下载任务</label><input id="parallel" v-model.number="config.maxDownloads" type="number" min="1" max="5" required /></div></div><label for="default-headers">默认请求头</label><textarea id="default-headers" v-model="config.headers" rows="3" class="mono" placeholder="Referer: https://example.com/&#10;Cookie: ..." spellcheck="false" /><p class="field-help">所有新任务共享；单个任务填写的同名请求头优先。</p><div class="setting-divider" /><label for="ffmpeg">FFmpeg 路径 <span class="field-note">留空使用系统 PATH</span></label><input id="ffmpeg" v-model="config.ffmpegPath" placeholder="ffmpeg" /><label for="merge-timeout">合并无进展超时（秒）</label><input id="merge-timeout" v-model.number="config.mergeTimeout" type="number" min="15" max="3600" required /><label class="check-field"><input v-model="config.delCache" type="checkbox" /><span>合并成功后清理分片缓存<small>失败和暂停时始终保留，方便续传。</small></span></label><div class="setting-divider" /><label for="proxy-mode">网络代理</label><select id="proxy-mode" v-model="config.proxyMode"><option value="system">使用系统环境变量</option><option value="disabled">不使用代理</option><option value="custom">自定义 HTTP 代理</option></select><template v-if="config.proxyMode === 'custom'"><label for="proxy-url">代理地址</label><input id="proxy-url" v-model="config.proxyUrl" type="url" placeholder="http://127.0.0.1:7890" required /></template></template>
          <template v-else-if="editTask"><p class="dialog-intro">分片缓存会保留。更新后将自动继续下载。</p><p class="edit-url">{{ editTask.url }}</p><label for="edit-headers">本任务请求头</label><textarea id="edit-headers" v-model="editHeaders" rows="7" class="mono" placeholder="Referer: https://example.com/" spellcheck="false" /><p class="field-help">支持 JSON 或每行「名称: 值」。不填时使用默认设置和自动请求头。</p></template>
          <template v-else-if="removeTask"><p class="dialog-intro">{{ name(removeTask) }}</p><label class="check-field"><input v-model="removeCache" type="checkbox" /><span>同时清理已下载的分片缓存</span></label><label v-if="removeTask.localVideo" class="check-field"><input v-model="removeFile" type="checkbox" /><span>同时删除服务器上的合并文件<small>勾选后文件无法恢复。</small></span></label><p class="field-help">未勾选的文件会保留在服务器上。</p></template>
          <p v-if="modalError" class="form-error" role="alert">{{ modalError }}</p>
        </div>
        <div v-if="detailsUrl" class="dialog-footer detail-footer"><span class="detail-live"><i />每秒自动更新</span><button v-if="detailsTask?.status === 'error' && segmentCounts.error" type="button" class="button primary" :disabled="pending.has(detailsTask.url)" @click="action(detailsTask, 'retry-failed')"><AppIcon name="retry" :size="16" />仅重试失败分片 ({{ segmentCounts.error }})</button><button type="button" class="button secondary" @click="closeModal">关闭</button></div>
        <div v-else class="dialog-footer"><button v-if="!loginOpen" type="button" class="button secondary" :disabled="modalBusy" @click="closeModal">取消</button><button type="submit" class="button" :class="removeTask ? 'danger' : 'primary'" :disabled="modalBusy || (newDownloadOpen && connection !== 'online')"><span v-if="modalBusy" class="spinner" />{{ modalBusy ? '请稍候…' : loginOpen ? '连接服务' : newDownloadOpen ? lines.length > 1 ? `添加 ${lines.length} 个下载` : '开始下载' : settingsOpen ? '保存设置' : editTask ? '保存并继续' : '确认移除' }}</button></div>
      </form>
    </dialog>
  </div>
</template>
