const { contextBridge, ipcRenderer } = require('electron');
const { DateTime } = require('luxon');
const defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function resolveZone(zone) {
  const cleaned = String(zone || '').trim();
  if (!cleaned || cleaned.toLowerCase() === 'local') {
    return defaultZone;
  }
  return cleaned;
}

contextBridge.exposeInMainWorld('timerBridge', {
  getDefaultZone: () => defaultZone,
  createDeadline: ({ zone, date, time }) => {
    const resolvedZone = resolveZone(zone);
    const target = DateTime.fromISO(`${date}T${time}`, { zone: resolvedZone });

    if (!target.isValid) {
      throw new Error(target.invalidExplanation || '无法解析时间');
    }

    return {
      deadlineUTC: target.toMillis(),
      zone: resolvedZone
    };
  },
  getState: () => ipcRenderer.invoke('state:get'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  setIgnoreMouse: (shouldIgnore) => ipcRenderer.invoke('window:set-ignore-mouse', shouldIgnore)
});
