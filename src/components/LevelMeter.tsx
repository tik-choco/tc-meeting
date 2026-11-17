import { useLocale } from '../hooks/useLocale';
export function LevelMeter({ level }: { level: number }) {
  const { t } = useLocale();
  const value = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  return <div class="level-meter" role="meter" aria-label={t('level')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}><span style={{ transform: `scaleX(${value})` }} /></div>;
}
