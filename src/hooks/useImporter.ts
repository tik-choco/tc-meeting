import { useEffect, useRef, useState } from 'preact/hooks';
import { importAudioFile } from '../lib/session';
import { writeHash } from '../lib/hashRoute';
import type { ImportProgress } from '../lib/session';
import type { MeetingAssist } from '../types';
export function useImporter() {
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function start(file: File, opts: { title: string; language: string; keepAudio: boolean; assist?: MeetingAssist }) {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setError(null);
    setProgress({ meetingId: '', ratio: 0 });
    try {
      const id = await importAudioFile(file, { ...opts, signal: current.signal, onProgress: setProgress });
      writeHash({ page: 'meeting', id });
    } catch (cause) { if (!current.signal.aborted) setError(cause); }
    finally { controller.current = null; setProgress(null); }
  }
  return { progress, error, start, cancel: () => controller.current?.abort(), clearError: () => setError(null) };
}
