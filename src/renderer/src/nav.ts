import { computed, ref } from 'vue';

/**
 * Back / forward through the screens visited (← / → in the rail, ⌘[ / ⌘], mouse back / forward, swipe):
 * the rail section, and within it what was picked — a site and its tab, a runtime, a database or storage
 * service, a Settings tab. Kept in memory per window.
 */
export interface NavEntry {
  section: string;
  /** Projects: the site; Database / Storage: the service; Runtimes: the runtime. */
  item?: string | null;
  /** Projects: the site's tab; Settings: its tab. */
  tab?: string | null;
}

const MAX = 50;
const back = ref<NavEntry[]>([]);
const forward = ref<NavEntry[]>([]);
let current: NavEntry | null = null;
/** Set while an entry is being applied, so the changes it causes are not recorded as new steps. */
let applying = false;

export const canBack = computed(() => back.value.length > 0);
export const canForward = computed(() => forward.value.length > 0);
/** The entry App should show now (set by goBack / goForward / goTo). */
export const navApply = ref<{ entry: NavEntry; seq: number } | null>(null);
let seq = 0;

const same = (a: NavEntry, b: NavEntry) => a.section === b.section && (a.item ?? null) === (b.item ?? null) && (a.tab ?? null) === (b.tab ?? null);

/**
 * Records where the window is now. `patch` updates the current entry: a new section starts a fresh
 * entry; a new item within the section drops the old tab (a different site opens on its own tab).
 */
export function navVisit(patch: NavEntry | Partial<NavEntry>): void {
  if (applying) return;
  const prev = current;
  let next: NavEntry;
  if (!prev || (patch.section && patch.section !== prev.section)) next = { section: patch.section ?? prev?.section ?? 'projects', item: patch.item ?? null, tab: patch.tab ?? null };
  else if (patch.item !== undefined && patch.item !== prev.item) next = { ...prev, item: patch.item, tab: patch.tab ?? null };
  else next = { ...prev, ...patch };
  if (prev && same(prev, next)) return;
  // What a view picks by itself right after opening (its first service, its first tab) refines that step
  // rather than adding one: back from it should not stop on the half-loaded screen.
  const sameItem = (prev?.item ?? null) === (next.item ?? null);
  if (prev && prev.section === next.section && ((sameItem && prev.tab == null) || (prev.item == null && prev.tab == null))) {
    current = next;
    return;
  }
  if (prev) {
    back.value = [...back.value, prev].slice(-MAX);
    forward.value = [];
  }
  current = next;
}

function apply(entry: NavEntry) {
  current = entry;
  applying = true;
  navApply.value = { entry, seq: ++seq };
  // Views react over a couple of ticks (section mounts, then its focus watcher): keep recording off until then.
  setTimeout(() => (applying = false), 150);
}

export function goBack(): void {
  const e = back.value.at(-1);
  if (!e || !current) return;
  back.value = back.value.slice(0, -1);
  forward.value = [current, ...forward.value].slice(0, MAX);
  apply(e);
}

export function goForward(): void {
  const e = forward.value[0];
  if (!e || !current) return;
  forward.value = forward.value.slice(1);
  back.value = [...back.value, current].slice(-MAX);
  apply(e);
}

/** Jumps to an entry of the back (negative index from the end) or forward list (from the right-click menu). */
export function goTo(list: 'back' | 'forward', index: number): void {
  if (!current) return;
  if (list === 'back') {
    const target = back.value[index];
    if (!target) return;
    const skipped = back.value.slice(index + 1);
    forward.value = [...skipped, current, ...forward.value].slice(0, MAX);
    back.value = back.value.slice(0, index);
    apply(target);
  } else {
    const target = forward.value[index];
    if (!target) return;
    const skipped = forward.value.slice(0, index);
    back.value = [...back.value, current, ...skipped].slice(-MAX);
    forward.value = forward.value.slice(index + 1);
    apply(target);
  }
}

/** Drops entries pointing at things that no longer exist (a removed site or service). */
export function navPrune(alive: (e: NavEntry) => boolean): void {
  back.value = back.value.filter(alive);
  forward.value = forward.value.filter(alive);
}

export const backList = computed(() => [...back.value].reverse().slice(0, 12));
export const forwardList = computed(() => forward.value.slice(0, 12));
export const backIndex = (i: number) => back.value.length - 1 - i;
