import { describe, expect, it } from 'vitest';
import { messages, errorKey, translator } from './index';
import type { AppErrorCode } from '../types';
describe('translations', () => {
  it('has exactly the same nonempty keys and interpolation parameters in every locale', () => {
    const keys = Object.keys(messages.en).sort();
    for (const dictionary of Object.values(messages)) {
      expect(Object.keys(dictionary).sort()).toEqual(keys);
      for (const key of keys) {
        const message = dictionary[key as keyof typeof dictionary];
        expect(message.trim().length).toBeGreaterThan(0);
        expect((message.match(/\{\w+\}/g) ?? []).sort()).toEqual((messages.en[key as keyof typeof messages.en].match(/\{\w+\}/g) ?? []).sort());
      }
    }
  });
  it('localizes every domain error and hides unrecognized technical details', () => {
    const codes: Record<AppErrorCode, true> = {
      'stt-not-configured': true, 'stt-unresolved': true, 'stt-failed': true,
      'tts-failed': true, 'tts-unsupported': true,
      'llm-not-configured': true, 'llm-failed': true, 'mic-denied': true, 'mic-unavailable': true,
      'tab-audio-missing': true, 'recorder-unsupported': true, 'already-recording': true,
      'decode-failed': true, 'file-too-large': true, 'storage-full': true, 'not-found': true, aborted: true, unknown: true,
    };
    for (const code of Object.keys(codes)) expect(errorKey({ code })).toBe(`error.${code}`);
    expect(errorKey(new Error('private connection details'))).toBe('error.unknown');
  });
  it('interpolates counts without losing zero', () => {
    expect(translator('en')('progress', { done: 0, total: 20 })).toBe('0 / 20 segments');
  });
});
