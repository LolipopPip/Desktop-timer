const { ipcRenderer } = require('electron');
const { DateTime } = require('luxon');

const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const defaultClockColor = '#8f8f94';
const defaultTimerColor = '#6b7280';
const commonZones = [
  { label: '本地时区', value: 'local' },
  { label: 'UTC', value: 'UTC' },
  { label: '中国时间', value: 'Asia/Shanghai' },
  { label: '日本时间', value: 'Asia/Tokyo' },
  { label: '英国时间', value: 'Europe/London' },
  { label: '欧洲时间', value: 'Europe/Paris' },
  { label: '欧洲中部', value: 'Europe/Berlin' },
  { label: '香港时间', value: 'Asia/Hong_Kong' },
  { label: '美国西岸', value: 'America/Los_Angeles' },
  { label: '美国东岸', value: 'America/New_York' }
];

const state = {
  timers: [],
  clockZone: 'local',
  timerZone: 'local',
  clockDisplayMode: 'time-date',
  clockColor: defaultClockColor,
  defaultTimerColor,
  uiScale: 0.88,
  windowBounds: {
    x: 24,
    y: 24,
    width: 400,
    height: 520
  }
};

const clockTime = document.getElementById('clock-time');
const clockDate = document.getElementById('clock-date');
const clockBubble = document.getElementById('clock');
const timerStack = document.getElementById('timers');
const panel = document.getElementById('create-panel');
const closePanelButton = document.getElementById('close-panel');
const clearTimersButton = document.getElementById('clear-timers');
const minimizeWindowButton = document.getElementById('minimize-window');
const form = document.getElementById('timer-form');
const zoneSelect = document.getElementById('timer-zone');
const clockZoneSelect = document.getElementById('clock-zone');
const clockDisplayModeSelect = document.getElementById('clock-display-mode');
const clockColorInput = document.getElementById('clock-color');
const defaultTimerColorInput = document.getElementById('default-timer-color');
const dateInput = document.getElementById('timer-date');
const timeInput = document.getElementById('timer-time');
const resizeHandle = document.getElementById('resize-handle');
const template = document.getElementById('timer-template');

let interactiveMode = false;
let persistTimer = null;
const lastPointer = { x: -1, y: -1 };
const baseWindowSize = { width: 500, height: 620 };
const dragState = {
  active: false,
  mode: null,
  startX: 0,
  startY: 0,
  startBounds: null,
  pendingBounds: null,
  moved: false
};
const timerDragState = {
  active: false,
  timerId: null,
  cardElement: null,
  startX: 0,
  startY: 0,
  offsetX: 0,
  offsetY: 0,
  moved: false
};

populateZoneSelect(zoneSelect, 'local');
populateZoneSelect(clockZoneSelect, 'local');
dateInput.value = todayString();
timeInput.value = timePlusMinutes(5);

bootstrap().catch((error) => {
  window.alert(`Launch failed: ${error.message}`);
});

ipcRenderer.on('panel:toggle', () => {
  if (panel.classList.contains('hidden')) {
    openPanel();
  } else {
    closePanel();
  }
});

ipcRenderer.on('panel:close', () => {
  closePanel();
});

