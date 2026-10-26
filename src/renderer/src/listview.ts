import { computed, ref, watch } from 'vue';
import type { MenuItem } from './components/PopMenu.vue';

/**
 * Sort and group-by of a sidebar list (sites, database services): the
 * drag-and-drop order and the user's groups ("default"), or by name / type.
 * Remembered per window in localStorage (a convenience, not a setting).
 */
export type ListSort = 'default' | 'name' | 'type';
export type ListGroup = 'default' | 'type' | 'none';
export interface ListView {
  sort: ListSort;
  group: ListGroup;
  /** Collapsed sections that are not the user's groups (favorites, type groups, the rest), by section key. */
  collapsed: string[];
  /** Only what has been started (sites with their processes running, services running). */
  runningOnly: boolean;
}

export function useListView(key: string, typeLabel: string, runningLabel = 'Running only') {
  const view = ref<ListView>({ sort: 'default', group: 'default', collapsed: [], runningOnly: false });
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '') as Partial<ListView>;
    if (['default', 'name', 'type'].includes(v.sort ?? '')) view.value.sort = v.sort!;
    if (['default', 'type', 'none'].includes(v.group ?? '')) view.value.group = v.group!;
    if (Array.isArray(v.collapsed)) view.value.collapsed = v.collapsed.filter((x) => typeof x === 'string');
    view.value.runningOnly = v.runningOnly === true;
  } catch {
    /* first run */
  }
  watch(view, (v) => localStorage.setItem(key, JSON.stringify(v)), { deep: true });

  /** The ⇅ menu: one checked entry per sort, one per grouping. */
  const items = computed<MenuItem[]>(() => [
    { label: runningLabel, checked: view.value.runningOnly, action: () => (view.value.runningOnly = !view.value.runningOnly) },
    { label: 'Sort by default (drag & drop order)', separator: true, checked: view.value.sort === 'default', action: () => (view.value.sort = 'default') },
    { label: 'Sort by name', checked: view.value.sort === 'name', action: () => (view.value.sort = 'name') },
    { label: `Sort by ${typeLabel}`, checked: view.value.sort === 'type', action: () => (view.value.sort = 'type') },
    { label: 'Group by default (your groups)', checked: view.value.group === 'default', action: () => (view.value.group = 'default'), separator: true },
    { label: `Group by ${typeLabel}`, checked: view.value.group === 'type', action: () => (view.value.group = 'type') },
    { label: 'No grouping', checked: view.value.group === 'none', action: () => (view.value.group = 'none') },
  ]);
  const custom = computed(() => view.value.sort !== 'default' || view.value.group !== 'default');
  const isCollapsed = (sectionKey: string) => view.value.collapsed.includes(sectionKey);
  const toggle = (sectionKey: string) => {
    view.value.collapsed = isCollapsed(sectionKey) ? view.value.collapsed.filter((k) => k !== sectionKey) : [...view.value.collapsed, sectionKey];
  };
  const setRunningOnly = (on: boolean) => (view.value.runningOnly = on);
  return { view, items, custom, isCollapsed, toggle, setRunningOnly };
}

/** Sorts a list by the view: default keeps `list`'s order (the drag-and-drop one). */
export function sortList<T>(list: T[], sort: ListSort, name: (x: T) => string, type: (x: T) => string): T[] {
  if (sort === 'default') return list;
  const by = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  return [...list].sort((a, b) => (sort === 'type' ? by(type(a), type(b)) || by(name(a), name(b)) : by(name(a), name(b))));
}

/** Groups a list by type: [label, items] pairs in label order. */
export function groupByType<T>(list: T[], type: (x: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const x of list) {
    const t = type(x);
    map.set(t, [...(map.get(t) ?? []), x]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
