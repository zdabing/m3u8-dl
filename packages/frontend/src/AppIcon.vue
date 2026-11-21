<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  bolt: 'm13 2-9 12h7l-1 8L20 9h-7l1-7Z',
  arrow: 'M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4',
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  pause: 'M8 5v14M16 5v14',
  resume: 'm9 5 11 7-11 7V5Z',
  check: 'm5 12 4 4L19 6',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  file: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 13h8M8 17h5',
  edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  link: 'm9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  chevron: 'm8 10 4 4 4-4',
  retry: 'M20 8a9 9 0 1 0 1 8M20 3v6h-6',
  folder: 'M3 6h7l2 3h9v11H3V6Z',
  info: 'M12 11v6m0-10v1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  sun: 'M12 3v2m0 14v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M3 12h2m14 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z',
  palette: 'M4 8h6m4 0h6M10 8a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM4 16h10m4 0h2M14 16a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z',
  rss: 'M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M5 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  copy: 'M9 9h11v11H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  activity: 'M22 12h-4l-3 7-6-14-3 7H2',
  layers: 'M12 2 2 7l10 5 10-5-10-5ZM2 12l10 5 10-5M2 17l10 5 10-5',
  alert: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z',
  script: 'M8 8l-4 4 4 4m8-8 4 4-4 4m-3-9-2 10',
};
</script>
<template>
  <svg
    :width="size || 20"
    :height="size || 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.file" />
  </svg>
</template>