async function bootstrap() {
  const saved = await ipcRenderer.invoke('state:get');
  if (saved) {
    Object.assign(state, saved);
    if (saved.timers) {
      state.timers = saved.timers.map(normalizeTimer).filter(Boolean);
    }
    if (saved.windowBounds) {
      state.windowBounds = { ...state.windowBounds, ...saved.windowBounds };
    }
    if (typeof saved.uiScale === 'number' && saved.uiScale !== 1) {
      state.uiScale = saved.uiScale;
    }
    if (typeof saved.clockZone === 'string') {
      state.clockZone = saved.clockZone;
    }
    if (typeof saved.timerZone === 'string') {
      state.timerZone = saved.timerZone;
    }
    if (typeof saved.clockDisplayMode === 'string') {
      state.clockDisplayMode = saved.clockDisplayMode;
    }
    if (typeof saved.clockColor === 'string') {
      state.clockColor = normalizeHexColor(saved.clockColor) || defaultClockColor;
    }
    if (typeof saved.defaultTimerColor === 'string') {
      state.defaultTimerColor = normalizeHexColor(saved.defaultTimerColor) || defaultTimerColor;
    }
  }

  let timersChanged = false;
  state.timers = state.timers
    .map((timer, index) => {
      const normalizedTimer = normalizeTimer(timer);
      if (!normalizedTimer) {
        return null;
      }

      if (!Number.isFinite(normalizedTimer.x) || !Number.isFinite(normalizedTimer.y)) {
        const initialPosition = getInitialTimerPosition(index);
        normalizedTimer.x = initialPosition.x;
        normalizedTimer.y = initialPosition.y;
        timersChanged = true;
      }

      return normalizedTimer;
    })
    .filter(Boolean);

  if (timersChanged) {
    persist();
  }

  syncZoneSelect(zoneSelect, state.timerZone || 'local');
  syncZoneSelect(clockZoneSelect, state.clockZone || 'local');
  syncClockDisplayMode(state.clockDisplayMode);
  syncColorInput(clockColorInput, state.clockColor, defaultClockColor);
  syncColorInput(defaultTimerColorInput, state.defaultTimerColor, defaultTimerColor);
  applyUiScale(resolveUiScale(state.windowBounds, state.uiScale));
  renderAll();
  updateClock();
  updateTimers();

  setInterval(updateClock, 250);
  setInterval(updateTimers, 250);
  bindMouseTracking();
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function timePlusMinutes(minutes) {
  const now = new Date(Date.now() + minutes * 60 * 1000);
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function populateZoneSelect(selectElement, selectedValue) {
  selectElement.innerHTML = '';
  for (const option of commonZones) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    selectElement.appendChild(node);
  }
  syncZoneSelect(selectElement, selectedValue);
}

function normalizeHexColor(colorValue, fallbackValue = null) {
  const raw = String(colorValue || '').trim();
  if (!raw) {
    return fallbackValue;
  }

  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`;
  }

  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split('').map((char) => char + char).join('').toLowerCase()}`;
  }

  return fallbackValue;
}

function hexToRgb(hexColor) {
  const normalized = normalizeHexColor(hexColor);
  if (!normalized) {
    return null;
  }

  const hex = normalized.slice(1);
  const value = Number.parseInt(hex, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}

function getReadableBubbleTheme(colorValue) {
  const rgb = hexToRgb(colorValue);
  if (!rgb) {
    return null;
  }

  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  const textIsDark = luminance > 0.62;
  const textColor = textIsDark ? '#111111' : '#f5f5f7';
  return {
    bg: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${textIsDark ? '0.42' : '0.36'})`,
    border: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${textIsDark ? '0.82' : '0.92'})`,
    text: textColor,
    muted: textIsDark ? 'rgba(17, 17, 17, 0.70)' : 'rgba(245, 245, 247, 0.68)',
    buttonBg: textIsDark ? 'rgba(0, 0, 0, 0.10)' : 'rgba(255, 255, 255, 0.08)'
  };
}

function applyBubbleTheme(element, colorValue, fallbackColor) {
  const theme = getReadableBubbleTheme(normalizeHexColor(colorValue, fallbackColor));
  if (!theme) {
    element.style.removeProperty('--bubble-bg');
    element.style.removeProperty('--bubble-border');
    element.style.removeProperty('--bubble-text');
    element.style.removeProperty('--bubble-muted');
    element.style.removeProperty('--bubble-button-bg');
    return;
  }

  element.style.setProperty('--bubble-bg', theme.bg);
  element.style.setProperty('--bubble-border', theme.border);
  element.style.setProperty('--bubble-text', theme.text);
  element.style.setProperty('--bubble-muted', theme.muted);
  element.style.setProperty('--bubble-button-bg', theme.buttonBg);
}

