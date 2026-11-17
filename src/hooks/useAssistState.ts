import { useEffect, useState } from 'preact/hooks';
import { getAssist } from '../lib/assist';
import { initSession } from '../lib/session';
import type { AssistState } from '../lib/assist';
import { useLocale } from './useLocale';

const EMPTY: AssistState = { leader: false, translatePending: 0, translateActive: 0, proofreadPending: 0, proofreadActive: 0, notesMeetingId: null, notesDraft: '' };

export function useAssistState(): AssistState {
  const { locale } = useLocale();
  const [state, setState] = useState<AssistState>(EMPTY);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void Promise.resolve().then(() => initSession()).then(() => {
      if (!active) return;
      const assist = getAssist();
      assist.setLocale(locale);
      unsubscribe = assist.subscribe(setState);
      setState(assist.getState());
    }).catch(() => { /* AppShell reports session initialization failures. */ });
    return () => { active = false; unsubscribe?.(); };
  }, [locale]);
  return state;
}
