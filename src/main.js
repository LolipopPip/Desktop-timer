const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const debugLogPath = path.join(__dirname, '..', 'startup-debug.log');

function writeDebug(message) {
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Ignore logging failures during startup.
  }
}

process.on('uncaughtException', (error) => {
  writeDebug(`uncaughtException ${error.stack || error.message}`);
  console.error('Uncaught exception in main process:', error);
});

process.on('unhandledRejection', (error) => {
  writeDebug(`unhandledRejection ${error && error.stack ? error.stack : String(error)}`);
  console.error('Unhandled rejection in main process:', error);
});

const defaultState = {
  timers: [],
  clockZone: 'local',
  timerZone: 'local',
  clockColor: '#8f8f94',
  defaultTimerColor: '#6b7280',
  uiScale: 0.88,
  windowBounds: {
    x: 24,
    y: 24,
    width: 400,
    height: 520
  }
};

let mainWindow = null;
let miniBarWindow = null;
let persistedState = null;
let saveTimer = null;
let taskbarTitleTimer = null;
let miniBarKeepAliveTimer = null;
const appWindowTitle = 'Timer Bubble';
const miniBarSize = { width: 160, height: 36 };
const miniBarOverlap = 6;

function statePath() {
  return path.join(app.getPath('userData'), 'timer-state.json');
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return {
      ...defaultState,
      ...parsed,
      windowBounds: {
        ...defaultState.windowBounds,
        ...(parsed.windowBounds || {})
      }
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveZone(zoneValue) {
  const value = String(zoneValue || '').trim();
  if (!value || value.toLowerCase() === 'local') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  return value;
}

function formatTaskbarTitle() {
  const zone = resolveZone(persistedState?.clockZone || 'local');
  const now = new Date();
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: zone
    }).format(now);
  } catch {
    return now.toLocaleTimeString('en-US', { hour12: false });
  }
}

function setWindowTitle(title) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title);
  }
}

function getMiniBarBounds() {
  const referenceBounds = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : persistedState?.windowBounds || screen.getPrimaryDisplay().bounds;
  const display = screen.getDisplayMatching(referenceBounds) || screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const nextX = Math.round(x + (width - miniBarSize.width) / 2);
  const nextY = Math.round(y + height - miniBarSize.height + miniBarOverlap);

  return {
    x: Math.max(x, nextX),
    y: Math.max(y, nextY),
    width: miniBarSize.width,
    height: miniBarSize.height
  };
}

function syncMiniBarState() {
  if (!miniBarWindow || miniBarWindow.isDestroyed()) {
    return;
  }

  miniBarWindow.webContents.send('mini-bar:sync', {
    clockZone: persistedState?.clockZone || 'local',
    clockDisplayMode: persistedState?.clockDisplayMode || 'time-date'
  });
}

function keepMiniBarOnTop() {
  if (miniBarKeepAliveTimer) {
    clearInterval(miniBarKeepAliveTimer);
    miniBarKeepAliveTimer = null;
  }

  if (!miniBarWindow || miniBarWindow.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  miniBarKeepAliveTimer = setInterval(() => {
    if (!miniBarWindow || miniBarWindow.isDestroyed()) {
      if (miniBarKeepAliveTimer) {
        clearInterval(miniBarKeepAliveTimer);
        miniBarKeepAliveTimer = null;
      }
      return;
    }

    if (mainWindow && mainWindow.isMinimized()) {
      miniBarWindow.setAlwaysOnTop(true, 'screen-saver');
      miniBarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      miniBarWindow.moveTop();
    }
  }, 500);
}

function createMiniBarWindow() {
  if (miniBarWindow && !miniBarWindow.isDestroyed()) {
    return miniBarWindow;
  }

  miniBarWindow = new BrowserWindow({
    ...miniBarSize,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  miniBarWindow.setAlwaysOnTop(true, 'screen-saver');
  miniBarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  miniBarWindow.loadFile(path.join(__dirname, 'mini-bar.html'));

  miniBarWindow.on('closed', () => {
    miniBarWindow = null;
  });

  return miniBarWindow;
}

function showMiniBar() {
  const window = createMiniBarWindow();
  if (!window || window.isDestroyed()) {
    return;
  }

  window.setBounds(getMiniBarBounds(), false);
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  syncMiniBarState();
  window.showInactive();
  window.moveTop();
}

function hideMiniBar() {
  if (miniBarWindow && !miniBarWindow.isDestroyed()) {
    miniBarWindow.hide();
  }
}

function stopTaskbarClock() {
  if (taskbarTitleTimer) {
    clearInterval(taskbarTitleTimer);
    taskbarTitleTimer = null;
  }
  setWindowTitle(appWindowTitle);
}

function startTaskbarClock() {
  stopTaskbarClock();
  setWindowTitle(formatTaskbarTitle());
  taskbarTitleTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isMinimized()) {
      stopTaskbarClock();
      return;
    }

    setWindowTitle(formatTaskbarTitle());
  }, 1000);
}

