<script setup lang="ts">
import type { ApiResponse, ExtractedMedia, ExtractionResult, SegmentSnapshot, ServerConfig, TaskItem } from '@lzwme/m3u8-dl/contract';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';

const tasks = ref<Record<string, TaskItem>>({});
const connection = ref<'connecting' | 'online' | 'offline'>('connecting');
const loading = ref(true);
const tab = ref<'active' | 'done' | 'error'>('active');
const search = ref('');
const busy = ref(false);
const pending = reactive(new Set<string>());
const selected = reactive(new Set<string>());
const batchBusy = ref(false);
const notice = ref('');
const noticeError = ref(false);
const formError = ref('');
const modalError = ref('');
const modalBusy = ref(false);
const urls = ref('');
const title = ref('');
const downloadType = ref<'auto' | 'm3u8' | 'file' | 'parser'>('auto');
const entryMode = ref<'download' | 'extract'>('download');
const entryTitle = computed(() => entryMode.value === 'extract' ? '网页媒体提取' : '新建下载');
const extractDepth = ref(1);
const extractPath = ref('');
const extractBusy = ref(false);
const extracted = ref<ExtractionResult | null>(null);
const extractedSelection = ref<string[]>([]);
const selectedExtracted = computed(() => extracted.value?.items.filter(item => extractedSelection.value.includes(item.url)) || []);
let extractionController: AbortController | undefined;
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
watch(() => detailsTask.value?.status, (status, previous) => { if (detailsUrl.value && previous && status !== previous && detailsTask.value && !isFile(detailsTask.value)) void loadSegments(); });

