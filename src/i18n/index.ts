import type { AppErrorCode, Locale } from '../types';
import { en } from './en';
import type { MessageKey, Messages } from './en';
import { ja } from './ja';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';
export type { MessageKey } from './en';
export const messages: Record<Locale, Messages> = { en, ja, 'zh-CN': zhCN, 'zh-TW': zhTW };
export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
export function translator(locale: Locale): Translate {
  return (key, values) => messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
}
export function errorKey(error: unknown): MessageKey {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : typeof error === 'string' ? error : 'unknown';
  const key = `error.${code}`;
  return key in en ? key as `error.${AppErrorCode}` : 'error.unknown';
}