function syncColorInput(inputElement, selectedValue, fallbackValue) {
  const nextValue = normalizeHexColor(selectedValue, fallbackValue) || fallbackValue;
  inputElement.value = nextValue;
}

function normalizeTimer(timer) {
  if (!timer || typeof timer !== 'object') {
    return null;
  }

  const zone = resolveZone(timer.zone);
  const normalizedZone = (() => {
    try {
      return DateTime.local().setZone(zone).isValid ? zone : systemZone;
    } catch {
      return systemZone;
    }
  })();
  const label = String(timer.label || 'Timer').trim() || 'Timer';
  const date = String(timer.date || '').trim();
  const time = String(timer.time || '').trim();
  const color = normalizeHexColor(timer.color, state.defaultTimerColor || defaultTimerColor);
  const deadlineUTC = Number.isFinite(timer.deadlineUTC)
    ? timer.deadlineUTC
    : (() => {
        const target = DateTime.fromISO(`${date}T${time}`, { zone: normalizedZone });
        return target.isValid ? target.toMillis() : Date.now() + 5 * 60 * 1000;
      })();

  return {
    id: typeof timer.id === 'string' && timer.id.trim() ? timer.id : `timer_${Math.random().toString(36).slice(2, 9)}`,
    label,
    zone: normalizedZone,
    date,
    time,
    createdUTC: Number.isFinite(timer.createdUTC) ? timer.createdUTC : Date.now(),
    deadlineUTC,
    color,
    minimized: Boolean(timer.minimized),
    doneAtUTC: Number.isFinite(timer.doneAtUTC) ? timer.doneAtUTC : null,
    x: Number.isFinite(timer.x) ? timer.x : null,
    y: Number.isFinite(timer.y) ? timer.y : null
  };
}

function resolveUiScale(bounds, savedScale) {
  if (typeof savedScale === 'number' && savedScale !== 1) {
    return Math.min(Math.max(savedScale, 0.5), 3);
  }

  const derivedScale = Math.min(Math.max(Math.max(
    (bounds?.width || 0) / baseWindowSize.width,
    (bounds?.height || 0) / baseWindowSize.height
  ), 0.5), 3);

  return Number.isFinite(derivedScale) && derivedScale > 0 ? derivedScale : 0.88;
}

function syncClockDisplayMode(selectedValue) {
  const nextValue = selectedValue === 'time' ? 'time' : 'time-date';
  const hasOption = [...clockDisplayModeSelect.options].some((option) => option.value === nextValue);
  clockDisplayModeSelect.value = hasOption ? nextValue : 'time-date';
  state.clockDisplayMode = clockDisplayModeSelect.value;
}

function syncZoneSelect(selectElement, selectedValue) {
  const nextValue = String(selectedValue || 'local');
  const hasOption = [...selectElement.options].some((option) => option.value === nextValue);
  selectElement.value = hasOption ? nextValue : 'local';
}

function getInitialTimerPosition(index = 0) {
  const column = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: 24 + column * 212,
    y: 168 + row * 118
  };
}

function resolveZone(zoneValue) {
  const value = String(zoneValue || '').trim();
  if (!value || value.toLowerCase() === 'local') {
    return systemZone;
  }
  return value;
}

function createTimerFromForm(formData) {
  const zone = resolveZone(formData.get('zone'));
  const label = String(formData.get('label') || 'Timer').trim() || 'Timer';
  const date = String(formData.get('date') || '').trim();
  const time = String(formData.get('time') || '').trim();
  const color = normalizeHexColor(state.defaultTimerColor, defaultTimerColor);

  const target = DateTime.fromISO(`${date}T${time}`, { zone });
  if (!target.isValid) {
    throw new Error(target.invalidExplanation || 'Unable to parse the target time.');
  }

  if (target.toMillis() <= Date.now()) {
    throw new Error('The deadline has already passed.');
  }

  return {
    id: `timer_${Math.random().toString(36).slice(2, 9)}`,
    label,
    zone,
    date,
    time,
    createdUTC: Date.now(),
    deadlineUTC: target.toMillis(),
    color,
    minimized: false,
    doneAtUTC: null,
    ...getInitialTimerPosition(state.timers.length)
  };
}