const loginOpen = ref(false);
const editTask = ref<TaskItem | null>(null);
const editHeaders = ref('');
const removeTasks = ref<TaskItem[]>([]);
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
let tasksRevision = 0;
let loadSequence = 0;
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
const selectedTasks = computed(() => visible.value.filter(task => selected.has(task.url)));
const allSelected = computed(() => visible.value.length > 0 && selectedTasks.value.length === visible.value.length);
watch(visible, items => {
  const urls = new Set(items.map(task => task.url));
  for (const url of selected) if (!urls.has(url)) selected.delete(url);
});
const modalOpen = computed(() => newDownloadOpen.value || !!detailsUrl.value || settingsOpen.value || loginOpen.value || !!editTask.value || removeTasks.value.length > 0);
watch(modalOpen, open => { document.documentElement.classList.toggle('modal-open', open); });
const lines = computed(() => urls.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
const originHint = computed(() => { try { return `${new URL(lines.value[0]).origin}/`; } catch { return '自动使用资源域名'; } });
function bytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][index]}`;
}
function host(url: string) { try { return new URL(url).hostname; } catch { return url; } }
function isFile(task: TaskItem) { return task.downloadType === 'file' || task.options?.type === 'file'; }
function kind(task: TaskItem) { return isFile(task) ? /\.([a-z0-9]{1,5})$/i.exec(task.filename || '')?.[1].toUpperCase() || 'FILE' : 'HLS'; }
function detailLabel(task: TaskItem) { return `查看 ${name(task)} 的${isFile(task) ? '下载' : '分片'}详情`; }
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
async function api<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: token.value },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const result = await response.json() as ApiResponse<T>;
  if (response.status === 401) { loginOpen.value = true; await openModal(); }
  if (!response.ok || result.code) throw new Error(result.message || '请求失败，请重试');
  return result.data as T;
}
async function load() {
  const sequence = ++loadSequence;
  const revision = tasksRevision;
  try {
    const [items, settings] = await Promise.all([api<Record<string, TaskItem>>('tasks'), api<ServerConfig>('config')]);
    if (sequence !== loadSequence) return;
    if (revision === tasksRevision) tasks.value = items;
    Object.assign(config, settings); loginOpen.value = false;
  } catch (error) { if (!loginOpen.value) notify((error as Error).message, true); }
  finally { if (sequence === loadSequence) loading.value = false; }
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
      if (message.type === 'tasks') { tasksRevision++; tasks.value = message.data; }
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
    await api('download', { list: lines.value.map((url, index) => ({ url, type: downloadType.value, headers: custom, ...(title.value.trim() ? { filename: `${title.value.trim()}${lines.value.length > 1 ? `-${index + 1}` : ''}` } : {}) })) });
    urls.value = ''; title.value = ''; tab.value = 'active';
    notify('已加入下载队列'); await load();
  } catch (error) { formError.value = (error as Error).message; }
  finally { busy.value = false; }
}
function cancelExtraction() { extractionController?.abort(); extractionController = undefined; extractBusy.value = false; }
function switchEntry(mode: 'download' | 'extract') { cancelExtraction(); entryMode.value = mode; formError.value = ''; modalError.value = ''; }
watch([urls, extractDepth, extractPath], () => { cancelExtraction(); extracted.value = null; extractedSelection.value = []; });
async function runExtraction() {
  if (extractBusy.value) { cancelExtraction(); return; }
  if (!lines.value.length) { inputRef.value?.focus(); return; }
  const controller = new AbortController(); extractionController = controller;
  extractBusy.value = true; formError.value = ''; modalError.value = ''; extracted.value = null; extractedSelection.value = [];
  try {
    const result = await api<ExtractionResult>('extract', { urls: lines.value, deep: extractDepth.value, pathFilter: extractPath.value.trim(), headers: combinedHeaders() }, controller.signal);
    if (controller.signal.aborted) return;
    extracted.value = result; extractedSelection.value = result.items.map(item => item.url);
  } catch (error) { if (!controller.signal.aborted) formError.value = (error as Error).message; }
  finally { if (extractionController === controller) { extractionController = undefined; extractBusy.value = false; } }
}
function toggleExtractedAll() {
  extractedSelection.value = selectedExtracted.value.length === extracted.value?.items.length ? [] : extracted.value?.items.map(item => item.url) || [];
}
function extractedName(item: ExtractedMedia) {
  if (!item.title) return undefined;
  let extension = '.mp4';
  if (item.type === 'file') { try { extension = /\.([a-z0-9]{1,8})$/i.exec(new URL(item.url).pathname)?.[0] || '.mp4'; } catch { /* Keep a usable media extension. */ } }
  return `${item.title.slice(0, 120).replace(/\.(mp4|m3u8|vtt|srt)$/i, '')}${extension}`;
}
async function submitExtracted() {
  formError.value = '';
  try {
    const chosen = [...selectedExtracted.value];
    if (!chosen.length) throw new Error('请先提取并勾选要下载的媒体');
    const custom = JSON.parse(combinedHeaders());
    await api('download', { list: chosen.map(item => ({ url: item.url, filename: extractedName(item), type: item.type, sourceUrl: item.source, headerSourceUrl: item.credentialSource || item.source, headers: custom })) });
    notify(`已添加 ${chosen.length} 个下载`); tab.value = 'active'; await load();
  } catch (error) { formError.value = (error as Error).message; }
}
async function action(task: TaskItem, type: 'pause' | 'resume' | 'retry-failed') {
  pending.add(task.url);
  try { await api(type, { urls: [task.url] }); await load(); }
  catch (error) { notify((error as Error).message, true); }
  finally { pending.delete(task.url); }
}
function toggleAll() {
  if (allSelected.value) selected.clear();
  else for (const task of visible.value) selected.add(task.url);
}
function toggleTask(url: string) { if (selected.has(url)) selected.delete(url); else selected.add(url); }
function navigateTabs(event: KeyboardEvent) {
  const tabs = ['active', 'done', 'error'] as const;
  const index = tabs.indexOf(tab.value);
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
  if (next < 0) return;
  event.preventDefault(); tab.value = tabs[next]; document.getElementById(`${tabs[next]}-tab`)?.focus();
}
function batchTargets(type: 'pause' | 'resume' | 'retry-failed', selectedOnly = false) {
  return (selectedOnly ? selectedTasks.value : all.value).filter(task => !pending.has(task.url) && (type === 'pause'
    ? ['resume', 'pending'].includes(task.status)
    : type === 'resume' ? ['pause', 'error'].includes(task.status)
    : task.status === 'error' && task.tsFailed && task.hasSegmentDetails));
}
async function batch(type: 'pause' | 'resume' | 'retry-failed', selectedOnly = false) {
  if (batchBusy.value) return;
  const targets = batchTargets(type, selectedOnly).map(task => task.url);
  if (!targets.length) return;
  batchBusy.value = true;
  for (const url of targets) pending.add(url);
  try {
    await api(type, { urls: targets });
    notify(type === 'pause' ? `已暂停 ${targets.length} 个任务，缓存已保留` : `已提交 ${targets.length} 个任务${type === 'retry-failed' ? '的失败分片重试' : '继续下载'}`);
  }
  catch (error) { notify((error as Error).message, true); }
  finally { for (const url of targets) pending.delete(url); batchBusy.value = false; await load(); }
}
async function openModal() {
  await nextTick();
  if (!modalRef.value?.open) modalRef.value?.showModal();
}
async function settings() { settingsOpen.value = true; modalError.value = ''; await openModal(); }
function closeModal() {
  if (loginOpen.value || modalBusy.value) return;
  cancelExtraction();
  clearInterval(segmentTimer); detailsUrl.value = ''; newDownloadOpen.value = false; settingsOpen.value = false; editTask.value = null; removeTasks.value = []; modalError.value = ''; modalRef.value?.close();
}
async function edit(task: TaskItem) {
  editTask.value = task; modalError.value = '';
  editHeaders.value = typeof task.options?.headers === 'string' ? task.options.headers : JSON.stringify(task.options?.headers || {}, null, 2);
  await openModal();
}
async function remove(items: TaskItem[]) {
  if (batchBusy.value || !items.length) return;
  removeTasks.value = [...items]; removeFile.value = false; removeCache.value = true; modalError.value = ''; await openModal();
}
async function modalSubmit() {
  modalBusy.value = true; modalError.value = '';
  try {
    if (loginOpen.value) {
      token.value = password.value.trim();
      if (!token.value) throw new Error('请输入访问密码');
      await api('tasks'); sessionStorage.setItem('m3u8-token', token.value); password.value = ''; loginOpen.value = false;
      connect(); await load();
    } else if (newDownloadOpen.value) { if (entryMode.value === 'extract') await submitExtracted(); else await submit(); if (formError.value) throw new Error(formError.value); }
    else if (settingsOpen.value) { await api('config', { ...config }); notify('下载设置已保存'); }
    else if (editTask.value) {
      await api('download', { list: [{ url: editTask.value.url, ...editTask.value.options, headers: editHeaders.value }] });
      notify('请求头已更新，任务已继续'); await load();
    } else if (removeTasks.value.length) {
      await api('delete', { urls: removeTasks.value.map(task => task.url), deleteCache: removeCache.value, deleteVideo: removeFile.value });
      notify(`已移除 ${removeTasks.value.length} 个任务`); await load();
    }
    modalBusy.value = false; closeModal();
  } catch (error) {
    modalError.value = (error as Error).message;
    await nextTick(); modalRef.value?.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
  }
  finally { modalBusy.value = false; }
}
function eta(seconds = 0) {
  if (!seconds || !Number.isFinite(seconds)) return '计算中';
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
async function newDownload(mode: 'download' | 'extract' = 'download') { switchEntry(mode); newDownloadOpen.value = true; await openModal(); inputRef.value?.focus(); }
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
  clearInterval(segmentTimer); detailsUrl.value = task.url; segmentLoading.value = !isFile(task);
  segments.value = { fingerprint: '', items: [] }; selectedSegment.value = null; segmentFilter.value = 'all'; segmentPage.value = 1;
  await openModal();
  if (isFile(task)) return;
  await loadSegments();
  if (detailsUrl.value) segmentTimer = setInterval(() => { void loadSegments(); }, 1000);
}
function filterSegments(filter: 'all' | 'done' | 'error' | 'pending') { segmentFilter.value = filter; segmentPage.value = 1; }
function fileUrl(task: TaskItem) { return `/api/file?url=${encodeURIComponent(task.url)}&token=${encodeURIComponent(token.value)}`; }
function onVisible() { if (!document.hidden) { void load(); if (connection.value !== 'online') connect(); } }
onMounted(() => { void load(); connect(); document.addEventListener('visibilitychange', onVisible); });
onBeforeUnmount(() => { stopped = true; cancelExtraction(); clearInterval(segmentTimer); clearTimeout(reconnectTimer); clearTimeout(noticeTimer); socket?.close(); document.documentElement.classList.remove('modal-open'); document.removeEventListener('visibilitychange', onVisible); });
</script>

<template>
  <div class="app-shell">
    <a class="skip-link" href="#main-content">跳到下载任务</a>
    <header class="app-header"><a class="brand" href="/" aria-label="M3U8 下载器首页"><span class="brand-mark"><AppIcon name="bolt" :size="28" /></span><strong>M3U8 <span>DL</span></strong></a><div class="header-actions"><button type="button" class="button secondary extract-button" aria-label="打开网页提取" @click="newDownload('extract')"><AppIcon name="link" :size="17" /><span>网页提取</span></button><button type="button" class="button primary new-button" @click="newDownload('download')"><AppIcon name="plus" :size="17" />新建下载</button><button type="button" class="button secondary settings-button" aria-label="打开下载设置" @click="settings"><AppIcon name="settings" :size="17" /><span>设置</span></button></div></header>
    <main id="main-content" class="workspace" tabindex="-1">
      <div class="workspace-heading"><div><h1>下载任务</h1><p>视频、字幕与网页媒体，集中管理。</p></div><div class="workspace-status"><div class="connection" :class="connection" role="status"><i />{{ connection === 'online' ? '服务已连接' : connection === 'connecting' ? '正在连接' : '服务未连接' }}</div><span class="heading-speed"><AppIcon name="arrow" :size="15" /><strong>{{ bytes(speed) }}<small>/s</small></strong><span>{{ running }} 个运行中</span></span></div></div>
      <div v-if="connection === 'offline'" class="offline-banner" role="status"><AppIcon name="info" :size="16" />服务连接已断开，正在自动重连。<button type="button" @click="connect(); load()">重新连接</button></div>
      <div class="list-navigation"><div class="tabs" role="tablist" aria-label="任务分类" @keydown="navigateTabs"><button id="active-tab" type="button" role="tab" :tabindex="tab === 'active' ? 0 : -1" :aria-selected="tab === 'active'" :class="{ selected: tab === 'active' }" aria-controls="task-panel" @click="tab = 'active'">进行中 <span>{{ active.length }}</span></button><button id="done-tab" type="button" role="tab" :tabindex="tab === 'done' ? 0 : -1" :aria-selected="tab === 'done'" :class="{ selected: tab === 'done' }" aria-controls="task-panel" @click="tab = 'done'">已完成 <span>{{ complete.length }}</span></button><button id="error-tab" type="button" role="tab" :tabindex="tab === 'error' ? 0 : -1" :aria-selected="tab === 'error'" :class="{ selected: tab === 'error' }" aria-controls="task-panel" @click="tab = 'error'">失败 <span>{{ errors }}</span></button></div><label class="search"><AppIcon name="search" :size="17" /><input v-model="search" type="search" placeholder="搜索文件名或链接" aria-label="搜索下载任务" /></label></div>
      <fieldset class="selection-toolbar" :class="{ 'has-selection': selectedTasks.length }"><legend class="sr-only">批量操作</legend>
        <label class="task-checkbox select-all"><input type="checkbox" :checked="allSelected" :indeterminate="selectedTasks.length > 0 && !allSelected" :disabled="!visible.length || batchBusy || loading || pending.size > 0" aria-label="全选当前列表" @change="toggleAll" /><span>{{ selectedTasks.length ? `已选 ${selectedTasks.length} 项` : '全选' }}</span></label>
        <template v-if="selectedTasks.length">
          <div class="selection-actions">
            <button v-if="tab !== 'done'" type="button" class="toolbar-button" :disabled="batchBusy || !batchTargets('resume', true).length" @click="batch('resume', true)"><AppIcon name="resume" :size="15" />继续 / 重试 <span>{{ batchTargets('resume', true).length }}</span></button>
            <button v-if="tab !== 'done'" type="button" class="toolbar-button" :disabled="batchBusy || !batchTargets('pause', true).length" @click="batch('pause', true)"><AppIcon name="pause" :size="15" />暂停 <span>{{ batchTargets('pause', true).length }}</span></button>
            <button v-if="batchTargets('retry-failed', true).length" type="button" class="toolbar-button retry-all" :disabled="batchBusy" @click="batch('retry-failed', true)"><AppIcon name="retry" :size="15" />仅重试失败分片</button>
            <button type="button" class="toolbar-button remove-button" :disabled="batchBusy || pending.size > 0" @click="remove(selectedTasks)"><AppIcon name="trash" :size="15" />移除所选</button>
          </div>
          <span v-if="batchBusy" class="batch-progress" role="status"><span class="spinner mini" />处理中…</span>
          <button type="button" class="toolbar-button clear-selection" :disabled="batchBusy" @click="selected.clear()"><AppIcon name="close" :size="14" />取消选择</button>
        </template>
        <template v-else><span class="selection-hint">选择任务以批量操作</span><div class="batch-actions"><template v-if="tab !== 'done'"><button type="button" class="toolbar-button" :disabled="!batchTargets('resume').length || batchBusy" @click="batch('resume')"><AppIcon name="resume" :size="15" />全部继续</button><button type="button" class="toolbar-button" :disabled="!batchTargets('pause').length || batchBusy" @click="batch('pause')"><AppIcon name="pause" :size="15" />全部暂停</button><button v-if="failedSegmentTasks.length" type="button" class="toolbar-button retry-all" :disabled="batchBusy" @click="batch('retry-failed')"><AppIcon name="retry" :size="15" />重试失败分片</button></template><span v-else class="completed-note"><AppIcon name="check" :size="15" />可保存至当前设备</span></div></template>
      </fieldset>
      <section id="task-panel" class="download-panel" role="tabpanel" :aria-labelledby="`${tab}-tab`" :aria-busy="loading">
        <table class="download-table"><colgroup><col class="col-file" /><col class="col-progress" /><col class="col-speed" /><col class="col-status" /><col class="col-actions" /></colgroup><thead><tr><th>文件名</th><th>进度</th><th>下载速度</th><th>状态</th><th>操作</th></tr></thead><tbody>
          <tr v-if="loading" class="empty-row"><td colspan="5"><div class="loading-state" role="status"><div v-for="n in 3" :key="n" class="skeleton-row"><span /><span /><span /></div><p>正在同步下载任务…</p></div></td></tr>
          <tr v-else-if="!visible.length" class="empty-row"><td colspan="5"><div class="empty-state"><AppIcon :name="search ? 'search' : 'arrow'" :size="36" /><h2>{{ search ? '没有找到相关任务' : tab === 'done' ? '暂无已完成的下载' : tab === 'error' ? '没有失败的任务' : '暂无下载任务' }}</h2><p>{{ search ? '试试其他文件名或链接' : tab === 'done' ? '下载完成的文件会显示在这里' : tab === 'error' ? '下载失败时，可在这里仅重试失败的分片' : '添加 M3U8、视频或字幕直链，开始下载' }}</p><button v-if="!search && tab === 'active'" type="button" class="button primary" @click="newDownload('download')"><AppIcon name="plus" :size="16" />新建下载</button><button v-else-if="search" type="button" class="text-button" @click="search = ''">清除搜索</button></div></td></tr>
          <tr v-for="task in visible" :key="task.url" class="task-row" :class="{ completed: task.status === 'done', failed: task.status === 'error', 'row-selected': selected.has(task.url) }">
            <td class="file-cell"><div class="file-layout"><label class="task-checkbox"><input type="checkbox" :checked="selected.has(task.url)" :disabled="batchBusy || pending.has(task.url)" :aria-label="`选择 ${name(task)}`" @change="toggleTask(task.url)" /><span class="sr-only">选择 {{ name(task) }}</span></label><span class="hls-tag">{{ kind(task) }}</span><div class="file-description"><button type="button" class="file-name" :title="name(task)" @click="details(task)">{{ name(task) }}</button><span class="file-source">{{ host(task.url) }}</span></div></div></td>
            <td class="progress-cell"><div class="progress-line"><div class="progress-track" role="progressbar" :aria-label="`${name(task)} ${label(task)}`" :aria-valuenow="progress(task)" aria-valuemin="0" aria-valuemax="100"><div :style="{ width: `${progress(task)}%` }" /></div><span>{{ progress(task) }}%</span></div><div v-if="isFile(task)" class="fragment-link"><AppIcon name="file" :size="13" /><span>{{ bytes(task.downloadedSize) }} / {{ task.size ? bytes(task.size) : '总大小未知' }}</span></div><button v-else type="button" class="fragment-link" :aria-label="detailLabel(task)" @click="details(task)"><AppIcon name="info" :size="13" /><span>{{ task.tsSuccess || 0 }}/{{ task.tsCount || '—' }} 分片</span><b v-if="task.tsFailed" class="failure-number">{{ task.tsFailed }} 失败</b><span class="progress-size">| {{ bytes(task.downloadedSize) }}</span></button></td>
            <td class="speed-cell" data-label="速度"><strong>{{ task.status === 'resume' && task.phase === 'downloading' ? task.speedDesc || '0 B/s' : '—' }}</strong><small v-if="task.status === 'resume' && task.phase === 'downloading'">剩余 {{ eta(task.remainingTime) }}</small></td>
            <td class="status-cell" data-label="状态"><span class="status" :class="[task.status, { merging: task.phase === 'merging' && task.status === 'resume' }]"><span v-if="task.status === 'resume' && task.phase === 'merging'" class="spinner mini" />{{ label(task) }}</span><small v-if="task.startTime">{{ new Date(task.endTime || task.startTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) }}</small><p v-if="task.status === 'error' && task.errmsg" class="task-error" :title="task.errmsg">{{ task.errmsg }}</p><small v-if="task.phase === 'merging' && task.status === 'resume'">{{ task.mergeMessage || '等待合并' }}</small></td>
            <td class="actions-cell"><div class="task-actions"><button type="button" class="icon-button" :aria-label="detailLabel(task)" :title="isFile(task) ? '下载详情' : '分片详情'" @click="details(task)"><AppIcon name="info" :size="17" /></button><a v-if="task.status === 'done'" class="icon-button" :href="fileUrl(task)" :aria-label="`保存 ${name(task)}`" title="保存文件" download><AppIcon name="arrow" :size="18" /></a><button v-else-if="['resume','pending'].includes(task.status)" type="button" class="icon-button" :disabled="pending.has(task.url)" :aria-label="`暂停 ${name(task)}`" title="暂停" @click="action(task, 'pause')"><AppIcon name="pause" :size="17" /></button><button v-else type="button" class="icon-button" :disabled="pending.has(task.url)" :aria-label="task.status === 'error' && task.tsFailed && task.hasSegmentDetails ? `仅重试 ${name(task)} 的失败分片` : `继续 ${name(task)}`" :title="task.status === 'error' && task.tsFailed && task.hasSegmentDetails ? '仅重试失败分片' : '继续下载'" @click="action(task, task.status === 'error' && task.tsFailed && task.hasSegmentDetails ? 'retry-failed' : 'resume')"><AppIcon :name="task.status === 'error' ? 'retry' : 'resume'" :size="17" /></button><button v-if="['pause','error'].includes(task.status)" type="button" class="icon-button" :aria-label="`编辑 ${name(task)} 的请求头`" title="编辑请求头" @click="edit(task)"><AppIcon name="edit" :size="16" /></button><button type="button" class="icon-button remove-button" :aria-label="`移除 ${name(task)}`" title="移除任务" :disabled="batchBusy || pending.has(task.url)" @click="remove([task])"><AppIcon name="trash" :size="17" /></button></div></td>
          </tr>
        </tbody></table>
      </section>
      <footer class="list-footer"><span>共 {{ visible.length }} 个任务<span v-if="running"> · {{ running }} 个正在运行</span></span><span class="total-speed"><AppIcon name="arrow" :size="13" />{{ bytes(speed) }}/s</span></footer>
    </main>
    <div v-if="notice" class="toast" :class="{ error: noticeError }" role="status"><AppIcon :name="noticeError ? 'info' : 'check'" :size="18" />{{ notice }}<button type="button" class="icon-button" aria-label="关闭提示" @click="notice = ''"><AppIcon name="close" :size="16" /></button></div>
    <dialog ref="modalRef" class="dialog" :class="{ 'entry-dialog': newDownloadOpen, 'removal-dialog': removeTasks.length, 'settings-dialog': settingsOpen, 'segment-dialog': !!detailsUrl }" :aria-label="loginOpen ? '服务访问密码' : newDownloadOpen ? entryTitle : detailsUrl ? '下载详情' : settingsOpen ? '下载设置' : editTask ? '修改请求头' : '移除任务'" @cancel.prevent="closeModal" @keydown.esc.prevent="closeModal" @click="($event.target === modalRef) && closeModal()">
      <form v-if="modalOpen" @submit.prevent="modalSubmit">
        <div class="dialog-header"><div class="dialog-heading"><span class="dialog-symbol"><AppIcon :name="loginOpen ? 'bolt' : newDownloadOpen ? entryMode === 'extract' ? 'link' : 'plus' : detailsUrl ? 'file' : settingsOpen ? 'settings' : editTask ? 'edit' : 'trash'" :size="22" /></span><div><h2>{{ loginOpen ? '连接下载器' : newDownloadOpen ? entryTitle : detailsUrl ? detailsTask && isFile(detailsTask) ? '文件详情' : '下载分片' : settingsOpen ? '下载设置' : editTask ? '修改请求头并继续' : removeTasks.length > 1 ? `移除所选 ${removeTasks.length} 个任务？` : '移除这个任务？' }}</h2><p>{{ loginOpen ? '输入密码以连接服务' : newDownloadOpen ? entryMode === 'extract' ? '先查找媒体，再选择需要下载的内容' : '粘贴资源地址或平台分享文本，支持批量添加' : detailsUrl ? '查看下载进度与任务状态' : settingsOpen ? '设置保存位置、下载并发与网络' : editTask ? '更新访问凭据，保留已下载的缓存' : '选择需要清理的内容，成品文件默认保留' }}</p></div></div><button v-if="!loginOpen" type="button" class="icon-button" aria-label="关闭对话框" :disabled="modalBusy" @click="closeModal"><AppIcon name="close" /></button></div>
        <div class="dialog-body">
          <template v-if="loginOpen"><p class="dialog-intro">服务已启用密码保护。密码仅在当前浏览器会话中保存。</p><label for="password">访问密码</label><input id="password" v-model="password" type="password" autocomplete="current-password" required autofocus /></template>
          <template v-else-if="newDownloadOpen">
            <div class="entry-modes"><button type="button" :class="{ selected: entryMode === 'download' }" :aria-pressed="entryMode === 'download'" @click="switchEntry('download')">直链 / 分享链接</button><button type="button" :class="{ selected: entryMode === 'extract' }" :aria-pressed="entryMode === 'extract'" @click="switchEntry('extract')">网页提取</button></div>
            <div class="input-caption"><label for="urls">{{ entryMode === 'extract' ? '网页或分享链接' : '下载链接' }} <span class="field-note">{{ entryMode === 'extract' ? '最多 20 个网页' : '一行一个，最多 100 个' }}</span></label><span v-if="lines.length" class="link-count">{{ lines.length }} 个链接</span></div>
            <textarea id="urls" ref="inputRef" v-model="urls" class="url-input" rows="5" :placeholder="entryMode === 'extract' ? 'https://example.com/watch/123' : 'https://example.com/index.m3u8'" :disabled="extractBusy" required spellcheck="false" autocapitalize="off" />
            <template v-if="entryMode === 'download'"><div class="form-grid download-options"><div><label for="download-type">下载类型</label><select id="download-type" v-model="downloadType"><option value="auto">自动识别（含平台分享链接）</option><option value="m3u8">M3U8 / HLS 播放列表</option><option value="file">普通文件直链（MP4、VTT 等）</option><option value="parser">平台解析（抖音 / 微博 / 皮皮虾）</option></select></div><div><label for="filename">文件名称 <span class="field-note">可选</span></label><input id="filename" v-model="title" placeholder="不填则自动生成" maxlength="150" /></div></div><p class="field-help">支持 M3U8、MP4、VTT 与抖音 / 微博 / 皮皮虾分享链接。无后缀文件请选择「普通文件」，伪装后缀的播放列表请选择「M3U8」。微博需填写 Cookie。</p></template>
            <template v-else><div class="form-grid extraction-options"><div><label for="extract-depth">搜索深度</label><select id="extract-depth" v-model.number="extractDepth" :disabled="extractBusy"><option :value="0">仅当前页面</option><option :value="1">向下 1 层</option><option :value="2">向下 2 层</option><option :value="3">向下 3 层</option></select></div><div><label for="extract-path">子页面路径 <span class="field-note">可选</span></label><input id="extract-path" v-model="extractPath" :disabled="extractBusy" placeholder="例如 /play/" /></div></div><p class="field-help">搜索站内链接和播放器 iframe，最多读取 30 页；不会执行网页脚本。</p><button type="button" class="button secondary extract-run" :disabled="!lines.length || modalBusy" @click="runExtraction"><span v-if="extractBusy" class="spinner" /><AppIcon v-else name="search" :size="16" />{{ extractBusy ? '取消提取' : '解析并提取' }}</button>
              <section v-if="extracted" class="extraction-result" aria-label="提取结果"><div class="extraction-summary"><label class="task-checkbox"><input type="checkbox" :checked="!!extracted.items.length && selectedExtracted.length === extracted.items.length" :indeterminate="selectedExtracted.length > 0 && selectedExtracted.length < extracted.items.length" :disabled="!extracted.items.length" @change="toggleExtractedAll" /><span>找到 {{ extracted.items.length }} 个，已选 {{ selectedExtracted.length }} 个</span></label><small>已读取 {{ extracted.pagesVisited }} 页</small></div><p v-if="!extracted.items.length" class="field-help">未找到可下载的媒体。可调整深度、补充 Cookie，或使用实际播放页地址。</p><ul v-else class="extracted-list"><li v-for="item in extracted.items" :key="item.url"><label class="extracted-item"><input v-model="extractedSelection" type="checkbox" :value="item.url" /><span><strong>{{ item.title || host(item.url) }}</strong><small>{{ item.platform || item.type.toUpperCase() }} · {{ host(item.source) }}</small><span class="extracted-url" :title="item.url">{{ item.url }}</span></span></label></li></ul><p v-if="extracted.truncated" class="field-help">已达到提取上限，可缩小范围后继续提取。</p><details v-if="extracted.errors.length" class="extraction-errors"><summary>{{ extracted.errors.length }} 个页面提取失败，查看原因</summary><p v-for="error in extracted.errors" :key="error.url">{{ host(error.url) }}：{{ error.message }}</p></details></section>
            </template>
            <button type="button" class="advanced-toggle" :aria-expanded="advanced" aria-controls="request-options" @click="advanced = !advanced"><span>请求头设置 <small>自动携带 Referer 与 User-Agent</small></span><AppIcon name="chevron" :size="16" :class="{ rotated: advanced }" /></button>
            <div v-show="advanced" id="request-options"><label for="referer">来源页 Referer</label><input id="referer" v-model="source" type="url" :placeholder="originHint" /><p class="field-help">有防盗链时填视频的实际播放页面；留空使用资源域名。</p><label for="headers">附加请求头</label><textarea id="headers" v-model="headers" class="mono" rows="3" placeholder="Cookie: ...&#10;User-Agent: ..." spellcheck="false" /><p class="field-help">支持每行「名称: 值」或 JSON，同名字段覆盖默认设置。</p></div>
          </template>
          <template v-else-if="detailsUrl && detailsTask">
            <div class="detail-file"><span class="hls-tag">{{ kind(detailsTask) }}</span><strong>{{ name(detailsTask) }}</strong><span class="status" :class="detailsTask.status">{{ label(detailsTask) }}</span></div>
            <template v-if="isFile(detailsTask)"><dl class="file-details"><div><dt>文件类型</dt><dd>{{ kind(detailsTask) }} 直链文件</dd></div><div><dt>下载大小</dt><dd>{{ bytes(detailsTask.downloadedSize) }} / {{ detailsTask.size ? bytes(detailsTask.size) : '未知' }}</dd></div><div><dt>下载速度</dt><dd>{{ detailsTask.status === 'resume' ? detailsTask.speedDesc || '0 B/s' : '—' }}</dd></div></dl><p v-if="detailsTask.errmsg" class="form-error">{{ detailsTask.errmsg }}</p><p class="field-help">按原始内容保存。服务器支持 Range 和文件标识时可断点续传。</p></template>
            <template v-else><div class="segment-summary"><strong>已下载分片 <b>{{ segmentCounts.done }}</b><span>/ {{ segments.items.length || detailsTask.tsCount || 0 }}</span></strong><span>{{ bytes(detailsTask.downloadedSize) }}</span></div>
            <fieldset class="segment-legend"><legend class="sr-only">筛选分片</legend><button type="button" :class="{ selected: segmentFilter === 'all' }" @click="filterSegments('all')">全部</button><button type="button" class="done" :class="{ selected: segmentFilter === 'done' }" @click="filterSegments('done')"><i />已完成 {{ segmentCounts.done }}</button><button type="button" class="error" :class="{ selected: segmentFilter === 'error' }" @click="filterSegments('error')"><i />失败 {{ segmentCounts.error }}</button><button type="button" class="pending" :class="{ selected: segmentFilter === 'pending' }" @click="filterSegments('pending')"><i />未完成 {{ segmentCounts.pending }}</button></fieldset>
            <p v-if="segmentError" class="form-error" role="alert">{{ segmentError }}</p>
            <div v-if="segmentLoading" class="segment-empty"><span class="spinner" />正在读取分片状态…</div>
            <div v-else-if="!pageSegments.length" class="segment-empty">{{ segments.items.length ? '没有符合条件的分片' : '解析完成后将在这里显示分片状态' }}</div>
            <div v-else class="segment-grid"><button v-for="segment in pageSegments" :key="segment.index" type="button" :class="[segment.status, { inspected: selectedSegment === segment.index }]" :aria-label="`分片 ${segment.index + 1}：${segmentLabels[segment.status]}`" :title="segment.error || `分片 ${segment.index + 1} · ${segmentLabels[segment.status]}`" @click="selectedSegment = segment.index">{{ segment.index + 1 }}</button></div>
            <div v-if="segmentPages > 1" class="segment-pagination"><button type="button" class="button secondary" :disabled="segmentPage === 1" @click="segmentPage--">上一页</button><span>{{ segmentPage }} / {{ segmentPages }}</span><button type="button" class="button secondary" :disabled="segmentPage === segmentPages" @click="segmentPage++">下一页</button></div>
            <div v-if="inspectedSegment" class="segment-inspector"><strong>分片 {{ inspectedSegment.index + 1 }} · {{ segmentLabels[inspectedSegment.status] }}</strong><span>{{ bytes(inspectedSegment.size) }} · {{ inspectedSegment.attempts }} 次下载尝试</span><p v-if="inspectedSegment.error">{{ inspectedSegment.error }}</p></div>
            <p class="field-help">绿色已完成，蓝色正在下载，红色失败，灰色尚未完成。点击编号可查看详情。</p></template>
          </template>
          <template v-else-if="settingsOpen"><h3 class="form-section-title">保存与下载</h3><label for="save-dir">文件保存目录</label><input id="save-dir" v-model="config.saveDir" required /><p class="field-help">这是运行下载器的服务器目录。</p><div class="form-grid"><div><label for="threads">每任务并发分片</label><input id="threads" v-model.number="config.threadNum" type="number" min="1" max="16" required /></div><div><label for="parallel">同时下载任务</label><input id="parallel" v-model.number="config.maxDownloads" type="number" min="1" max="5" required /></div></div><label for="default-headers">默认请求头</label><textarea id="default-headers" v-model="config.headers" rows="3" class="mono" placeholder="Referer: https://example.com/&#10;Cookie: ..." spellcheck="false" /><p class="field-help">所有新任务共享；单个任务填写的同名请求头优先。</p><h3 class="form-section-title">合并与缓存</h3><label for="ffmpeg">FFmpeg 路径 <span class="field-note">留空使用系统 PATH</span></label><input id="ffmpeg" v-model="config.ffmpegPath" placeholder="ffmpeg" /><label for="merge-timeout">合并无进展超时（秒）</label><input id="merge-timeout" v-model.number="config.mergeTimeout" type="number" min="15" max="3600" required /><label class="check-field"><input v-model="config.delCache" type="checkbox" /><span>合并成功后清理分片缓存<small>失败和暂停时始终保留，方便续传。</small></span></label><h3 class="form-section-title">网络连接</h3><label for="proxy-mode">网络代理</label><select id="proxy-mode" v-model="config.proxyMode"><option value="system">使用系统环境变量</option><option value="disabled">不使用代理</option><option value="custom">自定义 HTTP 代理</option></select><template v-if="config.proxyMode === 'custom'"><label for="proxy-url">代理地址</label><input id="proxy-url" v-model="config.proxyUrl" type="url" placeholder="http://127.0.0.1:7890" required /></template></template>
          <template v-else-if="editTask"><p class="dialog-intro">分片缓存会保留。更新后将自动继续下载。</p><p class="edit-url">{{ editTask.url }}</p><label for="edit-headers">本任务请求头</label><textarea id="edit-headers" v-model="editHeaders" rows="7" class="mono" placeholder="Referer: https://example.com/" spellcheck="false" /><p class="field-help">支持 JSON 或每行「名称: 值」。不填时使用默认设置和自动请求头。</p></template>
          <template v-else-if="removeTasks.length"><p class="dialog-intro">{{ removeTasks.length === 1 ? name(removeTasks[0]) : `将移除所选的 ${removeTasks.length} 个任务，正在运行的任务会先停止。` }}</p><ul v-if="removeTasks.length > 1" class="removal-list"><li v-for="task in removeTasks" :key="task.url">{{ name(task) }}</li></ul><label class="check-field"><input v-model="removeCache" type="checkbox" /><span>同时清理已下载的分片缓存</span></label><label v-if="removeTasks.some(task => task.localVideo)" class="check-field"><input v-model="removeFile" type="checkbox" /><span>同时删除服务器上的成品文件<small>勾选后文件无法恢复。</small></span></label><p class="field-help">未勾选的文件会保留在服务器上。</p></template>
          <p v-if="modalError" class="form-error" role="alert">{{ modalError }}</p>
        </div>
        <div v-if="detailsUrl" class="dialog-footer detail-footer"><span v-if="detailsTask && !isFile(detailsTask)" class="detail-live"><i />每秒自动更新</span><button v-if="detailsTask?.status === 'error' && segmentCounts.error" type="button" class="button primary" :disabled="pending.has(detailsTask.url)" @click="action(detailsTask, 'retry-failed')"><AppIcon name="retry" :size="16" />仅重试失败分片 ({{ segmentCounts.error }})</button><button type="button" class="button secondary" @click="closeModal">关闭</button></div>
        <div v-else class="dialog-footer"><button v-if="!loginOpen" type="button" class="button secondary" :disabled="modalBusy" @click="closeModal">取消</button><button type="submit" class="button" :class="removeTasks.length ? 'danger' : 'primary'" :disabled="modalBusy || extractBusy || (newDownloadOpen && (connection !== 'online' || (entryMode === 'extract' && !selectedExtracted.length)))"><span v-if="modalBusy" class="spinner" />{{ modalBusy ? '请稍候…' : loginOpen ? '连接服务' : newDownloadOpen ? entryMode === 'extract' ? `下载所选 (${selectedExtracted.length})` : lines.length > 1 ? `添加 ${lines.length} 个下载` : '开始下载' : settingsOpen ? '保存设置' : editTask ? '保存并继续' : '确认移除' }}</button></div>
      </form>
    </dialog>
  </div>
</template>
