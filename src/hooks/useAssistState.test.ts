import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { useAssistState } from './useAssistState';
import { initSession } from '../lib/session';
import type { AssistState } from '../lib/assist';

const worker = vi.hoisted(() => ({ subscribe: vi.fn(), getState: vi.fn(), setLocale: vi.fn() }));
vi.mock('../lib/assist', () => ({ getAssist: () => worker }));
vi.mock('../lib/session', () => ({ initSession: vi.fn().mockResolvedValue(undefined) }));
const idle: AssistState = { leader: false, translatePending: 0, translateActive: 0, proofreadPending: 0, proofreadActive: 0, notesMeetingId: null, notesDraft: '' };
function Consumer() { const state = useAssistState(); return h('p', null, state.notesDraft); }
afterEach(() => vi.clearAllMocks());

it('subscribes to assist updates and unsubscribes on unmount', async () => {
  let notify!: (state: AssistState) => void;
  let finishInitialization!: () => void;
  const unsubscribe = vi.fn();
  vi.mocked(initSession).mockImplementationOnce(() => new Promise(resolve => { finishInitialization = resolve; }));
  worker.getState.mockReturnValue(idle);
  worker.subscribe.mockImplementation((callback: (state: AssistState) => void) => { notify = callback; return unsubscribe; });
  const root = document.createElement('div'); document.body.append(root);
  await act(() => render(h(Consumer, {}), root));
  await vi.waitFor(() => expect(initSession).toHaveBeenCalledTimes(1));
  expect(worker.subscribe).not.toHaveBeenCalled();
  await act(async () => { finishInitialization(); await Promise.resolve(); });
  await vi.waitFor(() => expect(worker.subscribe).toHaveBeenCalledTimes(1));
  await act(() => notify({ ...idle, notesMeetingId: 'm', notesDraft: 'Streaming' }));
  expect(root.textContent).toBe('Streaming');
  expect(worker.setLocale).toHaveBeenCalledWith('en');
  act(() => render(null, root)); root.remove();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('shows the leader snapshot and later updates while locally a follower', async () => {
  const remote = { ...idle, notesMeetingId: 'm', notesDraft: 'Leader snapshot', translateActive: 2 };
  let notify!: (state: AssistState) => void;
  worker.getState.mockReturnValue(remote);
  worker.subscribe.mockImplementation((callback: (state: AssistState) => void) => { notify = callback; return vi.fn(); });
  const root = document.createElement('div'); document.body.append(root);
  await act(async () => { render(h(Consumer, {}), root); await Promise.resolve(); });
  await vi.waitFor(() => expect(root.textContent).toBe('Leader snapshot'));
  await act(() => notify({ ...remote, notesDraft: 'Next delta' }));
  expect(root.textContent).toBe('Next delta');
  await act(() => notify(idle));
  expect(root.textContent).toBe('');
  act(() => render(null, root)); root.remove();
});
