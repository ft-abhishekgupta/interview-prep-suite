import { useCallback, useEffect, useState } from 'react';

const KEY_DONE = 'sip:done';
const KEY_BOOKMARK = 'sip:bookmarks';
const KEY_LAST = 'sip:last';
const KEY_NOTES = 'sip:notes';
const EVENT = 'sip:storage';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
  } catch {
    /* storage unavailable — degrade silently */
  }
}

function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));

  useEffect(() => {
    const sync = () => setValue(read(key, fallback));
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (v: T) => {
      write(key, v);
      setValue(v);
    },
    [key],
  );

  return [value, set];
}

export function useCompleted() {
  const [done, setDone] = useStored<string[]>(KEY_DONE, []);
  const set = new Set(done);
  return {
    completed: set,
    isDone: (id: string) => set.has(id),
    toggle: (id: string) => setDone(set.has(id) ? done.filter((d) => d !== id) : [...done, id]),
    markDone: (id: string) => {
      if (!set.has(id)) setDone([...done, id]);
    },
    reset: () => setDone([]),
    count: done.length,
  };
}

export function useBookmarks() {
  const [marks, setMarks] = useStored<string[]>(KEY_BOOKMARK, []);
  const set = new Set(marks);
  return {
    bookmarks: marks,
    isBookmarked: (id: string) => set.has(id),
    toggle: (id: string) => setMarks(set.has(id) ? marks.filter((m) => m !== id) : [...marks, id]),
    count: marks.length,
  };
}

export function useLastVisited() {
  const [last, setLast] = useStored<{ id: string; title: string; at: number } | null>(KEY_LAST, null);
  return { last, setLast };
}

export function useNote(id: string) {
  const [notes, setNotes] = useStored<Record<string, string>>(KEY_NOTES, {});
  return {
    note: notes[id] ?? '',
    setNote: (v: string) => {
      const next = { ...notes };
      if (v.trim()) next[id] = v;
      else delete next[id];
      setNotes(next);
    },
  };
}

export function useAllNotes() {
  const [notes] = useStored<Record<string, string>>(KEY_NOTES, {});
  return notes;
}

export function exportProgress() {
  return JSON.stringify(
    {
      completed: read<string[]>(KEY_DONE, []),
      bookmarks: read<string[]>(KEY_BOOKMARK, []),
      notes: read<Record<string, string>>(KEY_NOTES, {}),
      exportedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

export function importProgress(json: string) {
  const data = JSON.parse(json);
  if (Array.isArray(data.completed)) write(KEY_DONE, data.completed);
  if (Array.isArray(data.bookmarks)) write(KEY_BOOKMARK, data.bookmarks);
  if (data.notes && typeof data.notes === 'object') write(KEY_NOTES, data.notes);
}
