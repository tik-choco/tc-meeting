import { useEffect, useState } from 'preact/hooks';
import { useLlmConfig, useRoomProviders } from '@tik-choco/mistai/preact';
import type { LlmLocalSettings } from '@tik-choco/mistai/preact';
import { loadLocalSettings, subscribeLocalSettings } from '../lib/ai/settings';
import { rooms } from '../lib/ai/network';
export function AiConnections({ settingsOpen }: { settingsOpen: boolean }) {
  const { config } = useLlmConfig();
  const [local, setLocal] = useState<LlmLocalSettings>(() => {
    try { return loadLocalSettings(); } catch { return { tasks: {}, roomProvide: {}, recentModels: [] }; }
  });
  useEffect(() => {
    try { return subscribeLocalSettings(() => { try { setLocal(loadLocalSettings()); } catch { /* Retry on the next settings notification. */ } }); } catch { return; }
  }, []);
  useRoomProviders({ config, consumers: rooms, roomProvide: local.roomProvide, taskRefs: Object.values(local.tasks).map(task => task.ref), reasoningEffort: local.tasks.summary?.reasoningEffort, settingsOpen });
  return null;
}
