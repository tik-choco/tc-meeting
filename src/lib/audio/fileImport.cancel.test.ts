// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { splitAudioFile } from './fileImport';

afterEach(() => vi.unstubAllGlobals());

it('cancel must settle the import while a long decode is still pending', async () => {
  let finish!: () => void;
  let decoding = false;
  const decoded = new Promise<AudioBuffer>(resolve => {
    finish = () => resolve({ length: 16000, numberOfChannels: 1,
      getChannelData: () => new Float32Array(16000) } as unknown as AudioBuffer);
  });
  class Context {
    decodeAudioData() { decoding = true; return decoded; }
  }
  vi.stubGlobal('OfflineAudioContext', Context);
  const controller = new AbortController();
  let settled = false;
  const outcome = splitAudioFile(new Blob(['long compressed audio']), {
    signal: controller.signal, onChunk: async () => {},
  }).then(() => { settled = true; return 'done'; }, error => { settled = true; return error.code; });
  await vi.waitFor(() => expect(decoding).toBe(true), { interval: 5 });
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 25));
  const settledBeforeDecoderFinished = settled;
  // Always release the fake decoder, including on the failing path.
  finish();
  expect(await outcome).toBe('aborted');
  expect(settledBeforeDecoderFinished).toBe(true);
});
