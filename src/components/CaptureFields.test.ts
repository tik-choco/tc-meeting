import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { TranslationSelect } from './CaptureFields';
import { LocaleProvider } from '../hooks/useLocale';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('uses localized language names and falls back to language codes', async () => {
  localStorage.setItem('tc-meeting:prefs-v1', JSON.stringify({ locale: 'ja' }));
  const root = document.createElement('div'); document.body.append(root);
  const onChange = vi.fn();
  await act(() => render(h(LocaleProvider, { children: h(TranslationSelect, { value: '', onChange }) }), root));
  expect(root.querySelector<HTMLOptionElement>('option[value="ja"]')?.textContent).toBe(new Intl.DisplayNames('ja', { type: 'language' }).of('ja'));
  await act(() => { const select = root.querySelector('select')!; select.value = 'zh-TW'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onChange).toHaveBeenCalledWith('zh-TW');
  act(() => render(null, root));
  vi.spyOn(Intl, 'DisplayNames').mockImplementation(() => { throw new Error('unsupported'); });
  await act(() => render(h(LocaleProvider, { children: h(TranslationSelect, { value: '', onChange }) }), root));
  expect(root.querySelector<HTMLOptionElement>('option[value="zh-TW"]')?.textContent).toBe('zh-TW');
  act(() => render(null, root)); root.remove();
});
