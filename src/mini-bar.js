const { ipcRenderer } = require('electron');

const miniTime = document.getElementById('mini-time');
const miniDate = document.getElementById('mini-date');
let currentState = {
  clockZone: 'local',
  clockDisplayMode: 'time-date'
};

function resolveZone(zoneValue) {
  const value = String(zoneValue || '').trim();
  if (!value || value.toLowerCase() === 'local') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  return value;
}

function renderMiniBar() {
  const zone = resolveZone(currentState.clockZone);
  const now = new Date();
  miniTime.textContent = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: zone
  }).format(now);

  const displayMode = currentState.clockDisplayMode === 'time' ? 'time' : 'time-date';
  if (displayMode === 'time') {
    miniDate.hidden = true;
    miniDate.textContent = '';
    return;
  }

  miniDate.hidden = false;
  miniDate.textContent = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: zone
  }).format(now);
}

function syncMiniBarState(nextState) {
  if (!nextState || typeof nextState !== 'object') {
    renderMiniBar();
    return;
  }

  currentState = {
    ...currentState,
    ...nextState
  };
  renderMiniBar();
}

ipcRenderer.invoke('state:get').then((state) => {
  if (state) {
    syncMiniBarState({
      clockZone: state.clockZone,
      clockDisplayMode: state.clockDisplayMode
    });
  } else {
    renderMiniBar();
  }
});

ipcRenderer.on('mini-bar:sync', (_event, nextState) => {
  syncMiniBarState(nextState);
});

document.addEventListener('dblclick', () => {
  ipcRenderer.invoke('mini-bar:restore');
});

renderMiniBar();
setInterval(renderMiniBar, 1000);