function updateClock() {
  const now = new Date();
  const selectedClockZone = resolveZone(state.clockZone);
  const displayMode = state.clockDisplayMode === 'time' ? 'time' : 'time-date';
  applyBubbleTheme(clockBubble, state.clockColor, defaultClockColor);
  clockTime.textContent = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: selectedClockZone
  }).format(now);

  if (displayMode === 'time') {
    clockDate.textContent = '';
    clockDate.hidden = true;
    return;
  }

  clockDate.hidden = false;
  clockDate.textContent = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: selectedClockZone
  }).format(now);
}

function formatRemaining(ms) {
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((abs % 1000) / 100);

  if (ms < 0) {
    return `+${days > 0 ? `${days}d ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  if (minutes > 0) {
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${seconds}.${tenths}`;
}

function formatTimerMeta(timer, remainingMs) {
  const zoneLabel = timer.zone === systemZone ? 'Local' : timer.zone;
  let targetText = '--/-- --:--';
  try {
    targetText = new Intl.DateTimeFormat('en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timer.zone
    }).format(new Date(timer.deadlineUTC));
  } catch {
    targetText = 'invalid zone';
  }

  return `${zoneLabel} - ${targetText} - ${remainingMs >= 0 ? 'running' : 'overdue'}`;
}

function renderTimer(timer) {
  const remainingMs = timer.deadlineUTC - Date.now();
  const card = template.content.firstElementChild.cloneNode(true);
  applyBubbleTheme(card, timer.color, state.defaultTimerColor || defaultTimerColor);

  card.dataset.timerId = timer.id;
  card.style.left = `${Number.isFinite(timer.x) ? timer.x : getInitialTimerPosition(0).x}px`;
  card.style.top = `${Number.isFinite(timer.y) ? timer.y : getInitialTimerPosition(0).y}px`;
  card.style.zIndex = String(100 + Math.max(0, state.timers.findIndex((item) => item.id === timer.id)));
  card.classList.toggle('overdue', remainingMs < 0);
  card.classList.toggle('warming', remainingMs >= 0 && remainingMs < 60_000);
  card.classList.toggle('done', timer.doneAtUTC !== null);
  card.classList.toggle('minimized', Boolean(timer.minimized));
  card.classList.toggle('dragging', timerDragState.active && timerDragState.timerId === timer.id);

  card.querySelector('.timer-title').textContent = timer.label;
  card.querySelector('.timer-remaining').textContent = formatRemaining(remainingMs);
  card.querySelector('.timer-meta').textContent = formatTimerMeta(timer, remainingMs);
  const colorInput = card.querySelector('.timer-color');
  colorInput.value = normalizeHexColor(timer.color, state.defaultTimerColor || defaultTimerColor);
  colorInput.onchange = () => {
    timer.color = normalizeHexColor(colorInput.value, state.defaultTimerColor || defaultTimerColor);
    persist();
    renderAll();
  };

  card.querySelector('.timer-snooze').onclick = () => {
    timer.deadlineUTC += 5 * 60 * 1000;
    timer.doneAtUTC = null;
    persist();
    renderAll();
  };

  card.querySelector('.timer-minimize').onclick = () => {
    timer.minimized = !timer.minimized;
    persist();
    renderAll();
  };

  card.querySelector('.timer-delete').onclick = () => {
    state.timers = state.timers.filter((item) => item.id !== timer.id);
    persist();
    renderAll();
  };

  card.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) {
      return;
    }

    beginTimerGesture(timer.id, event, card);
  });

  return card;
}

function renderTimers() {
  const cards = state.timers.map(renderTimer);
  timerStack.replaceChildren(...cards);
}

function updateTimers() {
  const now = Date.now();
  let changed = false;

  for (const timer of state.timers) {
    if (!timer.doneAtUTC && now >= timer.deadlineUTC) {
      timer.doneAtUTC = now;
      changed = true;
    }
  }

  if (changed) {
    persist();
  }

  if (timerDragState.active) {
    return;
  }

  renderTimers();
}

function renderAll() {
  applyUiScale(state.uiScale);
  updateClock();
  renderTimers();
  updateMousePassThrough();
}

function persist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    ipcRenderer.invoke('state:save', {
    timers: state.timers,
    windowBounds: state.windowBounds,
    uiScale: state.uiScale,
    timerZone: state.timerZone,
    clockZone: state.clockZone,
    clockDisplayMode: state.clockDisplayMode,
    clockColor: state.clockColor,
    defaultTimerColor: state.defaultTimerColor
  });
  }, 200);
}

function applyUiScale(scale) {
  const clamped = Math.min(Math.max(scale || 1, 0.5), 3);
  state.uiScale = clamped;
  document.documentElement.style.setProperty('--ui-scale', String(clamped));
}

function openPanel() {
  panel.classList.remove('hidden');
  updateMousePassThrough();
}

function closePanel() {
  panel.classList.add('hidden');
  updateMousePassThrough();
}

function elementMatchesPointer(selector) {
  for (const element of document.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    if (
      lastPointer.x >= rect.left &&
      lastPointer.x <= rect.right &&
      lastPointer.y >= rect.top &&
      lastPointer.y <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}

function updateMousePassThrough() {
  const shouldBeInteractive =
    !panel.classList.contains('hidden') ||
    elementMatchesPointer('#clock') ||
    elementMatchesPointer('.timer-card') ||
    elementMatchesPointer('input, button');

  if (shouldBeInteractive !== interactiveMode) {
    interactiveMode = shouldBeInteractive;
    ipcRenderer.invoke('window:set-ignore-mouse', !shouldBeInteractive);
  }
}

function bindMouseTracking() {
  document.addEventListener('mousemove', (event) => {
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
    updateMousePassThrough();
  });

  document.addEventListener('mouseleave', () => {
    lastPointer.x = -1;
    lastPointer.y = -1;
    if (panel.classList.contains('hidden')) {
      interactiveMode = false;
      ipcRenderer.invoke('window:set-ignore-mouse', true);
    }
  });
}

function isInteractiveTarget(target) {
  return Boolean(target.closest('button, input, textarea, select, label'));
}

function isDraggableTarget(target) {
  return Boolean(target.closest('#clock') || target.closest('#resize-handle'));
}

async function beginWindowGesture(event) {
  if (event.button !== 0 || isInteractiveTarget(event.target) || !isDraggableTarget(event.target)) {
    return;
  }

  const isResize = Boolean(event.target.closest('#resize-handle'));
  const isClock = Boolean(event.target.closest('#clock'));
  const startBounds = await ipcRenderer.invoke('window:get-bounds');

  dragState.active = true;
  dragState.mode = isResize ? 'resize' : isClock ? 'clock' : 'move';
  dragState.startX = event.screenX;
  dragState.startY = event.screenY;
  dragState.startBounds = startBounds;
  dragState.pendingBounds = startBounds;
  dragState.moved = false;

  event.preventDefault();
}

function queueWindowUpdate(nextBounds, snap = false) {
  state.windowBounds = { ...state.windowBounds, ...nextBounds };
  const nextScale = resolveUiScale(state.windowBounds, state.uiScale);
  applyUiScale(nextScale);

  if (dragState.rafId) {
    cancelAnimationFrame(dragState.rafId);
  }

  dragState.pendingBounds = { ...state.windowBounds };
  dragState.rafId = requestAnimationFrame(() => {
    ipcRenderer.invoke('window:set-bounds', { ...dragState.pendingBounds, uiScale: state.uiScale }, { snap });
    dragState.rafId = null;
  });
}

function updateDrag(event) {
  if (!dragState.active || !dragState.startBounds) {
    return;
  }

  const dx = event.screenX - dragState.startX;
  const dy = event.screenY - dragState.startY;

  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
    dragState.moved = true;
  }

  if (dragState.mode === 'resize') {
    const nextWidth = Math.max(260, dragState.startBounds.width + dx);
    const nextHeight = Math.max(220, dragState.startBounds.height + dy);
    queueWindowUpdate({
      x: dragState.startBounds.x,
      y: dragState.startBounds.y,
      width: nextWidth,
      height: nextHeight
    });
    return;
  }

  queueWindowUpdate({
    x: dragState.startBounds.x + dx,
    y: dragState.startBounds.y + dy,
    width: dragState.startBounds.width,
    height: dragState.startBounds.height
  });
}

function beginTimerGesture(timerId, event, cardElement) {
  const timer = state.timers.find((item) => item.id === timerId);
  if (!timer) {
    return;
  }

  const rect = cardElement.getBoundingClientRect();

  timerDragState.active = true;
  timerDragState.timerId = timerId;
  timerDragState.cardElement = cardElement;
  timerDragState.startX = event.clientX;
  timerDragState.startY = event.clientY;
  timerDragState.offsetX = event.clientX - rect.left;
  timerDragState.offsetY = event.clientY - rect.top;
  timerDragState.moved = false;

  event.preventDefault();
  event.stopPropagation();
}

function updateTimerDrag(event) {
  if (!timerDragState.active || !timerDragState.timerId) {
    return;
  }

  const timer = state.timers.find((item) => item.id === timerDragState.timerId);
  if (!timer) {
    return;
  }

  const currentCard = document.querySelector(`.timer-card[data-timer-id="${timer.id}"]`);
  if (currentCard && currentCard !== timerDragState.cardElement) {
    timerDragState.cardElement = currentCard;
  }

  const nextX = event.clientX - timerDragState.offsetX;
  const nextY = event.clientY - timerDragState.offsetY;
  if (Math.abs(event.clientX - timerDragState.startX) > 4 || Math.abs(event.clientY - timerDragState.startY) > 4) {
    timerDragState.moved = true;
  }

  timer.x = nextX;
  timer.y = nextY;
  if (timerDragState.cardElement) {
    timerDragState.cardElement.style.left = `${nextX}px`;
    timerDragState.cardElement.style.top = `${nextY}px`;
  }
}

function clampTimerPosition(timer, cardElement) {
  const maxX = Math.max(12, document.documentElement.clientWidth - cardElement.offsetWidth - 12);
  const maxY = Math.max(12, document.documentElement.clientHeight - cardElement.offsetHeight - 12);
  timer.x = Math.min(Math.max(Number.isFinite(timer.x) ? timer.x : 24, 12), maxX);
  timer.y = Math.min(Math.max(Number.isFinite(timer.y) ? timer.y : 168, 12), maxY);
}

function endTimerDrag() {
  if (!timerDragState.active || !timerDragState.timerId) {
    return;
  }

  const timer = state.timers.find((item) => item.id === timerDragState.timerId);
  if (timer && timerDragState.cardElement) {
    clampTimerPosition(timer, timerDragState.cardElement);
  }

  timerDragState.active = false;
  timerDragState.timerId = null;
  timerDragState.cardElement = null;
  timerDragState.startX = 0;
  timerDragState.startY = 0;
  timerDragState.offsetX = 0;
  timerDragState.offsetY = 0;
  timerDragState.moved = false;
  persist();
  renderAll();
}

function endWindowGesture() {
  if (!dragState.active) {
    return;
  }

  const shouldTogglePanel = dragState.mode === 'clock' && !dragState.moved;
  const finalBounds = dragState.pendingBounds || dragState.startBounds;

  if (dragState.rafId) {
    cancelAnimationFrame(dragState.rafId);
    dragState.rafId = null;
  }

  if (finalBounds) {
    ipcRenderer.invoke('window:set-bounds', { ...finalBounds, uiScale: state.uiScale }, { snap: true });
    state.windowBounds = { ...finalBounds };
    const nextScale = resolveUiScale(finalBounds, state.uiScale);
    applyUiScale(nextScale);
    persist();
  }

  if (shouldTogglePanel) {
    if (panel.classList.contains('hidden')) {
      openPanel();
    } else {
      closePanel();
    }
  }

  dragState.active = false;
  dragState.mode = null;
  dragState.startBounds = null;
  dragState.pendingBounds = null;
  dragState.moved = false;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closePanel();
  }

  if (event.altKey && event.key.toLowerCase() === 't') {
    if (panel.classList.contains('hidden')) {
      openPanel();
    } else {
      closePanel();
    }
  }
});

closePanelButton.addEventListener('click', closePanel);
clearTimersButton.addEventListener('click', () => {
  if (state.timers.length === 0) {
    return;
  }

  if (!window.confirm('清空所有计时器？')) {
    return;
  }

  state.timers = [];
  persist();
  renderAll();
});
minimizeWindowButton.addEventListener('click', () => {
  ipcRenderer.invoke('window:minimize');
});

document.addEventListener('mousedown', beginWindowGesture);
document.addEventListener('mousemove', (event) => {
  updateDrag(event);
  updateTimerDrag(event);
});
document.addEventListener('mouseup', () => {
  endWindowGesture();
  endTimerDrag();
});

clockZoneSelect.addEventListener('change', () => {
  state.clockZone = clockZoneSelect.value;
  persist();
  updateClock();
});

clockDisplayModeSelect.addEventListener('change', () => {
  syncClockDisplayMode(clockDisplayModeSelect.value);
  persist();
  updateClock();
});

clockColorInput.addEventListener('change', () => {
  state.clockColor = normalizeHexColor(clockColorInput.value, defaultClockColor) || defaultClockColor;
  syncColorInput(clockColorInput, state.clockColor, defaultClockColor);
  applyBubbleTheme(clockBubble, state.clockColor, defaultClockColor);
  persist();
});

defaultTimerColorInput.addEventListener('change', () => {
  state.defaultTimerColor = normalizeHexColor(defaultTimerColorInput.value, defaultTimerColor) || defaultTimerColor;
  syncColorInput(defaultTimerColorInput, state.defaultTimerColor, defaultTimerColor);
  persist();
});

zoneSelect.addEventListener('change', () => {
  state.timerZone = zoneSelect.value;
  persist();
  zoneSelect.title = zoneSelect.value;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();

  try {
    const timer = createTimerFromForm(new FormData(form));
    state.timers.unshift(timer);
    persist();
    renderAll();
    const retainedClockZone = state.clockZone;
    const retainedTimerZone = state.timerZone;
    const retainedClockDisplayMode = state.clockDisplayMode;
    const retainedClockColor = state.clockColor;
    const retainedDefaultTimerColor = state.defaultTimerColor;
    form.reset();
    syncZoneSelect(zoneSelect, retainedTimerZone);
    syncZoneSelect(clockZoneSelect, retainedClockZone);
    syncClockDisplayMode(retainedClockDisplayMode);
    syncColorInput(clockColorInput, retainedClockColor, defaultClockColor);
    syncColorInput(defaultTimerColorInput, retainedDefaultTimerColor, defaultTimerColor);
    dateInput.value = todayString();
    timeInput.value = timePlusMinutes(5);
    closePanel();
  } catch (error) {
    window.alert(error.message || 'Failed to create timer.');
  }
});

window.addEventListener('beforeunload', () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
});
