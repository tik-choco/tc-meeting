import { useEffect, useState } from 'preact/hooks';
import { getSttStatus, subscribeSttStatus } from '../lib/ai/stt';
import type { SttStatus } from '../lib/ai/stt';
const EMPTY: SttStatus = { configured: false, model: '', transport: null };
export function useSttStatus(): SttStatus {
  const [state, setState] = useState<SttStatus>(() => { try { return getSttStatus(); } catch { return EMPTY; } });
  useEffect(() => {
    const refresh = () => { try { setState(getSttStatus()); } catch { setState(EMPTY); } };
    try { const unsubscribe = subscribeSttStatus(refresh); refresh(); return unsubscribe; } catch { return; }
  }, []);
  return state;
}
