import { useEffect, useState } from 'preact/hooks';
import { getQueue } from '../lib/session';
import type { QueueState } from '../lib/queue';
const EMPTY: QueueState = { pending: 0, active: 0, failed: 0, paused: false };
export function useQueueState(): QueueState {
  const [state, setState] = useState<QueueState>(EMPTY);
  useEffect(() => { try { const queue = getQueue(); const unsubscribe = queue.subscribe(setState); setState(queue.getState()); return unsubscribe; } catch { return; } }, []);
  return state;
}
