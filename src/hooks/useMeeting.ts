import { useEffect, useState } from 'preact/hooks';
import { getMeeting, listSegments, subscribeDb } from '../lib/db';
import type { Meeting, Segment } from '../types';
import { useRecordingState } from './useRecordingState';
export function useMeeting(id: string) {
  const recording = useRecordingState();
  const [data, setData] = useState<{ meeting?: Meeting; segments: Segment[]; loading: boolean; error: unknown }>({ segments: [], loading: true, error: null });
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    setData({ segments: [], loading: true, error: null });
    async function reload() {
      const token = ++generation;
      try {
        const [meeting, segments] = await Promise.all([getMeeting(id), listSegments(id)]);
        if (!disposed && token === generation) setData({ meeting, segments: segments.sort((a, b) => a.seq - b.seq), loading: false, error: null });
      } catch (error) { if (!disposed && token === generation) setData(previous => ({ ...previous, loading: false, error })); }
    }
    void reload();
    let unsubscribe: (() => void) | undefined;
    try { unsubscribe = subscribeDb(change => { if (change.meetingId === id) { clearTimeout(timer); timer = setTimeout(() => void reload(), 150); } }); } catch { /* Keep the view usable while integrations initialize. */ }
    return () => { disposed = true; clearTimeout(timer); unsubscribe?.(); };
  }, [id]);
  return { ...data, recording, live: recording.meetingId === id && recording.phase !== 'idle' };
}
