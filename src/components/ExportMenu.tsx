import { useState } from 'preact/hooks';
import { Copy, Download } from 'lucide-preact';
import type { Meeting, Segment } from '../types';
import { exportMeeting } from '../lib/export';
import type { ExportFormat } from '../lib/export';
import { useLocale } from '../hooks/useLocale';
import { validSegmentProofread } from './SegmentRow';
const FORMATS: ExportFormat[] = ['md', 'txt', 'srt', 'vtt', 'json'];
export function ExportMenu({ meeting, segments, onError }: { meeting: Meeting; segments: Segment[]; onError(error: unknown): void }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const [includeTranslation, setIncludeTranslation] = useState(true);
  const [includeCorrections, setIncludeCorrections] = useState(true);
  const hasCorrections = meeting.assist?.proofread === true || segments.some(segment => !!validSegmentProofread(segment));
  const options = () => ({ translation: !!meeting.assist?.translateTo && includeTranslation, proofread: hasCorrections && includeCorrections });
  function download(format: ExportFormat) {
    try {
      const result = exportMeeting(meeting, segments, format, options());
      const url = URL.createObjectURL(new Blob([result.content], { type: result.mime }));
      const link = document.createElement('a'); link.href = url; link.download = result.filename; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { onError(cause); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(exportMeeting(meeting, segments, 'txt', options()).content); setCopied(true); }
    catch (cause) { onError(cause); }
  }
  return <details class="export-menu"><summary><Download size={16} />{t('export')}</summary><div class="export-options">{meeting.assist?.translateTo && <label class="check-field export-translation"><input type="checkbox" checked={includeTranslation} onChange={event => { setIncludeTranslation(event.currentTarget.checked); setCopied(false); }} />{t('includeTranslation')}</label>}{hasCorrections && <label class="check-field export-translation"><input type="checkbox" checked={includeCorrections} onChange={event => { setIncludeCorrections(event.currentTarget.checked); setCopied(false); }} />{t('includeCorrections')}</label>}{FORMATS.map(format => <button key={format} onClick={() => download(format)}>{t('download', { format: format.toUpperCase() })}</button>)}<button onClick={() => void copy()}><Copy size={15} />{t(copied ? 'copied' : 'copy')}</button></div></details>;
}
