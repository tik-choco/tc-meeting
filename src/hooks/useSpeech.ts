import { useEffect, useState } from 'preact/hooks';
import { getSpeechState, subscribeSpeech } from '../lib/speech';
import type { SpeechState } from '../lib/speech';

export function useSpeechState(): SpeechState {
  const [state, setState] = useState(getSpeechState);
  useEffect(() => { const unsubscribe = subscribeSpeech(setState); setState(getSpeechState()); return unsubscribe; }, []);
  return state;
}
