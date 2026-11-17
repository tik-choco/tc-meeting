import { useEffect, useState } from 'preact/hooks';
import { getRecordingState, subscribeRecording } from '../lib/session';
import type { RecordingState } from '../lib/session';
const IDLE: RecordingState = { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 };
export function useRecordingState(): RecordingState {
  const [state, setState] = useState(() => { try { return getRecordingState(); } catch { return IDLE; } });
  useEffect(() => { try { const unsubscribe = subscribeRecording(setState); setState(getRecordingState()); return unsubscribe; } catch { return; } }, []);
  return state;
}
