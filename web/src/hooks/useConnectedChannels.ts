import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { CHANNEL_OPTIONS } from '../utils/task-utils';

/**
 * Fetch connected IM channel status once on mount.
 * Returns a stable Record<string, boolean> keyed by channel name.
 */
export function useConnectedChannels(): Record<string, boolean> {
  const [connected, setConnected] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .get<Record<string, boolean>>('/api/config/user-im/status')
      .then((data) => {
        const result: Record<string, boolean> = {};
        for (const ch of CHANNEL_OPTIONS) {
          result[ch.key] = !!data[ch.key];
        }
        setConnected(result);
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  return connected;
}