function snapBounds(bounds) {
  const display = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const threshold = 12;
  const snapped = { ...bounds };

  if (Math.abs(bounds.x - dx) <= threshold) {
    snapped.x = dx;
  }

  if (Math.abs(bounds.y - dy) <= threshold) {
    snapped.y = dy;
  }

  const rightEdge = dx + dw - bounds.width;
  const bottomEdge = dy + dh - bounds.height;

  if (Math.abs(bounds.x - rightEdge) <= threshold) {
    snapped.x = rightEdge;
  }

  if (Math.abs(bounds.y - bottomEdge) <= threshold) {
    snapped.y = bottomEdge;
  }

  snapped.width = clamp(bounds.width, 260, dw);
  snapped.height = clamp(bounds.height, 220, dh);
  snapped.x = clamp(snapped.x, dx, dx + dw - snapped.width);
  snapped.y = clamp(snapped.y, dy, dy + dh - snapped.height);
  return snapped;
}

function scheduleSave(nextState) {
  persistedState = nextState;
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    try {
      atomicWriteJson(statePath(), persistedState);
    } catch (error) {
      console.error('Failed to save timer state:', error);
    }
  }, 300);
}

function createWindow() {
  try {
    writeDebug('createWindow start');
    const { width, height, x, y } = persistedState.windowBounds;
    mainWindow = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      resizable: true,
      movable: true,
      skipTaskbar: false,
      hasShadow: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      show: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setTitle(appWindowTitle);

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      writeDebug(`did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`);
      console.error('Renderer failed to load:', { errorCode, errorDescription, validatedURL });
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.on('moved', () => {
      if (!mainWindow) {
        return;
      }
      const bounds = mainWindow.getBounds();
      scheduleSave({
        ...persistedState,
        windowBounds: bounds
      });
    });

    mainWindow.on('resize', () => {
      if (!mainWindow) {
        return;
      }
      const bounds = mainWindow.getBounds();
      scheduleSave({
        ...persistedState,
        windowBounds: bounds
      });
    });

    mainWindow.on('closed', () => {
      stopTaskbarClock();
  if (miniBarWindow && !miniBarWindow.isDestroyed()) {
    miniBarWindow.close();
  }
  if (miniBarKeepAliveTimer) {
    clearInterval(miniBarKeepAliveTimer);
    miniBarKeepAliveTimer = null;
  }
  mainWindow = null;
});

    mainWindow.on('minimize', () => {
      startTaskbarClock();
      showMiniBar();
      keepMiniBarOnTop();
    });

    mainWindow.on('restore', () => {
      stopTaskbarClock();
      hideMiniBar();
      if (miniBarKeepAliveTimer) {
        clearInterval(miniBarKeepAliveTimer);
        miniBarKeepAliveTimer = null;
      }
    });

    mainWindow.on('show', () => {
      if (!mainWindow.isMinimized()) {
        stopTaskbarClock();
      }
    });
  } catch (error) {
    writeDebug(`createWindow error ${error.stack || error.message}`);
    console.error('Failed to create window:', error);
    throw error;
  }
}

function ensureVisible(bounds) {
  const display = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - bounds.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - bounds.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), maxX),
    y: Math.min(Math.max(bounds.y, workArea.y), maxY),
    width: Math.min(bounds.width, workArea.width),
    height: Math.min(bounds.height, workArea.height)
  };
}

app.whenReady().then(() => {
  writeDebug('app ready');
  console.log('Electron app ready');
  persistedState = loadState();
  persistedState.windowBounds = ensureVisible(persistedState.windowBounds);

  createWindow();
  createMiniBarWindow();

  const openPanel = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('panel:toggle');
    }
  };

  const primaryShortcut = globalShortcut.register('Ctrl+Alt+T', openPanel);
  const fallbackShortcut = globalShortcut.register('Alt+T', openPanel);
  const escapeShortcut = globalShortcut.register('Escape', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('panel:close');
    }
  });

  writeDebug(
    `shortcut register ctrl+alt+t=${primaryShortcut} alt+t=${fallbackShortcut} escape=${escapeShortcut}`
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle('state:get', () => persistedState);

ipcMain.handle('state:save', (_event, nextState) => {
  scheduleSave({
    ...persistedState,
    ...nextState
  });
  return true;
});

ipcMain.handle('window:get-bounds', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return persistedState.windowBounds;
  }
  return mainWindow.getBounds();
});

ipcMain.handle('window:set-bounds', (_event, nextBounds, options = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || !nextBounds) {
    return false;
  }

  const current = mainWindow.getBounds();
  const merged = {
    x: typeof nextBounds.x === 'number' ? nextBounds.x : current.x,
    y: typeof nextBounds.y === 'number' ? nextBounds.y : current.y,
    width: typeof nextBounds.width === 'number' ? nextBounds.width : current.width,
    height: typeof nextBounds.height === 'number' ? nextBounds.height : current.height
  };
  const finalized = options.snap ? snapBounds(merged) : merged;

  mainWindow.setBounds(finalized, true);
  scheduleSave({
    ...persistedState,
    windowBounds: finalized,
    uiScale: typeof nextBounds.uiScale === 'number' ? nextBounds.uiScale : persistedState.uiScale
  });
  return true;
});

ipcMain.handle('window:set-ignore-mouse', (_event, shouldIgnore) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(Boolean(shouldIgnore), { forward: true });
  }
  return true;
});

ipcMain.handle('window:minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  mainWindow.minimize();
  startTaskbarClock();
  showMiniBar();
  keepMiniBarOnTop();
  return true;
});

ipcMain.handle('mini-bar:restore', () => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
    mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  hideMiniBar();
  stopTaskbarClock();
  if (miniBarKeepAliveTimer) {
    clearInterval(miniBarKeepAliveTimer);
    miniBarKeepAliveTimer = null;
  }
  return true;
});
