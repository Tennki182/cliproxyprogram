import { watch, FSWatcher } from 'fs';
import { reloadConfig, getConfigPath } from '../config.js';
import { resetProviders } from './provider-factory.js';
import { resetBackend } from './backend-factory.js';
import { resetHttpDispatchers } from './http.js';

let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start watching config.yaml for changes.
 * On change, reloads config and resets cached providers.
 */
export function startConfigWatcher(): void {
  const configPath = getConfigPath();

  try {
    watcher = watch(configPath, (eventType) => {
      if (eventType !== 'change') return;

      // Debounce: wait 500ms to avoid rapid fire
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log('[config-watcher] Config file changed, reloading...');
        const newConfig = reloadConfig();
        if (newConfig) {
          resetProviders();
          resetBackend();
          resetHttpDispatchers();
          console.log('[config-watcher] Config reloaded successfully');
        }
      }, 500);
    });

    console.log(`[config-watcher] Watching ${configPath} for changes`);
  } catch (e) {
    console.warn('[config-watcher] Failed to watch config file:', e);
  }
}

/**
 * Stop the config file watcher.
 */
export function stopConfigWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
