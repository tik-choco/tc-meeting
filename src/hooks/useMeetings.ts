import { useEffect, useState } from 'preact/hooks';
import { listMeetings, listSegments, subscribeDb } from '../lib/db';
import type { Meeting } from '../types';
export interface MeetingListItem { meeting: Meeting; done: number; total: number }
export function useMeetings() {
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function reload() {
      const token = ++generation;
      try {
        const meetings = await listMeetings();
        const next = await Promise.all(meetings.map(async meeting => {
          const segments = await listSegments(meeting.id);
          return { meeting, done: segments.filter(segment => segment.status === 'done' || segment.status === 'empty').length, total: segments.length };
        }));
        if (!disposed && token === generation) { setItems(next); setError(null); }
      } catch (cause) { if (!disposed && token === generation) setError(cause); }
      finally { if (!disposed && token === generation) setLoading(false); }
    }
    void reload();
    let unsubscribe: (() => void) | undefined;
    try { unsubscribe = subscribeDb(() => { clearTimeout(timer); timer = setTimeout(() => void reload(), 180); }); } catch { /* A stub or blocked database must not break rendering. */ }
    return () => { disposed = true; clearTimeout(timer); unsubscribe?.(); };
  }, []);
  return { items, loading, error };
}
