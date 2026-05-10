(() => {
  'use strict';

  // ============================================================
  // TAURI UPDATES
  // ============================================================
  const AUTO_UPDATE_KEY = 'kantrack_auto_update';
  const AUTOSIZE_KEY = 'kantrack_autosize';
  const WINDOW_WIDTH_KEY = 'kantrack_window_width';
  const DEFERRED_UPDATE_KEY = 'kantrack_deferred_update_version';
  const LAST_UPDATE_CHECK_KEY = 'kantrack_last_update_check';
  const UPDATE_RESTART_SHOW_KEY = 'kantrack_show_after_update_restart';
  const FILTERS_KEY = 'kantrack_filters_v1';
  const AUTO_MOVE_COMPLETED_KEY = 'kantrack_auto_move_completed_v1';
  const ONBOARDING_SEEN_KEY = 'kantrack_onboarding_seen_v1';

  let pendingUpdate = null;
  let lastUpdateCheck = readJson(LAST_UPDATE_CHECK_KEY, null);

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (error) {}
  }

  function initUpdater() {
    const tauri = window.__TAURI__;
    const updateModal = document.getElementById('update-modal');
    const updateMessage = document.getElementById('update-message');
    const updateNowButton = document.getElementById('update-now');
    const updateLaterButton = document.getElementById('update-later');
    const updateProgress = document.getElementById('update-progress');
    if (!tauri?.core?.invoke || !updateModal) return;

    function setVisible(isVisible) {
      updateModal.hidden = !isVisible;
    }

    function setMessage(message) {
      if (updateMessage) updateMessage.textContent = message;
    }

    function setBusy(isBusy) {
      if (updateNowButton) updateNowButton.disabled = isBusy;
      if (updateLaterButton) updateLaterButton.disabled = isBusy;
      if (updateProgress) updateProgress.hidden = !isBusy;
    }

    function progressChannel() {
      const channel = new tauri.core.Channel();
      channel.onmessage = (event) => {
        if (event.event === 'Started') setMessage('Downloading update...');
        if (event.event === 'Progress') setMessage('Downloading update...');
        if (event.event === 'Finished') setMessage('Installing update...');
      };
      return channel;
    }

    async function install() {
      if (!pendingUpdate) return;
      setBusy(true);
      setMessage(`Installing KanTrack ${pendingUpdate.version}...`);
      try {
        await tauri.core.invoke('plugin:updater|download_and_install', {
          rid: pendingUpdate.rid,
          onEvent: progressChannel(),
        });
        setMessage('Update installed. Relaunching...');
        localStorage.setItem(UPDATE_RESTART_SHOW_KEY, 'true');
        await tauri.core.invoke('plugin:process|restart');
      } catch (error) {
        const message = typeof error === 'string' ? error : error?.message;
        setMessage(message ? `Update failed: ${message}` : 'Update failed. Try again from Settings.');
        setBusy(false);
      }
    }

    updateNowButton?.addEventListener('click', install);
    updateLaterButton?.addEventListener('click', () => {
      if (pendingUpdate) localStorage.setItem(DEFERRED_UPDATE_KEY, pendingUpdate.version);
      setVisible(false);
    });

    setTimeout(async () => {
      if (localStorage.getItem(AUTO_UPDATE_KEY) === 'false') return;
      try {
        const metadata = await checkForAvailableUpdate();
        if (!metadata) return;
        showUpdatePrompt(metadata);
      } catch (error) {}
    }, 2500);

    function showUpdatePrompt(metadata) {
      pendingUpdate = metadata;
      setBusy(false);
      setMessage(`KanTrack ${metadata.version} is ready. Update now or keep using this version.`);
      setVisible(true);
    }

    window.kantrackShowUpdatePrompt = () => {
      if (pendingUpdate) showUpdatePrompt(pendingUpdate);
    };
  }

  initUpdater();

  function showAfterUpdateRestartIfNeeded() {
    if (localStorage.getItem(UPDATE_RESTART_SHOW_KEY) !== 'true') return;
    localStorage.removeItem(UPDATE_RESTART_SHOW_KEY);
    window.__TAURI__?.core?.invoke?.('show_main_window').catch(() => {});
  }

  async function checkForAvailableUpdate() {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) return null;
    const currentVersion = await tauri.core.invoke('plugin:app|version').catch(() => null);
    const metadata = await tauri.core.invoke('plugin:updater|check');
    lastUpdateCheck = {
      checkedAt: Date.now(),
      currentVersion,
      availableVersion: metadata?.version || null
    };
    writeJson(LAST_UPDATE_CHECK_KEY, lastUpdateCheck);
    if (!metadata) {
      localStorage.removeItem(DEFERRED_UPDATE_KEY);
      pendingUpdate = null;
      return null;
    }
    pendingUpdate = metadata;
    return metadata;
  }

  // ============================================================
  // CONSTANTS
  // ============================================================
  const STORAGE_KEY = 'kantrack_v4';
  const SCHEMA_VERSION = 4;
  const PRIO_CYCLE = [null, 'low', 'medium', 'high'];
  const STATUS_CYCLE = [null, 'done', 'incomplete', 'cancel'];
  const LANE_COLORS = ['none', 'blue', 'orange', 'green', 'purple', 'pink', 'gray'];
  const TAG_COLORS = ['none', 'blue', 'orange', 'green', 'purple', 'pink', 'gray'];
  const MAX_INLINE_TAGS = 2;
  const MIN_WINDOW_WIDTH = 560;
  const MIN_WINDOW_HEIGHT = 200;
  const MAX_WINDOW_HEIGHT = 820;

  // Click-vs-drag tuning
  const CLICK_MAX_MOVEMENT = 5;   // px
  const CLICK_MAX_DURATION = 500; // ms
  const DBLCLICK_DELAY = 220;     // wait this long before single-click acts on

  // Undo toast tuning
  const UNDO_TIMEOUT_MS = 5000;

  const DND_MOVE_THRESHOLD = 5; // px before a pointerdown becomes a drag

  function tid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function lid() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function defaultLanes() {
    return [
      { id: lid(), name: 'TODO', color: 'blue' },
      { id: lid(), name: 'IN PROGRESS', color: 'orange' },
      { id: lid(), name: 'DONE', color: 'green' }
    ];
  }

  // ============================================================
  // STORAGE
  // ============================================================
  const Storage = {
    available: true,
    warningEl: null,

    save(state) {
      if (!this.available) return false;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        return true;
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') {
          this.showWarning('Storage full — some changes may not save.');
          this.available = false;
        } else {
          this.showWarning('Storage unavailable. Changes will not persist.');
          this.available = false;
        }
        return false;
      }
    },

    load() {
      let raw = null;
      try { raw = localStorage.getItem(STORAGE_KEY); }
      catch (e) { this.available = false; this.showWarning('Storage unavailable.'); return null; }
      if (!raw) return migrateLegacyState();
      try { return this.validate(JSON.parse(raw)); }
      catch (e) { this.showWarning('Stored data was corrupt. Starting fresh.'); return null; }
    },

    validate(state) {
      if (!state || typeof state !== 'object') return null;
      if (state.version !== SCHEMA_VERSION) return null;
      if (!Array.isArray(state.lanes) || state.lanes.length === 0) state.lanes = defaultLanes();
      if (!Array.isArray(state.tasks)) state.tasks = [];
      if (!state.tagColors || typeof state.tagColors !== 'object') state.tagColors = {};

      state.lanes.forEach(l => {
        if (!l.id) l.id = lid();
        if (!l.name) l.name = 'Lane';
        if (!l.color || !LANE_COLORS.includes(l.color)) l.color = 'blue';
      });

      state.tasks.forEach(t => {
        if (!t.id) t.id = tid();
        if (!t.text) t.text = '';
        if (t.text === 'Hover for ← → × buttons') t.text = 'Use shortcuts to move tasks';
        if (t.text === 'Press ⌘K to search, n for new') t.text = 'Press / to search, A for new';
        if (!t.laneId || !state.lanes.find(l => l.id === t.laneId)) t.laneId = state.lanes[0].id;
        if (!t.created) t.created = Date.now();
        if (!Array.isArray(t.tags)) t.tags = [];
        if (t.prio && !['low', 'medium', 'high'].includes(t.prio)) t.prio = null;
        if (!t.status || !STATUS_CYCLE.includes(t.status)) t.status = null;
      });
      Object.keys(state.tagColors).forEach(tag => {
        if (!TAG_COLORS.includes(state.tagColors[tag])) delete state.tagColors[tag];
      });

      return state;
    },

    showWarning(text) {
      if (this.warningEl) return;
      const el = document.createElement('div');
      el.className = 'storage-warning';
      el.innerHTML = `<span>⚠ ${text}</span><span class="storage-warning-x">✕</span>`;
      el.querySelector('.storage-warning-x').onclick = () => {
        if (el.parentNode) el.parentNode.removeChild(el);
        this.warningEl = null;
      };
      document.querySelector('.board').appendChild(el);
      this.warningEl = el;
    }
  };

  function migrateLegacyState() {
    let legacy = null;
    try {
      legacy = JSON.parse(localStorage.getItem('wigify_kanban_v2') || 'null');
    } catch (e) {
      return null;
    }

    if (!Array.isArray(legacy) || legacy.length === 0) return null;

    const lanes = defaultLanes();
    const laneMap = { todo: lanes[0].id, wip: lanes[1].id, done: lanes[2].id };
    const migrated = {
      version: SCHEMA_VERSION,
      lanes,
      tagColors: {},
      tasks: legacy.map(task => ({
        id: task.id || tid(),
        laneId: laneMap[task.lane] || lanes[0].id,
        text: task.text || '',
        prio: ['low', 'medium', 'high'].includes(task.prio) ? task.prio : null,
        tags: Array.isArray(task.tags) ? task.tags : [],
        created: Date.now(),
        due: task.due || null,
        desc: task.notes || task.desc || '',
        status: task.lane === 'done' ? 'done' : null,
      })),
    };
    Storage.save(migrated);
    return migrated;
  }

  // ============================================================
  // STATE
  // ============================================================
  function createDefaultState() {
    const lanes = defaultLanes();
    return {
      version: SCHEMA_VERSION,
      lanes,
      tagColors: { demo: 'blue' },
      tasks: [
        { id: tid(), laneId: lanes[0].id, text: 'Click a task to expand it', prio: null, tags: [], created: Date.now(), due: null, desc: '', status: null },
        { id: tid(), laneId: lanes[0].id, text: 'Add tasks from the new task row', prio: 'low', tags: [], created: Date.now(), due: null, desc: '', status: null },
        { id: tid(), laneId: lanes[1].id, text: 'Organize tasks by priority', prio: 'medium', tags: ['demo'], created: Date.now(), due: null, desc: '', status: null },
        { id: tid(), laneId: lanes[2].id, text: 'Press / to search, A for new', prio: null, tags: [], created: Date.now(), due: null, desc: '', status: 'done' }
      ]
    };
  }

  const hadStoredBoard = (() => {
    try { return Boolean(localStorage.getItem(STORAGE_KEY)); }
    catch (error) { return true; }
  })();

  let state = Storage.load() || createDefaultState();
  const savedFilters = readJson(FILTERS_KEY, {});
  let autoMoveCompleted = readJson(AUTO_MOVE_COMPLETED_KEY, { enabled: false, laneId: null });

  const ui = {
    expandedTaskId: null,         // single-expansion model
    searchQuery: '',
    activeTagFilters: new Set(Array.isArray(savedFilters.activeTagFilters) ? savedFilters.activeTagFilters : []),
    activePrioFilter: savedFilters.activePrioFilter || null,
    sortMode: savedFilters.sortMode || null,
    draggedTaskId: null,
    draggedLaneId: null,
    dragKind: null,
    dropIndicator: null,
    laneDropIndicator: null,
    openPopover: null,
    openPopoverAnchor: null,
    focusedTaskId: null,          // single keyboard selection source of truth
    activeLaneId: null,
    lastSelectionY: null,
    pendingClick: null,           // { taskId, startX, startY, startTime }
    clickToggleTimer: null,
    autosize: localStorage.getItem(AUTOSIZE_KEY) !== 'false',
    lastWindowWidth: Number(localStorage.getItem(WINDOW_WIDTH_KEY)) || null,
    autosizeTimer: null,
    autosizeFrame: null,
    layoutInFlight: false,
    pendingLayout: null,
    lastLayoutSignature: '',
    layoutAnimationFrame: null,
    layoutAnimationResolve: null,
    layoutAnimationToken: 0,
    windowWidthPersistTimer: null,
    popoverPositionFrame: null,
    resizeClassTimer: null
  };

  function persist() { Storage.save(state); }

  function persistAutoMoveCompleted() {
    writeJson(AUTO_MOVE_COMPLETED_KEY, {
      enabled: Boolean(autoMoveCompleted.enabled && autoMoveCompleted.laneId),
      laneId: autoMoveCompleted.laneId || null
    });
  }

  function loadAutoMoveCompleted() {
    autoMoveCompleted = readJson(AUTO_MOVE_COMPLETED_KEY, { enabled: false, laneId: null }) || { enabled: false, laneId: null };
    sanitizeAutoMoveCompleted();
    return autoMoveCompleted;
  }

  function sanitizeAutoMoveCompleted() {
    const validLane = autoMoveCompleted?.laneId
      ? state.lanes.some(lane => lane.id === autoMoveCompleted.laneId)
      : false;
    if (!autoMoveCompleted || !validLane) {
      autoMoveCompleted = { enabled: false, laneId: null };
      persistAutoMoveCompleted();
      return;
    }
    autoMoveCompleted.enabled = Boolean(autoMoveCompleted.enabled);
    persistAutoMoveCompleted();
  }

  sanitizeAutoMoveCompleted();
  persist();

  function persistFilters() {
    writeJson(FILTERS_KEY, {
      sortMode: ui.sortMode,
      activePrioFilter: ui.activePrioFilter,
      activeTagFilters: [...ui.activeTagFilters]
    });
  }

  function resetFilters() {
    ui.sortMode = null;
    ui.activePrioFilter = null;
    ui.activeTagFilters.clear();
    persistFilters();
  }

  function resetBoardToDefault() {
    state = createDefaultState();
    ui.expandedTaskId = null;
    ui.focusedTaskId = null;
    ui.activeLaneId = null;
    ui.searchQuery = '';
    if (els.searchInput) els.searchInput.value = '';
    if (els.searchWrap) {
      els.searchWrap.classList.remove('has-text', 'is-open');
    }
    sanitizeAutoMoveCompleted();
    resetFilters();
    renderAndPersist();
  }

  function setAutosize(enabled) {
    ui.autosize = Boolean(enabled);
    localStorage.setItem(AUTOSIZE_KEY, String(ui.autosize));
    syncAutosizeMenu();
    syncWindowLayout();
  }

  function syncAutosizeMenu() {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) return;
    tauri.core.invoke('sync_autosize_menu', { enabled: ui.autosize }).catch(() => {});
  }

  function syncLaunchAtLoginMenu(enabled) {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) return;
    tauri.core.invoke('sync_startup_menu', { enabled: Boolean(enabled) }).catch(() => {});
  }

  function minWindowWidthForBoard() {
    const laneCount = Math.max(3, state.lanes.length);
    const boardStyle = getComputedStyle(els.board);
    const lanesStyle = getComputedStyle(els.lanes);
    const laneEl = els.lanes.querySelector('.lane');
    const laneMinWidth = laneEl ? parseFloat(getComputedStyle(laneEl).minWidth || '136') : 136;
    const laneGap = parseFloat(lanesStyle.gap || '7') || 7;
    const boardChrome =
      parseFloat(boardStyle.paddingLeft || '0') +
      parseFloat(boardStyle.paddingRight || '0') +
      parseFloat(boardStyle.borderLeftWidth || '0') +
      parseFloat(boardStyle.borderRightWidth || '0');
    const lanesWidth = (laneCount * laneMinWidth) + (Math.max(0, laneCount - 1) * laneGap);
    const wrap = document.querySelector('.lanes-wrap');
    const overflowWidth = wrap && wrap.scrollWidth > wrap.clientWidth + 1
      ? window.innerWidth + (wrap.scrollWidth - wrap.clientWidth)
      : 0;
    return Math.ceil(Math.max(MIN_WINDOW_WIDTH, boardChrome + lanesWidth + 12, overflowWidth + 12));
  }

  function rememberWindowWidth(width = window.innerWidth) {
    const value = Math.round(Number(width) || 0);
    if (value < MIN_WINDOW_WIDTH) return;
    ui.lastWindowWidth = value;
  }

  function persistRememberedWindowWidth() {
    const value = Math.round(Number(ui.lastWindowWidth) || 0);
    if (value < MIN_WINDOW_WIDTH) return;
    try { localStorage.setItem(WINDOW_WIDTH_KEY, String(value)); }
    catch (error) {}
  }

  function scheduleWindowWidthPersistence(width = window.innerWidth) {
    rememberWindowWidth(width);
    clearTimeout(ui.windowWidthPersistTimer);
    ui.windowWidthPersistTimer = setTimeout(persistRememberedWindowWidth, 220);
  }

  function markWindowResizing() {
    document.body.classList.add('is-window-resizing');
    clearTimeout(ui.resizeClassTimer);
    ui.resizeClassTimer = setTimeout(() => {
      document.body.classList.remove('is-window-resizing');
    }, 140);
  }

  function schedulePopoverPosition() {
    if (ui.popoverPositionFrame) return;
    ui.popoverPositionFrame = requestAnimationFrame(() => {
      ui.popoverPositionFrame = null;
      if (ui.openPopover) positionPopover();
    });
  }

  function laneNaturalHeight(lane) {
    const header = lane.querySelector('.lane-header');
    const body = lane.querySelector('.lane-body');
    if (!body) return header?.offsetHeight || 0;

    const bodyStyle = getComputedStyle(body);
    const bodyPadding =
      parseFloat(bodyStyle.paddingTop || '0') + parseFloat(bodyStyle.paddingBottom || '0');
    const bodyGap = parseFloat(bodyStyle.gap || '0') || 0;
    const items = [...body.children].filter(el => !el.classList.contains('drop-indicator'));
    const itemHeight = items.reduce((total, el) => total + el.offsetHeight, 0);
    const gaps = Math.max(0, items.length - 1) * bodyGap;
    return (header?.offsetHeight || 0) + bodyPadding + itemHeight + gaps;
  }

  function desiredWindowHeight() {
    const boardStyle = getComputedStyle(els.board);
    const boardPadding =
      parseFloat(boardStyle.paddingTop || '0') + parseFloat(boardStyle.paddingBottom || '0');
    const boardGap = parseFloat(boardStyle.gap || '0') || 0;
    const topbar = document.querySelector('.topbar');
    const filterStrip = els.filterStrip && !els.filterStrip.hidden ? els.filterStrip : null;
    const laneHeights = [...document.querySelectorAll('.lane')].map(laneNaturalHeight);
    const lanesHeight = Math.max(...laneHeights, 0);
    const visibleSections = 1 + (filterStrip ? 1 : 0) + 1;
    const gaps = Math.max(0, visibleSections - 1) * boardGap;
    const chrome =
      boardPadding + (topbar?.offsetHeight || 0) + (filterStrip?.offsetHeight || 0) + gaps + 22;
    const baseHeight = Math.ceil(chrome + lanesHeight);
    const popoverHeight = openPopoverRequiredHeight();
    const overlayHeight = overlayRequiredHeight();
    return Math.max(MIN_WINDOW_HEIGHT, Math.min(MAX_WINDOW_HEIGHT, Math.max(baseHeight, popoverHeight, overlayHeight)));
  }

  function openPopoverRequiredHeight() {
    if (!ui.openPopover) return 0;
    const rect = ui.openPopover.getBoundingClientRect();
    const naturalHeight = ui.openPopover.scrollHeight || rect.height;
    return Math.ceil(rect.top + naturalHeight + 14);
  }

  function overlayRequiredHeight() {
    const modal = document.querySelector('.onboarding-modal:not([hidden]), .update-modal:not([hidden])');
    if (!modal) return 0;
    const card = modal.querySelector('.onboarding-card, .update-card');
    const modalStyle = getComputedStyle(modal);
    const padding =
      parseFloat(modalStyle.paddingTop || '0') + parseFloat(modalStyle.paddingBottom || '0');
    const cardHeight = card ? Math.max(card.scrollHeight, card.getBoundingClientRect().height) : modal.scrollHeight;
    return Math.ceil(cardHeight + padding + 8);
  }

  function currentWindowLayout(options = {}) {
    const minWidth = minWindowWidthForBoard();
    const preferredWidth = Number(options.width || ui.lastWindowWidth || 0);
    return {
      minWidth,
      width: preferredWidth ? Math.max(minWidth, preferredWidth) : null,
      height: ui.autosize ? desiredWindowHeight() : null,
      animate: options.animate !== false
    };
  }

  function layoutSignature(layout) {
    return [
      Math.round(layout.minWidth || 0),
      layout.width === null ? 'auto' : Math.round(layout.width || 0),
      layout.height === null ? 'auto' : Math.round(layout.height || 0)
    ].join(':');
  }

  function cancelLayoutAnimation() {
    ui.layoutAnimationToken += 1;
    if (ui.layoutAnimationFrame) cancelAnimationFrame(ui.layoutAnimationFrame);
    ui.layoutAnimationFrame = null;
    if (ui.layoutAnimationResolve) ui.layoutAnimationResolve(false);
    ui.layoutAnimationResolve = null;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function invokeWindowLayout(tauri, layout) {
    return tauri.core.invoke('update_main_window_layout', { layout });
  }

  function animateWindowLayout(tauri, targetLayout, signature) {
    const targetHeight = Number(targetLayout.height);
    const startHeight = Math.round(window.innerHeight || targetHeight);
    const delta = targetHeight - startHeight;
    if (!Number.isFinite(targetHeight) || Math.abs(delta) < 8) {
      return invokeWindowLayout(tauri, targetLayout).then(() => true).catch(() => false);
    }

    cancelLayoutAnimation();
    const token = ui.layoutAnimationToken;
    const duration = delta > 0 ? 170 : 190;
    const startedAt = performance.now();

    return new Promise(resolve => {
      ui.layoutAnimationResolve = resolve;
      const step = async now => {
        if (token !== ui.layoutAnimationToken) return;

        const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
        const height = Math.round(startHeight + delta * easeOutCubic(progress));
        try {
          await invokeWindowLayout(tauri, { ...targetLayout, height, animate: false });
        } catch (error) {}

        if (token !== ui.layoutAnimationToken) return;
        if (progress < 1) {
          ui.layoutAnimationFrame = requestAnimationFrame(step);
          return;
        }

        ui.layoutAnimationFrame = null;
        ui.layoutAnimationResolve = null;
        ui.lastLayoutSignature = signature;
        resolve(true);
      };

      ui.layoutAnimationFrame = requestAnimationFrame(step);
    });
  }

  async function applyWindowLayout(options = {}) {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) return;
    const layout = currentWindowLayout(options);
    const signature = layoutSignature(layout);
    if (signature === ui.lastLayoutSignature && !options.force) return;
    ui.pendingLayout = { layout, signature };
    if (ui.layoutInFlight) {
      cancelLayoutAnimation();
      return;
    }

    ui.layoutInFlight = true;
    while (ui.pendingLayout) {
      const next = ui.pendingLayout;
      ui.pendingLayout = null;
      try {
        if (next.layout.animate && next.layout.height !== null) {
          await animateWindowLayout(tauri, next.layout, next.signature);
        } else {
          cancelLayoutAnimation();
          await invokeWindowLayout(tauri, next.layout);
          ui.lastLayoutSignature = next.signature;
        }
      } catch (error) {}
    }
    ui.layoutInFlight = false;
  }

  function syncWindowLayout() {
    clearTimeout(ui.autosizeTimer);
    ui.autosizeTimer = setTimeout(() => applyWindowLayout(), 90);
  }

  function syncWindowLayoutSoon() {
    if (ui.autosizeFrame) cancelAnimationFrame(ui.autosizeFrame);
    ui.autosizeFrame = requestAnimationFrame(() => {
      ui.autosizeFrame = null;
      syncWindowLayout();
    });
  }

  window.kantrackPrepareForShow = () => {
    clearTimeout(ui.autosizeTimer);
    if (ui.autosizeFrame) cancelAnimationFrame(ui.autosizeFrame);
    ui.autosizeFrame = null;
    applyWindowLayout({ force: true, animate: false });
  };

  window.kantrackRestoreSelection = () => {
    requestAnimationFrame(() => restoreSelection({ focus: true }));
  };

  window.kantrackSetAutosize = enabled => {
    setAutosize(enabled);
  };

  window.kantrackSetLaunchAtLogin = enabled => {
    syncLaunchAtLoginMenu(Boolean(enabled));
  };

  window.addEventListener('storage', event => {
    if (event.key === AUTO_MOVE_COMPLETED_KEY) loadAutoMoveCompleted();
  });

  function insertTaskLineBreak() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode('\n'));
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // ============================================================
  // DOM REFS
  // ============================================================
  const els = {
    board: document.getElementById('board'),
    lanes: document.getElementById('lanes'),
    overlayRoot: document.getElementById('overlay-root'),
    toastRoot: document.getElementById('toast-root'),
    searchInput: document.getElementById('search-input'),
    searchClear: document.getElementById('search-clear'),
    searchWrap: document.querySelector('.search-wrap'),
    topbar: document.querySelector('.topbar'),
    filterBtn: document.getElementById('filter-btn'),
    infoBtn: document.getElementById('info-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    addLaneBtn: document.getElementById('add-lane-btn'),
    filterStrip: document.getElementById('filter-strip')
  };

  // ============================================================
  // HELPERS
  // ============================================================
  function parseTags(text) {
    const tags = [];
    const re = /(?:^|\s)#([a-zA-Z0-9_-]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = m[1].toLowerCase();
      if (!tags.includes(t)) tags.push(t);
    }
    return tags;
  }

  function colorValue(color) {
    return {
      blue: '#7b9fe8',
      orange: '#e8a44a',
      green: '#5dc47e',
      purple: '#8c77d8',
      pink: '#c2668f',
      gray: '#8993a2'
    }[color] || 'rgba(53, 60, 74, 0.28)';
  }

  function tagColor(tag) {
    return state.tagColors?.[tag] || 'none';
  }

  function applyTagColor(el, tag) {
    const color = tagColor(tag);
    el.dataset.color = color;
    el.style.setProperty('--tag-accent', colorValue(color));
  }

  function normalizeTagName(value) {
    return (value || '').replace(/^#/, '').trim().toLowerCase();
  }

  function renameTagEverywhere(oldTag, newTag) {
    const normalized = normalizeTagName(newTag);
    if (!oldTag || !/^[a-z0-9_-]+$/.test(normalized)) return false;
    state.tasks.forEach(task => {
      if (!Array.isArray(task.tags)) return;
      task.tags = [...new Set(task.tags.map(tag => tag === oldTag ? normalized : tag))];
    });
    if (ui.activeTagFilters.has(oldTag)) {
      ui.activeTagFilters.delete(oldTag);
      ui.activeTagFilters.add(normalized);
    }
    if (state.tagColors?.[oldTag] && oldTag !== normalized) {
      state.tagColors[normalized] = state.tagColors[oldTag];
      delete state.tagColors[oldTag];
    }
    return true;
  }

  function laneIndexOf(laneId) { return state.lanes.findIndex(l => l.id === laneId); }
  function taskMatchesSearch(task, q) {
    if (!q) return true;
    q = q.toLowerCase();
    if (task.text && task.text.toLowerCase().includes(q)) return true;
    if (task.desc && task.desc.toLowerCase().includes(q)) return true;
    if (task.tags && task.tags.some(t => t.toLowerCase().includes(q))) return true;
    return false;
  }

  function filteredTasksForLane(lane) {
    let list = state.tasks.filter(t => t.laneId === lane.id);
    if (ui.searchQuery) list = list.filter(t => taskMatchesSearch(t, ui.searchQuery));
    if (ui.activePrioFilter) list = list.filter(t => t.prio === ui.activePrioFilter);
    if (ui.activeTagFilters.size > 0) {
      list = list.filter(t => {
        if (!t.tags) return false;
        for (const tag of ui.activeTagFilters) if (!t.tags.includes(tag)) return false;
        return true;
      });
    }
    return list;
  }

  function sortTasks(list, lane) {
    const copy = [...list];
    const boardPrioritySort = ui.sortMode === 'priority-low'
      ? 'low'
      : ui.sortMode === 'priority-high' || ui.sortMode === 'priority'
        ? 'high'
        : null;
    const prioritySort = boardPrioritySort;
    if (prioritySort) {
      const rank = prioritySort === 'low'
        ? { low: 0, medium: 1, high: 2 }
        : { high: 0, medium: 1, low: 2 };
      copy.sort((a, b) => {
        const ar = rank[a.prio] ?? 3;
        const br = rank[b.prio] ?? 3;
        if (ar !== br) return ar - br;
        return (a.created || 0) - (b.created || 0);
      });
    } else if (ui.sortMode === 'due') {
      copy.sort((a, b) => {
        const ad = a.due ? new Date(a.due + 'T00:00:00').getTime() : Infinity;
        const bd = b.due ? new Date(b.due + 'T00:00:00').getTime() : Infinity;
        if (ad !== bd) return ad - bd;
        return (a.created || 0) - (b.created || 0);
      });
    }
    return copy;
  }

  function visibleTaskEntries() {
    const entries = [];
    state.lanes.forEach(lane => {
      sortTasks(filteredTasksForLane(lane), lane).forEach(task => entries.push({ task, lane }));
    });
    return entries;
  }

  function visibleTasksInLane(laneId) {
    const lane = state.lanes.find(item => item.id === laneId);
    return lane ? sortTasks(filteredTasksForLane(lane), lane) : [];
  }

  function visibleTaskIds() {
    return visibleTaskEntries().map(entry => entry.task.id);
  }

  function taskIsVisible(taskId) {
    return visibleTaskIds().includes(taskId);
  }

  function currentSelectedTask() {
    return state.tasks.find(task => task.id === ui.focusedTaskId) || null;
  }

  function nearestVisibleTaskId(preferredLaneId = ui.activeLaneId) {
    const entries = visibleTaskEntries();
    if (entries.length === 0) return null;
    if (preferredLaneId) {
      const laneMatch = entries.find(entry => entry.lane.id === preferredLaneId);
      if (laneMatch) return laneMatch.task.id;
    }
    return entries[0].task.id;
  }

  function selectedTaskElement() {
    return ui.focusedTaskId
      ? document.querySelector(`.task[data-id="${ui.focusedTaskId}"]`)
      : null;
  }

  function rememberSelectionGeometry(taskEl = selectedTaskElement()) {
    if (!taskEl) return;
    const rect = taskEl.getBoundingClientRect();
    ui.lastSelectionY = rect.top + rect.height / 2;
  }

  function syncSelectionDom({ focus = false } = {}) {
    const selectedId = ui.focusedTaskId;
    document.querySelectorAll('.task').forEach(taskEl => {
      const isSelected = selectedId && taskEl.dataset.id === selectedId;
      taskEl.classList.toggle('is-selected', Boolean(isSelected));
      taskEl.tabIndex = isSelected ? 0 : -1;
      if (isSelected) {
        taskEl.setAttribute('aria-selected', 'true');
      } else {
        taskEl.removeAttribute('aria-selected');
      }
    });

    document.querySelectorAll('.lane').forEach(laneEl => {
      const isActive = ui.activeLaneId && laneEl.dataset.lane === ui.activeLaneId;
      laneEl.classList.toggle('is-active-lane', Boolean(isActive));
      laneEl.classList.toggle('is-lane-focused', Boolean(isActive && !selectedId));
      laneEl.tabIndex = (isActive && !selectedId) ? 0 : -1;
    });

    const selectedEl = selectedTaskElement();
    if (focus && selectedEl) {
      selectedEl.focus({ preventScroll: true });
      selectedEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      rememberSelectionGeometry(selectedEl);
    }
  }

  function selectTask(taskId, { focus = true, fallbackLaneId = null } = {}) {
    const task = state.tasks.find(item => item.id === taskId);
    const visibleId = task && taskIsVisible(task.id)
      ? task.id
      : nearestVisibleTaskId(fallbackLaneId || task?.laneId || ui.activeLaneId);

    if (!visibleId) {
      ui.focusedTaskId = null;
      if (fallbackLaneId) ui.activeLaneId = fallbackLaneId;
      syncSelectionDom({ focus: false });
      return null;
    }

    const visibleTask = state.tasks.find(item => item.id === visibleId);
    ui.focusedTaskId = visibleId;
    ui.activeLaneId = visibleTask?.laneId || fallbackLaneId || ui.activeLaneId;
    syncSelectionDom({ focus });
    return visibleId;
  }

  function selectNearestVisible({ focus = true, laneId = null } = {}) {
    return selectTask(nearestVisibleTaskId(laneId), { focus, fallbackLaneId: laneId });
  }

  function restoreSelection({ focus = false, laneId = null } = {}) {
    if (ui.focusedTaskId && taskIsVisible(ui.focusedTaskId)) {
      return selectTask(ui.focusedTaskId, { focus, fallbackLaneId: laneId });
    }
    return selectNearestVisible({ focus, laneId: laneId || ui.activeLaneId });
  }

  function focusLane(laneId) {
    ui.activeLaneId = laneId || ui.activeLaneId || state.lanes[0]?.id || null;
    ui.focusedTaskId = null;
    syncSelectionDom({ focus: false });
    const laneEl = ui.activeLaneId ? document.querySelector(`.lane[data-lane="${ui.activeLaneId}"]`) : null;
    if (laneEl) laneEl.focus({ preventScroll: true });
  }

  function clearKeyboardFocus() {
    ui.focusedTaskId = null;
    ui.activeLaneId = null;
    syncSelectionDom({ focus: false });
    if (
      document.activeElement?.classList?.contains('task') ||
      document.activeElement?.classList?.contains('lane')
    ) {
      document.activeElement.blur();
    }
  }

  function taskCanCompact(task) {
    const text = (task.text || '').trim();
    return (
      text.length > 0 &&
      text.length <= 44 &&
      !text.includes('\n') &&
      !(task.tags && task.tags.length) &&
      !task.due &&
      ui.expandedTaskId !== task.id
    );
  }

  function taskHasMeta(task) {
    return !!task.due || !!(task.tags && task.tags.length);
  }

  function completedDestinationLane() {
    loadAutoMoveCompleted();
    if (!autoMoveCompleted.enabled || !autoMoveCompleted.laneId) return null;
    const lane = state.lanes.find(item => item.id === autoMoveCompleted.laneId);
    if (!lane) {
      sanitizeAutoMoveCompleted();
      return null;
    }
    return lane;
  }

  function dueDateState(due) {
    if (!due) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(due + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    if (d < today) return 'due-overdue';
    if (d.getTime() === today.getTime()) return 'due-today';
    return null;
  }

  function formatDue(due) {
    if (!due) return '';
    const d = new Date(due + 'T00:00:00');
    if (isNaN(d.getTime())) return due;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tmrw';
    if (days === -1) return 'Yest';
    if (days > 0 && days <= 7) return `${days}d`;
    if (days < 0 && days >= -7) return `-${-days}d`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function priorityLabel(prio) {
    if (prio === 'high') return 'High';
    if (prio === 'medium') return 'Medium';
    if (prio === 'low') return 'Low';
    return 'Priority';
  }

  function applyPriorityToEl(el, prio) {
    if (prio) el.dataset.prio = prio;
    else el.removeAttribute('data-prio');
    const label = priorityLabel(prio);
    el.title = `Priority: ${label}. Click to change.`;
    el.setAttribute('aria-label', el.title);
  }

  function cycleTaskPriority(task, taskEl) {
    const idx = PRIO_CYCLE.indexOf(task.prio);
    task.prio = PRIO_CYCLE[(idx + 1) % PRIO_CYCLE.length];
    const prioEl = taskEl.querySelector('.task-prio');
    if (prioEl) applyPriorityToEl(prioEl, task.prio);
    if (task.prio) taskEl.dataset.prio = task.prio;
    else taskEl.removeAttribute('data-prio');
    persist();
    if (ui.activePrioFilter || ui.sortMode === 'priority-high' || ui.sortMode === 'priority-low' || ui.sortMode === 'priority') {
      render();
    }
  }

  function isPriorityEdgeEvent(e, taskEl) {
    if (!taskEl || typeof e.clientX !== 'number') return false;
    if (e.target.closest('.task-done-btn')) return false;
    const rect = taskEl.getBoundingClientRect();
    const doneBtn = taskEl.querySelector('.task-done-btn');
    if (doneBtn) {
      const doneRect = doneBtn.getBoundingClientRect();
      return (
        e.clientX >= rect.left &&
        e.clientX < doneRect.left &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      );
    }
    const hitWidth = 14;
    return (
      e.clientX >= rect.left &&
      e.clientX <= rect.left + hitWidth &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    );
  }

  function autosizeTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // ============================================================
  // RENDER
  // ============================================================
  function render(animateNewIds = new Set()) {
    renderFilterStrip();
    els.lanes.innerHTML = '';
    state.lanes.forEach(lane => els.lanes.appendChild(buildLaneEl(lane, animateNewIds)));
    restoreSelection({ focus: document.activeElement?.classList?.contains('task') });
    syncWindowLayoutSoon();
  }

  function renderAndPersist(animateNewIds = new Set()) {
    render(animateNewIds);
    persist();
  }

  function renderFilterStrip() {
    persistFilters();
    const chips = [];
    if (ui.sortMode) {
      chips.push({
        label: ui.sortMode === 'priority-low'
          ? 'Priority: low first'
          : ui.sortMode === 'priority-high' || ui.sortMode === 'priority'
            ? 'Priority: high first'
            : 'Due date',
        onRemove: () => { ui.sortMode = null; render(); }
      });
    }
    if (ui.activePrioFilter) {
      chips.push({ label: `prio: ${ui.activePrioFilter}`, onRemove: () => { ui.activePrioFilter = null; render(); } });
    }
    ui.activeTagFilters.forEach(tag => {
      chips.push({
        label: `#${tag}`,
        tag,
        onRemove: () => { ui.activeTagFilters.delete(tag); render(); }
      });
    });

    if (chips.length === 0) {
      els.filterStrip.hidden = true;
      els.filterStrip.innerHTML = '';
      els.filterBtn.classList.remove('active');
      return;
    }
    els.filterBtn.classList.add('active');
    els.filterStrip.hidden = false;
    els.filterStrip.innerHTML = '';
    chips.forEach(c => {
      const chip = document.createElement('span');
      chip.className = 'filter-chip';
      if (c.tag) {
        chip.classList.add('tag-filter-chip');
        applyTagColor(chip, c.tag);
        chip.addEventListener('click', e => {
          e.stopPropagation();
          if (e.target.closest('.filter-chip-x')) return;
          openTagEditor(chip, c.tag);
        });
      }
      chip.innerHTML = `<span></span><span class="filter-chip-x">✕</span>`;
      chip.firstChild.textContent = c.label;
      chip.querySelector('.filter-chip-x').onclick = c.onRemove;
      els.filterStrip.appendChild(chip);
    });
    const clearAll = document.createElement('span');
    clearAll.className = 'filter-clear-all';
    clearAll.textContent = 'Clear all';
    clearAll.onclick = () => {
      ui.sortMode = null;
      ui.activePrioFilter = null;
      ui.activeTagFilters.clear();
      render();
    };
    els.filterStrip.appendChild(clearAll);
  }

  function buildLaneEl(lane, animateNewIds) {
    const filtersActive = !!ui.searchQuery || ui.activeTagFilters.size > 0 || !!ui.activePrioFilter;
    const laneEl = document.createElement('div');
    laneEl.className = 'lane';
    laneEl.dataset.lane = lane.id;
    laneEl.dataset.color = lane.color;
    laneEl.tabIndex = -1;
    laneEl.setAttribute('role', 'group');
    laneEl.setAttribute('aria-label', lane.name);

    // Header
    const header = document.createElement('div');
    header.className = 'lane-header';
    header.dataset.laneId = lane.id;
    header.title = 'Drag to reorder · double-click name to rename';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'lane-title-wrap';
    const title = document.createElement('span');
    title.className = 'lane-title';
    title.textContent = lane.name;
    titleWrap.appendChild(title);
    header.appendChild(titleWrap);

    const meta = document.createElement('div');
    meta.className = 'lane-meta';

    const visibleTasks = filteredTasksForLane(lane);
    const allLaneTasks = state.tasks.filter(t => t.laneId === lane.id);
    const count = document.createElement('span');
    count.className = 'lane-count';
    if (filtersActive && visibleTasks.length !== allLaneTasks.length) {
      count.textContent = `${visibleTasks.length}/${allLaneTasks.length}`;
      count.classList.add('filtered');
    } else {
      count.textContent = allLaneTasks.length;
    }
    if (allLaneTasks.length > 0) count.classList.add('has-count');
    meta.appendChild(count);

    const menuBtn = document.createElement('span');
    menuBtn.className = 'lane-menu-btn';
    menuBtn.textContent = '⋯';
    menuBtn.title = 'Lane options';
    menuBtn.addEventListener('mousedown', e => e.stopPropagation());
    menuBtn.onclick = e => { e.stopPropagation(); openLaneMenu(menuBtn, lane); };
    meta.appendChild(menuBtn);
    header.appendChild(meta);
    laneEl.appendChild(header);

    title.addEventListener('mousedown', e => { if (title.contentEditable === 'true') e.stopPropagation(); });
    title.addEventListener('dblclick', e => {
      e.stopPropagation();
      startEditLaneTitle(title, lane);
    });

    // Body
    const body = document.createElement('div');
    body.className = 'lane-body';
    body.dataset.laneId = lane.id;

    const sortedTasks = sortTasks(visibleTasks, lane);
    sortedTasks.forEach(task => body.appendChild(buildTaskEl(task, lane, animateNewIds)));

    if (!filtersActive) body.appendChild(makeAddCTA(() => addTaskInLane(lane.id)));

    laneEl.appendChild(body);
    return laneEl;
  }

  function makeAddCTA(onClick) {
    const cta = document.createElement('div');
    cta.className = 'add-task-cta';
    cta.title = 'Add task';
    const inner = document.createElement('div');
    inner.className = 'add-task-cta-inner';
    cta.appendChild(inner);
    cta.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    cta.addEventListener('dblclick', e => e.stopPropagation());
    cta.addEventListener('mousedown', e => e.stopPropagation());
    return cta;
  }

  function buildTaskEl(task, lane, animateNewIds) {
    const el = document.createElement('div');
    el.className = 'task';
    el.tabIndex = -1;
    el.setAttribute('role', 'option');
    if (animateNewIds && animateNewIds.has(task.id)) el.classList.add('entering');
    if (task.status === 'done') el.classList.add('is-done');
    if (taskCanCompact(task)) el.classList.add('is-compact');
    if (!taskHasMeta(task)) el.classList.add('has-no-meta');
    if (ui.expandedTaskId === task.id) el.classList.add('is-expanded');
    if (task.draft) el.classList.add('is-draft');
    if (ui.searchQuery && taskMatchesSearch(task, ui.searchQuery)) el.classList.add('search-hit');
    el.dataset.id = task.id;
    if (task.prio) el.dataset.prio = task.prio;

    const prio = document.createElement('button');
    prio.type = 'button';
    prio.className = 'task-prio';
    applyPriorityToEl(prio, task.prio);
    prio.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      cycleTaskPriority(task, el);
    });
    prio.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    if (task.status === 'done') prio.style.opacity = '0.4';
    el.appendChild(prio);

    // Header row
    const header = document.createElement('div');
    header.className = 'task-header';

    const metaStrip = document.createElement('div');
    metaStrip.className = 'task-meta';
    buildInlineMeta(metaStrip, task);
    header.appendChild(metaStrip);

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const btnX = document.createElement('div');
    btnX.className = 'task-btn task-x';
    btnX.textContent = '✕';
    btnX.title = 'Delete';
    btnX.addEventListener('mousedown', e => e.stopPropagation());
    actions.appendChild(btnX);
    header.appendChild(actions);
    el.appendChild(header);

    // Body text + done circle
    const doneBtn = document.createElement('div');
    doneBtn.className = 'task-done-btn';
    doneBtn.addEventListener('mousedown', e => e.stopPropagation());
    applyStatusToBtn(doneBtn, task.status, false);
    el.appendChild(doneBtn);

    const text = document.createElement('div');
    text.className = 'task-text';
    text.title = 'Click to expand · double-click to edit';
    text.appendChild(document.createTextNode(task.text));
    el.appendChild(text);

    // Detail panel if expanded
    if (ui.expandedTaskId === task.id) {
      const panel = buildDetailPanel(task);
      el.appendChild(panel);
      // Detail panel interactions don't need draggable toggling — pointer DnD checks target
    }

    return el;
  }

  function applyStatusToBtn(btn, status, animate) {
    btn.removeAttribute('data-status');
    btn.removeAttribute('data-animating');
    btn.style.animation = '';
    if (!status) { btn.title = 'Mark complete'; return; }
    btn.dataset.status = status;
    if (animate) {
      // Force reflow so the animation re-runs
      void btn.offsetHeight;
      btn.dataset.animating = '1';
      const dur = status === 'done' ? 400 : 340;
      setTimeout(() => btn.removeAttribute('data-animating'), dur + 50);
    }
    if (status === 'done') btn.title = 'Mark incomplete';
    if (status === 'incomplete') btn.title = 'Click to cancel task';
    if (status === 'cancel') btn.title = 'Click to reset status';
  }

  function buildInlineMeta(container, task) {
    const tags = task.tags || [];
    const visible = tags.slice(0, MAX_INLINE_TAGS);
    const overflow = tags.length - visible.length;
    visible.forEach(tag => {
      const c = document.createElement('span');
      c.className = 'task-tag';
      c.textContent = '#' + tag;
      c.title = `Edit #${tag}`;
      applyTagColor(c, tag);
      c.addEventListener('mousedown', e => e.stopPropagation());
      c.onclick = e => {
        e.stopPropagation();
        openTagEditor(c, tag);
      };
      container.appendChild(c);
    });
    if (overflow > 0) {
      const more = document.createElement('span');
      more.className = 'task-tag-more';
      more.textContent = `+${overflow}`;
      more.title = tags.slice(MAX_INLINE_TAGS).map(t => '#' + t).join(' ');
      more.addEventListener('mousedown', e => e.stopPropagation());
      more.onclick = e => { e.stopPropagation(); toggleExpandTask(task.id); };
      container.appendChild(more);
    }
    if (task.due) {
      const due = document.createElement('span');
      due.className = 'task-due';
      const dueState = dueDateState(task.due);
      if (dueState) due.classList.add(dueState);
      due.textContent = formatDue(task.due);
      due.title = `Due ${task.due}`;
      due.addEventListener('mousedown', e => e.stopPropagation());
      due.onclick = e => { e.stopPropagation(); toggleExpandTask(task.id); };
      container.appendChild(due);
    }
  }

  function buildDetailPanel(task) {
    const panel = document.createElement('div');
    panel.className = 'task-detail';

    const detailHdr = document.createElement('div');
    detailHdr.className = 'detail-header';
    const lbl = document.createElement('span');
    lbl.className = 'detail-header-label';
    lbl.textContent = 'Details';
    const closeBtn = document.createElement('div');
    closeBtn.className = 'detail-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('mousedown', e => e.stopPropagation());
    closeBtn.onclick = e => {
      e.stopPropagation();
      collapseTaskInPlace(task.id, panel);
    };
    detailHdr.appendChild(lbl);
    detailHdr.appendChild(closeBtn);
    panel.appendChild(detailHdr);

    const fields = document.createElement('div');
    fields.className = 'detail-fields';

    // Due
    const dueRow = document.createElement('div');
    dueRow.className = 'detail-row';
    const dueLabel = document.createElement('span');
    dueLabel.className = 'detail-label';
    dueLabel.textContent = 'Due';
    const dueInput = document.createElement('input');
    dueInput.type = 'date';
    dueInput.className = 'detail-input';
    dueInput.value = task.due || '';
    dueInput.onchange = () => { task.due = dueInput.value || null; renderAndPersist(); };
    dueInput.addEventListener('mousedown', e => e.stopPropagation());
    dueRow.appendChild(dueLabel);
    dueRow.appendChild(dueInput);
    fields.appendChild(dueRow);

    // Notes (debounced persist)
    const descRow = document.createElement('div');
    descRow.className = 'detail-row';
    descRow.style.alignItems = 'flex-start';
    const descLabel = document.createElement('span');
    descLabel.className = 'detail-label';
    descLabel.textContent = 'Notes';
    const descTa = document.createElement('textarea');
    descTa.className = 'detail-textarea';
    descTa.placeholder = 'Add notes…';
    descTa.value = task.desc || '';
    autosizeTextarea(descTa);
    const debouncedPersist = debounce(persist, 400);
    descTa.addEventListener('input', () => {
      task.desc = descTa.value;
      autosizeTextarea(descTa);
      debouncedPersist();
      syncWindowLayoutSoon();
    });
    descTa.addEventListener('blur', () => persist());
    descTa.addEventListener('mousedown', e => e.stopPropagation());
    descRow.appendChild(descLabel);
    descRow.appendChild(descTa);
    fields.appendChild(descRow);

    // Tags
    const tagsRow = document.createElement('div');
    tagsRow.className = 'detail-row';
    const tagsLabel = document.createElement('span');
    tagsLabel.className = 'detail-label';
    tagsLabel.textContent = 'Tags';
    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.className = 'detail-input';
    tagsInput.placeholder = 'e.g. urgent backend';
    tagsInput.value = (task.tags || []).join(' ');
    tagsInput.addEventListener('mousedown', e => e.stopPropagation());
    const commitTags = () => {
      const tagList = tagsInput.value
        .split(/\s+/)
        .map(t => t.replace(/^#/, '').toLowerCase())
        .filter(t => /^[a-z0-9_-]+$/.test(t));
      task.tags = [...new Set(tagList)];
      renderAndPersist();
    };
    tagsInput.addEventListener('blur', commitTags);
    tagsInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); tagsInput.blur(); }
    });
    tagsRow.appendChild(tagsLabel);
    tagsRow.appendChild(tagsInput);
    fields.appendChild(tagsRow);

    panel.appendChild(fields);
    return panel;
  }

  // ============================================================
  // EXPAND / COLLAPSE — in-place DOM patches
  // ============================================================
  function toggleExpandTask(taskId) {
    if (ui.expandedTaskId === taskId) {
      const taskEl = document.querySelector(`.task[data-id="${taskId}"]`);
      const panel = taskEl ? taskEl.querySelector('.task-detail') : null;
      collapseTaskInPlace(taskId, panel);
    } else {
      // Collapse any other expanded task first
      if (ui.expandedTaskId) {
        const otherEl = document.querySelector(`.task[data-id="${ui.expandedTaskId}"]`);
        const otherPanel = otherEl ? otherEl.querySelector('.task-detail') : null;
        collapseTaskInPlace(ui.expandedTaskId, otherPanel);
      }
      const taskEl = document.querySelector(`.task[data-id="${taskId}"]`);
      if (taskEl) expandTaskInPlace(taskId, taskEl);
    }
  }

  function expandTaskInPlace(taskId, taskEl) {
    ui.expandedTaskId = taskId;
    taskEl.classList.add('is-expanded');
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    const panel = buildDetailPanel(task);
    // Detail panel interactions don't need draggable toggling — pointer DnD checks target
    taskEl.appendChild(panel);
    syncWindowLayoutSoon();
  }

  function collapseTaskInPlace(taskId, panelEl) {
    if (ui.expandedTaskId === taskId) ui.expandedTaskId = null;
    const taskEl = document.querySelector(`.task[data-id="${taskId}"]`);
    if (taskEl) taskEl.classList.remove('is-expanded');
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    syncWindowLayoutSoon();
  }

  // ============================================================
  // CONFETTI 🎉 (when a task lands in the last lane via drag/move)
  // ============================================================
  function burstConfetti(originEl) {
    if (!originEl) return;
    const boardRect = els.board.getBoundingClientRect();
    const rect = originEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2 - boardRect.left;
    const cy = rect.top + rect.height / 2 - boardRect.top;
    const colors = ['#6ee7b7', '#6ea8fe', '#b87cff', '#ffb86c', '#ff9ec5'];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti';
      piece.style.left = cx + 'px';
      piece.style.top = cy + 'px';
      piece.style.background = colors[i % colors.length];
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const distance = 40 + Math.random() * 50;
      piece.style.setProperty('--dx', Math.cos(angle) * distance + 'px');
      piece.style.setProperty('--dy', (Math.sin(angle) * distance + 30) + 'px');
      piece.style.setProperty('--rot', (180 + Math.random() * 540) + 'deg');
      els.board.appendChild(piece);
      setTimeout(() => piece.remove(), 1300);
    }
  }

  // ============================================================
  // TOAST / UNDO
  // ============================================================
  let activeToast = null;

  function showToast(message, actionLabel, onAction) {
    if (activeToast) dismissToast(activeToast, true);
    const toast = document.createElement('div');
    toast.className = 'toast';
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;
    toast.appendChild(msg);

    if (actionLabel && onAction) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = actionLabel;
      toast._action = onAction;
      btn.onclick = () => runToastAction(toast);
      toast.appendChild(btn);
    }
    const close = document.createElement('span');
    close.className = 'toast-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.setAttribute('role', 'button');
    close.onclick = () => dismissToast(toast);
    toast.appendChild(close);

    els.toastRoot.appendChild(toast);
    activeToast = toast;
    toast._timeout = setTimeout(() => dismissToast(toast), UNDO_TIMEOUT_MS);
  }

  function runToastAction(toast) {
    if (!toast || !toast.parentNode || typeof toast._action !== 'function') return false;
    const action = toast._action;
    toast._action = null;
    action();
    dismissToast(toast);
    return true;
  }

  function undoLastAction() {
    return runToastAction(activeToast);
  }

  function dismissToast(toast, immediate) {
    if (!toast || !toast.parentNode) return;
    if (toast._timeout) clearTimeout(toast._timeout);
    toast._action = null;
    if (immediate) {
      toast.remove();
    } else {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 200);
    }
    if (activeToast === toast) activeToast = null;
  }

  // ============================================================
  // TASK MUTATIONS
  // ============================================================
  function toggleTaskCompletion(taskId, originEl = null) {
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) return false;

    const nextStatus = task.status === 'done' ? null : 'done';
    task.status = nextStatus;
    const destinationLane = nextStatus === 'done' ? completedDestinationLane() : null;
    const shouldMove = Boolean(destinationLane && task.laneId !== destinationLane.id);
    if (shouldMove) task.laneId = destinationLane.id;

    ui.focusedTaskId = task.id;
    ui.activeLaneId = task.laneId;

    if (originEl) {
      const doneBtn = originEl.querySelector('.task-done-btn');
      if (doneBtn) applyStatusToBtn(doneBtn, nextStatus, true);
      originEl.classList.toggle('is-done', nextStatus === 'done');
      const prioEl = originEl.querySelector('.task-prio');
      if (prioEl) prioEl.style.opacity = (nextStatus === 'done' || nextStatus === 'cancel') ? '0.35' : '';
      if (nextStatus === 'done') burstConfetti(originEl);
    }

    persist();
    if (shouldMove) setTimeout(() => renderAndPersist(new Set([task.id])), 90);
    else renderAndPersist(new Set([task.id]));
    return true;
  }

  function moveSelectedTaskByLane(delta) {
    const task = currentSelectedTask();
    if (!task) return false;
    const currentIdx = laneIndexOf(task.laneId);
    const nextLane = state.lanes[currentIdx + delta];
    if (!nextLane) {
      selectTask(task.id, { focus: true });
      return false;
    }

    task.laneId = nextLane.id;
    ui.focusedTaskId = task.id;
    ui.activeLaneId = nextLane.id;
    renderAndPersist(new Set([task.id]));
    requestAnimationFrame(() => selectTask(task.id, { focus: true }));
    return true;
  }

  function adjustSelectedTaskPriority(delta) {
    const selectedId = restoreSelection({ focus: false });
    const task = selectedId ? state.tasks.find(item => item.id === selectedId) : null;
    if (!task) return false;

    const currentIndex = PRIO_CYCLE.indexOf(task.prio);
    const safeIndex = currentIndex < 0 ? 0 : currentIndex;
    const nextIndex = Math.min(PRIO_CYCLE.length - 1, Math.max(0, safeIndex + delta));
    const nextPrio = PRIO_CYCLE[nextIndex];
    if (task.prio === nextPrio) {
      selectTask(task.id, { focus: true });
      return false;
    }

    task.prio = nextPrio;
    ui.focusedTaskId = task.id;
    ui.activeLaneId = task.laneId;
    renderAndPersist(new Set([task.id]));
    requestAnimationFrame(() => selectTask(task.id, { focus: true }));
    return true;
  }

  function addTaskInLane(laneId) {
    const lane = state.lanes.find(l => l.id === laneId);
    if (!lane) return;
    const newTask = {
      id: tid(), laneId, text: 'New task', prio: null, tags: [],
      created: Date.now(), due: null, desc: '', status: null, draft: true
    };
    state.tasks.push(newTask);
    ui.activeLaneId = laneId;
    ui.focusedTaskId = newTask.id;
    renderAndPersist(new Set([newTask.id]));
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-id="${newTask.id}"] .task-text`);
      if (el) startEditTask(el, newTask, { selectAll: true });
    });
  }

  function startEditTask(textEl, task, options = {}) {
    const taskEl = textEl.closest('.task');
    const doneBtn = taskEl?.querySelector('.task-done-btn');
    let finished = false;
    if (taskEl) taskEl.classList.add('is-editing');
    if (doneBtn) doneBtn.style.display = 'none';

    textEl.contentEditable = 'true';
    textEl.style.cursor = 'text';
    textEl.focus();

    const range = document.createRange();
    range.selectNodeContents(textEl);
    if (!options.selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = ({ cancelDraft = false } = {}) => {
      if (finished) return;
      finished = true;
      textEl.removeEventListener('blur', onBlur);
      textEl.removeEventListener('keydown', onKey);
      textEl.removeEventListener('input', onInput);
      textEl.contentEditable = 'false';
      textEl.style.cursor = '';
      if (taskEl) taskEl.classList.remove('is-editing');
      if (doneBtn) doneBtn.style.display = '';
      const newText = textEl.innerText.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

      if (cancelDraft && task.draft) {
        state.tasks = state.tasks.filter(t => t.id !== task.id);
        if (ui.focusedTaskId === task.id) ui.focusedTaskId = null;
        ui.activeLaneId = task.laneId;
        renderAndPersist();
        requestAnimationFrame(() => focusLane(task.laneId));
        return;
      }

      if (newText === '') {
        state.tasks = state.tasks.filter(t => t.id !== task.id);
        if (ui.focusedTaskId === task.id) ui.focusedTaskId = null;
        ui.activeLaneId = task.laneId;
      } else {
        task.text = newText;
        const wasDraft = Boolean(task.draft);
        delete task.draft;
        const parsed = parseTags(newText);
        if (parsed.length > 0) task.tags = [...new Set([...(task.tags || []), ...parsed])];
        ui.focusedTaskId = task.id;
        ui.activeLaneId = task.laneId;
        if (wasDraft && parsed.length === 0 && taskEl && taskCanCompact(task)) {
          textEl.textContent = task.text;
          taskEl.classList.remove('is-draft');
          taskEl.classList.toggle('is-compact', taskCanCompact(task));
          taskEl.classList.toggle('has-no-meta', !taskHasMeta(task));
          persist();
          syncSelectionDom({ focus: true });
          return;
        }
      }
      renderAndPersist();
    };
    const onBlur = () => finish();
    const onInput = () => syncWindowLayoutSoon();
    const onKey = e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
      else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        insertTaskLineBreak();
        syncWindowLayoutSoon();
      }
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish({ cancelDraft: true });
      }
    };
    textEl.addEventListener('blur', onBlur);
    textEl.addEventListener('keydown', onKey);
    textEl.addEventListener('input', onInput);
  }

  function startEditLaneTitle(titleEl, lane, onDone) {
    titleEl.contentEditable = 'true';
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      titleEl.contentEditable = 'false';
      const v = titleEl.textContent.trim();
      if (v) lane.name = v;
      renderAndPersist();
      titleEl.removeEventListener('blur', finish);
      titleEl.removeEventListener('keydown', onKey);
      if (typeof onDone === 'function') onDone();
    };
    const onKey = e => {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); titleEl.textContent = lane.name; titleEl.blur(); }
    };
    titleEl.addEventListener('blur', finish);
    titleEl.addEventListener('keydown', onKey);
  }

  function deleteTask(taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    const taskCopy = { ...task };
    const indexInTasks = state.tasks.indexOf(task);
    state.tasks = state.tasks.filter(t => t.id !== taskId);
    if (ui.expandedTaskId === taskId) ui.expandedTaskId = null;
    if (ui.focusedTaskId === taskId) ui.focusedTaskId = null;
    ui.activeLaneId = taskCopy.laneId;
    renderAndPersist();
    showToast(`Deleted "${truncate(taskCopy.text, 30)}"`, 'Undo', () => {
      // Reinsert at original position
      const lane = state.lanes.find(l => l.id === taskCopy.laneId);
      if (!lane) taskCopy.laneId = state.lanes[0].id;
      state.tasks.splice(Math.min(indexInTasks, state.tasks.length), 0, taskCopy);
      ui.focusedTaskId = taskCopy.id;
      ui.activeLaneId = taskCopy.laneId;
      renderAndPersist(new Set([taskCopy.id]));
    });
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ============================================================
  // LANE MUTATIONS
  // ============================================================
  function addLane() {
    const newLane = { id: lid(), name: 'New Lane', color: 'none' };
    state.lanes.push(newLane);
    ui.activeLaneId = newLane.id;
    ui.focusedTaskId = null;
    renderAndPersist();
    requestAnimationFrame(() => {
      const titleEl = document.querySelector(`.lane[data-lane="${newLane.id}"] .lane-title`);
      const headerEl = document.querySelector(`.lane[data-lane="${newLane.id}"] .lane-header`);
      if (titleEl) {
        startEditLaneTitle(titleEl, newLane);
      }
    });
  }

  function deleteLane(laneId) {
    if (state.lanes.length <= 1) return;
    const lane = state.lanes.find(l => l.id === laneId);
    if (!lane) return;
    const removedTasks = state.tasks.filter(t => t.laneId === laneId);
    const laneIndex = laneIndexOf(laneId);
    const laneCopy = { ...lane };
    state.tasks = state.tasks.filter(t => t.laneId !== laneId);
    state.lanes = state.lanes.filter(l => l.id !== laneId);
    if (ui.activeLaneId === laneId) ui.activeLaneId = state.lanes[Math.min(laneIndex, state.lanes.length - 1)]?.id || null;
    if (removedTasks.some(task => task.id === ui.focusedTaskId)) ui.focusedTaskId = null;
    if (autoMoveCompleted.laneId === laneId) {
      autoMoveCompleted = { enabled: false, laneId: null };
      persistAutoMoveCompleted();
    }
    renderAndPersist();
    showToast(`Deleted lane "${laneCopy.name}" and ${removedTasks.length} task${removedTasks.length === 1 ? '' : 's'}`, 'Undo', () => {
      state.lanes.splice(Math.min(laneIndex, state.lanes.length), 0, laneCopy);
      removedTasks.forEach(t => state.tasks.push(t));
      ui.activeLaneId = laneCopy.id;
      ui.focusedTaskId = removedTasks[0]?.id || null;
      renderAndPersist();
    });
  }

  function moveLane(laneId, dir) {
    const idx = laneIndexOf(laneId);
    const next = idx + dir;
    if (next < 0 || next >= state.lanes.length) return;
    const [l] = state.lanes.splice(idx, 1);
    state.lanes.splice(next, 0, l);
    ui.activeLaneId = laneId;
    renderAndPersist();
  }

  function reorderLane(srcId, beforeId) {
    if (srcId === beforeId) return;
    const srcIdx = laneIndexOf(srcId);
    if (srcIdx < 0) return;
    const [src] = state.lanes.splice(srcIdx, 1);
    if (beforeId === null) {
      state.lanes.push(src);
    } else {
      const beforeIdx = laneIndexOf(beforeId);
      if (beforeIdx < 0) state.lanes.push(src);
      else state.lanes.splice(beforeIdx, 0, src);
    }
    ui.activeLaneId = srcId;
    renderAndPersist();
  }

  function clearDoneTasks(laneId) {
    const lane = state.lanes.find(l => l.id === laneId);
    if (!lane) return;
    const removed = state.tasks.filter(t => t.laneId === laneId);
    if (removed.length === 0) return;
    state.tasks = state.tasks.filter(t => t.laneId !== laneId);
    if (removed.some(task => task.id === ui.focusedTaskId)) ui.focusedTaskId = null;
    ui.activeLaneId = laneId;
    renderAndPersist();
    showToast(`Cleared ${removed.length} task${removed.length === 1 ? '' : 's'} from "${lane.name}"`, 'Undo', () => {
      removed.forEach(t => state.tasks.push(t));
      ui.focusedTaskId = removed[0]?.id || null;
      ui.activeLaneId = laneId;
      renderAndPersist();
    });
  }

  // ============================================================
  // POPOVERS
  // ============================================================
  function closePopover() {
    if (ui.openPopover) {
      ui.openPopover.remove();
      ui.openPopover = null;
    }
    ui.openPopoverAnchor = null;
    document.removeEventListener('mousedown', onDocClickClose, true);
    syncWindowLayoutSoon();
  }

  function onDocClickClose(e) {
    if (e.target.closest('#settings-btn, #filter-btn, #info-btn')) return;
    if (ui.openPopover && !ui.openPopover.contains(e.target)) closePopover();
  }

  function showPopover(anchorEl, contentBuilder) {
    closePopover();
    const pop = document.createElement('div');
    pop.className = 'popover';
    contentBuilder(pop);
    els.overlayRoot.appendChild(pop);
    ui.openPopover = pop;
    ui.openPopoverAnchor = anchorEl;
    positionPopover();
    syncWindowLayoutSoon();
    setTimeout(() => document.addEventListener('mousedown', onDocClickClose, true), 0);
  }

  function positionPopover() {
    if (!ui.openPopover || !ui.openPopoverAnchor) return;
    const pop = ui.openPopover;
    const anchorRect = ui.openPopoverAnchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const preferBelow = Boolean(ui.openPopoverAnchor.closest('.topbar-actions'));
    let top = anchorRect.bottom + (preferBelow ? 8 : 4);
    let left = anchorRect.left;
    const margin = 8;
    if (left + popRect.width > window.innerWidth - margin) left = window.innerWidth - popRect.width - margin;
    if (left < margin) left = margin;
    if (!preferBelow && top + popRect.height > window.innerHeight - margin) {
      const flipped = anchorRect.top - popRect.height - 4;
      if (flipped >= margin) top = flipped;
      else top = Math.max(margin, window.innerHeight - popRect.height - margin);
    }
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  function addItem(pop, label, onClick) {
    const item = document.createElement('div');
    item.className = 'popover-item';
    item.textContent = label;
    item.onclick = onClick;
    pop.appendChild(item);
    return item;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    const node = el('button', className, text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function option(value, text) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = text;
    return node;
  }

  function addTitle(pop, text) {
    const title = el('div', 'popover-title', text);
    pop.appendChild(title);
    return title;
  }

  function divider() {
    return el('div', 'popover-divider');
  }

  function addDivider(pop) {
    pop.appendChild(divider());
  }

  function setItemActive(item, active) {
    appendCheck(item, active);
    return item;
  }

  function addColorRow(pop, colors, activeColor, onSelect) {
    const colorRow = el('div', 'popover-color-row');
    colors.forEach(color => {
      const dot = el('div', 'color-dot' + (activeColor === color ? ' is-active' : ''));
      dot.dataset.color = color;
      dot.title = color === 'none' ? 'No color' : color;
      dot.onclick = () => onSelect(color);
      colorRow.appendChild(dot);
    });
    pop.appendChild(colorRow);
    return colorRow;
  }

  function addShortcutRows(pop, rows) {
    const shortcuts = el('div', 'popover-shortcuts');
    rows.forEach(([label, key]) => {
      const row = el('div', 'sc-row');
      row.appendChild(el('span', '', label));
      row.appendChild(el('kbd', '', key));
      shortcuts.appendChild(row);
    });
    pop.appendChild(shortcuts);
    return shortcuts;
  }

  function addInlineButtonRow(pop, className, actions) {
    const row = el('div', `popover-inline-row ${className}`);
    actions.forEach(action => {
      row.appendChild(button(action.className || 'popover-inline-action', action.label, action.onClick));
    });
    pop.appendChild(row);
    return row;
  }

  function showInlineConfirm(afterEl, message, confirmLabel, onConfirm) {
    const confirm = el('div', 'popover-confirm');
    const actions = el('div', 'popover-confirm-actions');
    const cancel = button('popover-confirm-button', 'Cancel', () => {
      confirm.remove();
      afterEl.hidden = false;
      positionPopover();
    });
    const confirmButton = button('popover-confirm-button danger', confirmLabel, onConfirm);
    actions.appendChild(cancel);
    actions.appendChild(confirmButton);
    confirm.appendChild(el('div', 'popover-confirm-message', message));
    confirm.appendChild(actions);
    afterEl.after(confirm);
    positionPopover();
    return confirm;
  }

  function openTagEditor(anchorEl, tag) {
    showPopover(anchorEl, pop => {
      pop.classList.add('tag-editor-popover');
      addTitle(pop, 'Tag');

      const input = document.createElement('input');
      input.className = 'tag-editor-input';
      input.value = tag;
      input.placeholder = 'tag-name';
      input.addEventListener('mousedown', e => e.stopPropagation());
      pop.appendChild(input);

      addColorRow(pop, TAG_COLORS, tagColor(tag), color => {
          state.tagColors[tag] = color;
          if (color === 'none') delete state.tagColors[tag];
          renderAndPersist();
          closePopover();
      });

      const save = () => {
        const nextTag = normalizeTagName(input.value);
        if (!/^[a-z0-9_-]+$/.test(nextTag)) {
          showToast('Use letters, numbers, hyphen, or underscore.');
          return;
        }
        renameTagEverywhere(tag, nextTag);
        renderAndPersist();
        closePopover();
      };

      addDivider(pop);
      addItem(pop, 'Save tag', save);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); closePopover(); }
      });
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  function openLaneMenu(anchorEl, lane) {
    showPopover(anchorEl, pop => {
      addTitle(pop, 'Lane');

      addItem(pop, '✎  Rename', () => {
        closePopover();
        const titleEl = document.querySelector(`.lane[data-lane="${lane.id}"] .lane-title`);
        if (titleEl) {
          startEditLaneTitle(titleEl, lane);
        }
      });

      addColorRow(pop, LANE_COLORS, lane.color, color => {
        lane.color = color;
        renderAndPersist();
        closePopover();
      });
      addDivider(pop);

      const taskCount = state.tasks.filter(t => t.laneId === lane.id).length;
      if (taskCount > 0) {
        addItem(pop, `🗑  Clear ${taskCount} task${taskCount === 1 ? '' : 's'}`, () => {
          clearDoneTasks(lane.id);
          closePopover();
        });
      }

      if (state.lanes.length > 1) {
        addDivider(pop);
        addItem(pop, '🗑  Delete lane', () => {
          deleteLane(lane.id);
          closePopover();
        }).classList.add('danger');
      }
    });
  }

  function appendCheck(item, checked) {
    item.querySelector('.check')?.remove();
    item.classList.toggle('is-active', Boolean(checked));
    if (!checked) return;
    const c = document.createElement('span');
    c.className = 'check';
    c.textContent = '✓';
    item.appendChild(c);
  }

  function fallbackCompletedLaneId() {
    return state.lanes[state.lanes.length - 1]?.id || null;
  }

  function setAutoMoveCompleted(enabled, laneId = autoMoveCompleted.laneId) {
    autoMoveCompleted = {
      enabled: Boolean(enabled),
      laneId: enabled ? (laneId || fallbackCompletedLaneId()) : null
    };
    sanitizeAutoMoveCompleted();
  }

  function showOnboarding() {
    closePopover();
    const existing = document.querySelector('.onboarding-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'onboarding-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'onboarding-title');
    modal.innerHTML = `
      <div class="onboarding-card">
        <div class="onboarding-mark">◆</div>
        <h2 id="onboarding-title">Welcome to KanTrack</h2>
        <p class="onboarding-copy">A fast menu-bar board for capturing tasks, moving work, and staying keyboard-first.</p>
        <div class="onboarding-grid">
          <div><kbd>⌥K</kbd><span>Show or hide KanTrack from anywhere.</span></div>
          <div><kbd>A</kbd><span>Add a task in the current lane. You can also click a lane’s + button.</span></div>
          <div><kbd>↑ ↓</kbd><span>Move through visible tasks. Use <kbd>← →</kbd> to move between lanes.</span></div>
          <div><kbd>⌘← ⌘→</kbd><span>Move the selected task to the previous or next lane.</span></div>
          <div><kbd>⌘↑ ⌘↓</kbd><span>Raise or lower task priority. You can also click a task’s left edge.</span></div>
          <div><kbd>/</kbd><span>Search tasks, notes, and tags instantly. Press Esc to clear, then blur.</span></div>
        </div>
        <p class="onboarding-copy">Drag tasks between lanes, drag lane headers to reorder, use Space to complete, and configure completed-task auto-move from the gear menu.</p>
        <div class="onboarding-actions">
          <button type="button" class="onboarding-button secondary">Later</button>
          <button type="button" class="onboarding-button primary">Get Started</button>
        </div>
      </div>
    `;

    const close = () => {
      localStorage.setItem(ONBOARDING_SEEN_KEY, 'true');
      modal.remove();
      restoreSelection({ focus: true });
      syncWindowLayoutSoon();
    };

    modal.querySelector('.secondary').addEventListener('click', close);
    modal.querySelector('.primary').addEventListener('click', close);
    modal.addEventListener('mousedown', event => {
      if (event.target === modal) close();
    });
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });

    els.board.appendChild(modal);
    requestAnimationFrame(() => {
      modal.querySelector('.primary')?.focus();
      syncWindowLayoutSoon();
    });
    syncWindowLayoutSoon();
  }

  function openInfo() {
    showPopover(els.infoBtn, pop => {
      pop.classList.add('info-popover');
      addItem(pop, 'Start walkthrough', () => {
        closePopover();
        showOnboarding();
      });
      addDivider(pop);
      addTitle(pop, 'Shortcuts');
      addShortcutRows(pop, [
        ['Show / hide', '⌥K'],
        ['Search', '/'],
        ['New task', 'A or +'],
        ['Open task', 'Enter'],
        ['Complete task', 'Space'],
        ['Navigate', '↑ ↓ ← →'],
        ['Move task', '⌘← ⌘→'],
        ['Priority', '⌘↑ ⌘↓'],
        ['Delete task', 'Delete or ⌘⌫'],
        ['Undo delete', '⌘Z']
      ]);
    });
  }

  async function isLaunchAtLoginEnabled() {
    try {
      return !!(await window.__TAURI__?.core?.invoke('plugin:autostart|is_enabled'));
    } catch (error) {
      return false;
    }
  }

  async function setLaunchAtLogin(enabled) {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) throw new Error('Tauri unavailable');
    await tauri.core.invoke(enabled ? 'plugin:autostart|enable' : 'plugin:autostart|disable');
    syncLaunchAtLoginMenu(enabled);
  }

  async function appVersion() {
    try {
      return await window.__TAURI__?.core?.invoke('plugin:app|version');
    } catch (error) {
      return 'development';
    }
  }

  function openSettings() {
    showPopover(els.settingsBtn, pop => {
      pop.classList.add('settings-popover');
      const exportBoard = () => {
        const json = JSON.stringify(state, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kantrack-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        closePopover();
      };
      const importBoard = () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'application/json';
        inp.onchange = () => {
          const f = inp.files[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = () => {
            try {
              const parsed = JSON.parse(r.result);
              const validated = Storage.validate(parsed);
              if (validated) {
                state = validated;
                ui.expandedTaskId = null;
                sanitizeAutoMoveCompleted();
                renderAndPersist();
              }
              else showToast('Invalid import file.');
            } catch (e) { showToast('Could not parse import file.'); }
          };
          r.readAsText(f);
        };
        inp.click();
        closePopover();
      };

      addTitle(pop, 'General');

      const autosizeItem = addItem(pop, 'Autosize window', () => {
        setAutosize(!ui.autosize);
        appendCheck(autosizeItem, ui.autosize);
      });
      appendCheck(autosizeItem, ui.autosize);

      const launchItem = addItem(pop, 'Launch at Login', async () => {
        try {
          const enabled = await isLaunchAtLoginEnabled();
          await setLaunchAtLogin(!enabled);
          appendCheck(launchItem, !enabled);
        } catch (error) {
          showToast('Could not update launch setting.');
        }
      });
      isLaunchAtLoginEnabled().then(enabled => appendCheck(launchItem, enabled));

      addDivider(pop);
      addTitle(pop, 'Tasks');

      loadAutoMoveCompleted();
      const completedRow = el('div', 'popover-inline-row completed-move-row');
      const moveCompletedItem = button('popover-inline-toggle');
      moveCompletedItem.appendChild(el('span', '', 'Move Complete'));
      const destinationSelect = document.createElement('select');
      destinationSelect.className = 'popover-select';

      const syncMoveCompletedRow = () => {
        appendCheck(moveCompletedItem, autoMoveCompleted.enabled);
        destinationSelect.disabled = !autoMoveCompleted.enabled || state.lanes.length === 0;
        if (autoMoveCompleted.laneId) destinationSelect.value = autoMoveCompleted.laneId;
      };

      moveCompletedItem.addEventListener('click', () => {
        const nextEnabled = !autoMoveCompleted.enabled;
        setAutoMoveCompleted(nextEnabled);
        syncMoveCompletedRow();
      });

      state.lanes.forEach(lane => destinationSelect.appendChild(option(lane.id, lane.name)));
      destinationSelect.value = autoMoveCompleted.laneId || fallbackCompletedLaneId() || '';
      destinationSelect.disabled = !autoMoveCompleted.enabled || state.lanes.length === 0;
      destinationSelect.addEventListener('mousedown', e => e.stopPropagation());
      destinationSelect.addEventListener('click', e => e.stopPropagation());
      destinationSelect.addEventListener('change', () => {
        setAutoMoveCompleted(true, destinationSelect.value);
        syncMoveCompletedRow();
        positionPopover();
      });
      syncMoveCompletedRow();
      completedRow.appendChild(moveCompletedItem);
      completedRow.appendChild(destinationSelect);
      pop.appendChild(completedRow);

      addDivider(pop);
      addTitle(pop, 'Data');
      addInlineButtonRow(pop, 'data-actions-row', [
        { label: 'Export JSON', onClick: exportBoard },
        { label: 'Import JSON', onClick: importBoard }
      ]);

      addDivider(pop);
      const resetItem = addItem(pop, 'Reset board', () => {
        resetItem.hidden = true;
        showInlineConfirm(resetItem, 'Reset board to the default setup?', 'Reset', () => {
          resetBoardToDefault();
          closePopover();
          showToast('Board reset to default.');
        });
      });
      resetItem.classList.add('danger');

      addDivider(pop);
      addTitle(pop, 'Updates');
      const deferredVersion = localStorage.getItem(DEFERRED_UPDATE_KEY);
      const knownAvailable = pendingUpdate?.version || deferredVersion || lastUpdateCheck?.availableVersion;
      const updateItem = addItem(pop, knownAvailable ? `Update available: ${knownAvailable}` : 'Check for updates', async () => {
        updateItem.textContent = 'Checking for updates...';
        try {
          const metadata = await checkForAvailableUpdate();
          if (metadata) {
            closePopover();
            window.kantrackShowUpdatePrompt?.();
          } else {
            updateItem.textContent = 'Up to date';
            showToast('KanTrack is up to date.');
          }
        } catch (error) {
          updateItem.textContent = knownAvailable ? `Update available: ${knownAvailable}` : 'Check for updates';
          showToast('Update check failed.');
        }
      });

      const quitItem = addItem(pop, 'Quit KanTrack', () => {
        const tauri = window.__TAURI__;
        if (tauri?.core?.invoke) tauri.core.invoke('quit_app').catch(() => {});
      });
      quitItem.classList.add('danger');

      const versionItem = el('div', 'popover-static', 'Version ...');
      pop.appendChild(versionItem);
      appVersion().then(version => { versionItem.textContent = `Version ${version || 'unknown'}`; });
    });
  }

  function openFilters() {
    showPopover(els.filterBtn, pop => {
      addTitle(pop, 'Sort');
      const prioritySort = ui.sortMode === 'priority-low'
        ? 'low'
        : ui.sortMode === 'priority-high' || ui.sortMode === 'priority'
          ? 'high'
          : null;
      const priorityLabelText = prioritySort === 'high'
        ? 'Priority: high first'
        : prioritySort === 'low'
          ? 'Priority: low first'
          : 'Priority';
      const priorityItem = addItem(pop, priorityLabelText, () => {
        if (!prioritySort) ui.sortMode = 'priority-high';
        else if (prioritySort === 'high') ui.sortMode = 'priority-low';
        else ui.sortMode = null;
        render();
        closePopover();
      });
      setItemActive(priorityItem, prioritySort);

      const dueItem = addItem(pop, 'Due date', () => {
        ui.sortMode = ui.sortMode === 'due' ? null : 'due';
        render();
        closePopover();
      });
      setItemActive(dueItem, ui.sortMode === 'due');

      const allTags = new Set();
      state.tasks.forEach(t => (t.tags || []).forEach(tag => allTags.add(tag)));
      if (allTags.size > 0) {
        addDivider(pop);
        addTitle(pop, 'Filter by tag');
        [...allTags].sort().forEach(tag => {
          const item = addItem(pop, '#' + tag, () => {
            if (ui.activeTagFilters.has(tag)) ui.activeTagFilters.delete(tag);
            else ui.activeTagFilters.add(tag);
            render();
            openFilters(); // refresh popover
          });
          setItemActive(item, ui.activeTagFilters.has(tag));
        });
      }

      if (ui.sortMode || ui.activePrioFilter || ui.activeTagFilters.size > 0) {
        addDivider(pop);
        addItem(pop, '✕  Clear all filters', () => {
          ui.sortMode = null;
          ui.activePrioFilter = null;
          ui.activeTagFilters.clear();
          render();
          closePopover();
        });
      }
    });
  }

  // ============================================================
  // TOP BAR EVENTS
  // ============================================================
  function openSearch() {
    els.searchWrap.classList.add('is-open');
    requestAnimationFrame(() => {
      els.searchInput.focus();
      els.searchInput.select();
    });
  }

  function closeSearchIfEmpty() {
    if (els.searchInput.value) return;
    els.searchWrap.classList.remove('is-open', 'has-text');
    els.searchInput.blur();
  }

  function clearSearch() {
    els.searchInput.value = '';
    ui.searchQuery = '';
    els.searchWrap.classList.remove('has-text');
    render();
  }

  function dismissAppIfPossible() {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) return false;
    tauri.core.invoke('hide_main_window').catch(() => {});
    return true;
  }

  function handleIdleEscape() {
    if (ui.openPopover) { closePopover(); return true; }
    if (ui.expandedTaskId) {
      const taskEl = document.querySelector(`.task[data-id="${ui.expandedTaskId}"]`);
      const panel = taskEl ? taskEl.querySelector('.task-detail') : null;
      collapseTaskInPlace(ui.expandedTaskId, panel);
      restoreSelection({ focus: true });
      return true;
    }
    if (activeToast) { dismissToast(activeToast); return true; }
    return dismissAppIfPossible();
  }

  function toggleToolbarPopover(anchorEl, openFn) {
    if (ui.openPopover && ui.openPopoverAnchor === anchorEl) closePopover();
    else openFn();
  }

  els.settingsBtn.addEventListener('click', e => { e.stopPropagation(); toggleToolbarPopover(els.settingsBtn, openSettings); });
  els.infoBtn.addEventListener('click', e => { e.stopPropagation(); toggleToolbarPopover(els.infoBtn, openInfo); });
  els.filterBtn.addEventListener('click', e => { e.stopPropagation(); toggleToolbarPopover(els.filterBtn, openFilters); });
  els.addLaneBtn.addEventListener('click', e => { e.stopPropagation(); if (ui.openPopover) closePopover(); addLane(); });
  els.topbar?.addEventListener('mousedown', e => {
    if (e.target.closest('.brand, .search-wrap, .topbar-actions, button, input, textarea, select, a')) return;
    ui.pendingClick = null;
    clearKeyboardFocus();
  });

  els.searchInput.addEventListener('input', () => {
    ui.searchQuery = els.searchInput.value.trim();
    if (els.searchInput.value) els.searchWrap.classList.add('has-text');
    else els.searchWrap.classList.remove('has-text');
    render();
  });
  els.searchClear.addEventListener('click', () => {
    clearSearch();
    closeSearchIfEmpty();
  });
  els.searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (els.searchInput.value) {
        clearSearch();
        return;
      }
      if (document.activeElement === els.searchInput) {
        closeSearchIfEmpty();
        restoreSelection({ focus: true });
        return;
      }
      handleIdleEscape();
    }
  });

  // ============================================================
  // CLICK-VS-DRAG GUARD (the headline fix)
  // ============================================================
  function laneFocusTarget(e) {
    if (e.target.closest(
      '.task, .add-task-cta, .lane-menu-btn, .popover, button, input, textarea, select, a, ' +
      '.task-prio, .task-actions, .task-tag, .task-tag-more, .task-due, .task-done-btn, ' +
      '.task-detail, [contenteditable="true"]'
    )) return null;

    const lane = e.target.closest('.lane');
    if (!lane) return null;

    const laneBody = e.target.closest('.lane-body');
    if (laneBody) return lane.dataset.lane;

    const laneHeader = e.target.closest('.lane-header');
    if (laneHeader && !e.target.closest('.lane-title, .lane-title-wrap')) {
      return lane.dataset.lane;
    }

    return null;
  }

  els.board.addEventListener('mousedown', e => {
    const taskEl = e.target.closest('.task');
    if (!taskEl) {
      ui.pendingClick = null;
      const laneId = laneFocusTarget(e);
      if (laneId) focusLane(laneId);
      return;
    }
    selectTask(taskEl.dataset.id, { focus: false });

    if (isPriorityEdgeEvent(e, taskEl)) {
      ui.pendingClick = null;
      return;
    }

    // Don't track click on interactive children
    if (e.target.closest(
      '.task-prio, .task-actions, .task-tag, .task-tag-more, .task-due, ' +
      '.task-done-btn, .task-detail, [contenteditable="true"]'
    )) {
      ui.pendingClick = null;
      return;
    }

    ui.pendingClick = {
      taskId: taskEl.dataset.id,
      startX: e.clientX,
      startY: e.clientY,
      startTime: Date.now()
    };
  });

  els.board.addEventListener('mouseup', e => {
    if (!ui.pendingClick) return;
    const { taskId, startX, startY, startTime } = ui.pendingClick;
    ui.pendingClick = null;

    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);
    const dt = Date.now() - startTime;

    if (dx > CLICK_MAX_MOVEMENT || dy > CLICK_MAX_MOVEMENT) return; // it was a drag
    if (dt > CLICK_MAX_DURATION) return;                            // long-press

    const taskEl = e.target.closest('.task');
    if (!taskEl || taskEl.dataset.id !== taskId) return;

    if (e.detail >= 2) return; // double-click handled separately

    // Defer slightly so a follow-up dblclick can cancel
    if (ui.clickToggleTimer) clearTimeout(ui.clickToggleTimer);
    ui.clickToggleTimer = setTimeout(() => {
      ui.clickToggleTimer = null;
      toggleExpandTask(taskId);
    }, DBLCLICK_DELAY);
  });

  // Cancel pending single-click on dblclick (capture phase)
  els.board.addEventListener('dblclick', e => {
    if (ui.clickToggleTimer) {
      clearTimeout(ui.clickToggleTimer);
      ui.clickToggleTimer = null;
    }
  }, true);

  // ============================================================
  // EXPLICIT CLICK HANDLERS — interactive children
  // ============================================================
  els.board.addEventListener('dblclick', e => {
    const textEl = e.target.closest('.task-text');
    if (textEl && textEl.contentEditable !== 'true') {
      const taskEl = textEl.closest('.task');
      const task = state.tasks.find(t => t.id === taskEl.dataset.id);
      if (task) {
        e.stopPropagation();
        startEditTask(textEl, task);
        return;
      }
    }
    if (e.target.closest('.task') || e.target.closest('.add-task-cta')) return;
    const laneBody = e.target.closest('.lane-body');
    if (laneBody) addTaskInLane(laneBody.dataset.laneId);
  });

  els.board.addEventListener('click', e => {
    const taskEl = e.target.closest('.task');
    if (!taskEl) return;
    const task = state.tasks.find(t => t.id === taskEl.dataset.id);
    if (!task) return;

    // Done circle — simple complete/reopen toggle.
    if (e.target.closest('.task-done-btn')) {
      selectTask(task.id, { focus: false });
      toggleTaskCompletion(task.id, taskEl);
      return;
    }

    if (!e.target.closest('.task-prio') && isPriorityEdgeEvent(e, taskEl)) {
      e.preventDefault();
      e.stopPropagation();
      cycleTaskPriority(task, taskEl);
      return;
    }

    // Priority dot — in-place
    if (e.target.closest('.task-prio')) {
      cycleTaskPriority(task, taskEl);
      return;
    }

    // Delete (with undo)
    if (e.target.closest('.task-x')) {
      taskEl.style.transition = 'opacity 0.15s, transform 0.15s';
      taskEl.style.opacity = '0';
      taskEl.style.transform = 'translateX(20px)';
      const id = task.id;
      setTimeout(() => deleteTask(id), 150);
      return;
    }

    // Tags / due-date inside header — already handled with stopPropagation in their own onclick
  });

  // ============================================================
  // CLICK-OUTSIDE-TO-COLLAPSE
  // ============================================================
  document.addEventListener('mousedown', e => {
    if (ui.openPopover) return; // popover logic handles its own outside click
    if (!ui.expandedTaskId) return;
    if (e.target.closest('.task')) return;          // clicked inside some task
    if (e.target.closest('.toast')) return;         // clicked toast button
    if (e.target.closest('.popover')) return;
    // Collapse the expanded one
    const taskEl = document.querySelector(`.task[data-id="${ui.expandedTaskId}"]`);
    const panel = taskEl ? taskEl.querySelector('.task-detail') : null;
    collapseTaskInPlace(ui.expandedTaskId, panel);
  });

  // ============================================================
  // DRAG & DROP  (pointer-event based — no HTML5 DnD)
  // ============================================================
  function clearDropIndicator() {
    if (ui.dropIndicator && ui.dropIndicator.parentNode) ui.dropIndicator.parentNode.removeChild(ui.dropIndicator);
    ui.dropIndicator = null;
  }
  function ensureDropIndicator() {
    if (!ui.dropIndicator) {
      ui.dropIndicator = document.createElement('div');
      ui.dropIndicator.className = 'drop-indicator';
    }
    return ui.dropIndicator;
  }
  function clearLaneDropIndicator() {
    if (ui.laneDropIndicator && ui.laneDropIndicator.parentNode) ui.laneDropIndicator.parentNode.removeChild(ui.laneDropIndicator);
    ui.laneDropIndicator = null;
  }
  function ensureLaneDropIndicator() {
    if (!ui.laneDropIndicator) {
      ui.laneDropIndicator = document.createElement('div');
      ui.laneDropIndicator.className = 'lane-drop-indicator';
    }
    return ui.laneDropIndicator;
  }

  // --- Pointer DnD state ---
  let dndPointer = null;  // { pointerId, startX, startY, kind, sourceEl, ghost, committed }

  function dndCleanup() {
    if (!dndPointer) return;
    if (dndPointer.sourceEl && dndPointer.sourceEl.hasPointerCapture && dndPointer.sourceEl.hasPointerCapture(dndPointer.pointerId)) {
      try { dndPointer.sourceEl.releasePointerCapture(dndPointer.pointerId); } catch (err) { }
    }
    if (dndPointer.ghost && dndPointer.ghost.parentNode) dndPointer.ghost.parentNode.removeChild(dndPointer.ghost);
    if (dndPointer.sourceEl) dndPointer.sourceEl.classList.remove('dragging', 'lane-dragging');
    if (dndPointer.currentLaneEl) dndPointer.currentLaneEl.classList.remove('drag-target');
    els.lanes.classList.remove('lane-drag-active');
    document.body.classList.remove('dnd-active');
    clearDropIndicator();
    clearLaneDropIndicator();
    ui.draggedTaskId = null;
    ui.draggedLaneId = null;
    ui.dragKind = null;
    dndPointer = null;
  }

  function createGhost(sourceEl) {
    const ghost = sourceEl.cloneNode(true);
    ghost.className = sourceEl.className + ' dnd-ghost';
    ghost.style.position = 'fixed';
    ghost.style.zIndex = '99999';
    ghost.style.pointerEvents = 'none';
    ghost.style.margin = '0';
    ghost.setAttribute('aria-hidden', 'true');
    const rect = sourceEl.getBoundingClientRect();
    ghost.style.width = rect.width + 'px';
    if (ui.dragKind === 'lane') {
      ghost.style.height = rect.height + 'px';
    }
    document.body.appendChild(ghost);
    return ghost;
  }

  function positionGhost(ghost, x, y) {
    const w = parseFloat(ghost.style.width) || 0;
    ghost.style.left = (x - w / 2) + 'px';
    ghost.style.top = (y - 14) + 'px';
  }

  // --- Auto-scroll when dragging near lane-body edges ---
  let autoScrollRAF = null;
  function startAutoScroll(body, clientY) {
    cancelAnimationFrame(autoScrollRAF);
    const EDGE = 30, SPEED = 6;
    const rect = body.getBoundingClientRect();
    const loop = () => {
      if (!dndPointer || !dndPointer.committed) return;
      const dy = clientY < rect.top + EDGE ? -SPEED : clientY > rect.bottom - EDGE ? SPEED : 0;
      if (dy) { body.scrollTop += dy; autoScrollRAF = requestAnimationFrame(loop); }
    };
    loop();
  }
  function stopAutoScroll() { cancelAnimationFrame(autoScrollRAF); }

  function taskDropCacheFor(body, laneId) {
    if (!dndPointer.taskDropCache) dndPointer.taskDropCache = new Map();
    if (!dndPointer.taskDropCache.has(laneId)) {
      dndPointer.taskDropCache.set(laneId, {
        taskEls: [...body.children].filter(el => el.classList.contains('task') && el.dataset.id !== ui.draggedTaskId),
        cta: body.querySelector('.add-task-cta')
      });
    }
    return dndPointer.taskDropCache.get(laneId);
  }

  // --- Task drag-over hit testing ---
  function updateTaskDropIndicator(x, y) {
    clearLaneDropIndicator();
    // Hide ghost briefly to get element underneath
    const ghost = dndPointer && dndPointer.ghost;
    if (ghost) ghost.style.display = 'none';
    const elUnder = document.elementFromPoint(x, y);
    if (ghost) ghost.style.display = '';

    const laneEl = elUnder && elUnder.closest ? elUnder.closest('.lane') : null;

    if (!laneEl || !laneEl.dataset.lane) {
      if (dndPointer.currentLaneEl) dndPointer.currentLaneEl.classList.remove('drag-target');
      dndPointer.currentLaneEl = null;
      clearDropIndicator();
      stopAutoScroll();
      return;
    }
    if (dndPointer.currentLaneEl !== laneEl) {
      if (dndPointer.currentLaneEl) dndPointer.currentLaneEl.classList.remove('drag-target');
      dndPointer.currentLaneEl = laneEl;
      laneEl.classList.add('drag-target');
    }

    const body = laneEl.querySelector('.lane-body');
    if (!body) return;

    // Auto-scroll
    startAutoScroll(body, y);

    const indicator = ensureDropIndicator();
    const { taskEls, cta } = taskDropCacheFor(body, laneEl.dataset.lane);
    if (taskEls.length === 0) {
      if (cta && indicator.nextSibling !== cta) body.insertBefore(indicator, cta);
      else if (!cta && indicator !== body.lastChild) body.appendChild(indicator);
      return;
    }
    let insertBefore = null;
    for (const t of taskEls) {
      const rect = t.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) { insertBefore = t; break; }
    }
    if (insertBefore) {
      if (indicator.nextSibling !== insertBefore) body.insertBefore(indicator, insertBefore);
    } else {
      if (cta) {
        if (indicator.nextSibling !== cta) body.insertBefore(indicator, cta);
      } else if (indicator !== body.lastChild) body.appendChild(indicator);
    }
  }

  // --- Lane drag-over hit testing ---
  function updateLaneDropIndicator(x, y) {
    clearDropIndicator();
    const ghost = dndPointer && dndPointer.ghost;
    if (ghost) ghost.style.display = 'none';
    const elUnder = document.elementFromPoint(x, y);
    if (ghost) ghost.style.display = '';

    const indicator = ensureLaneDropIndicator();
    const laneEls = dndPointer.laneEls || [...els.lanes.querySelectorAll('.lane')];
    let insertBefore = null;
    for (const l of laneEls) {
      if (l.classList.contains('lane-dragging')) continue;
      const rect = l.getBoundingClientRect();
      if (x < rect.left + rect.width / 2) { insertBefore = l; break; }
    }
    if (insertBefore) {
      if (indicator.nextSibling !== insertBefore) els.lanes.insertBefore(indicator, insertBefore);
    } else if (indicator !== els.lanes.lastChild) els.lanes.appendChild(indicator);
  }

  // --- Commit task drop ---
  function commitTaskDrop() {
    const draggedId = ui.draggedTaskId;
    if (!draggedId) return;
    const draggedTask = state.tasks.find(t => t.id === draggedId);
    if (!draggedTask) return;

    // Find which lane the indicator is in
    const indicator = ui.dropIndicator;
    const indicatorParent = indicator && indicator.parentNode;
    const laneEl = indicatorParent && indicatorParent.closest ? indicatorParent.closest('.lane') : null;
    const targetLaneId = laneEl ? laneEl.dataset.lane : draggedTask.laneId;

    // Find the task ID that should follow the dropped task
    let afterTaskId = null;
    if (indicator && indicatorParent) {
      let node = indicator.nextSibling;
      while (node) {
        if (node.classList && node.classList.contains('task') && node.dataset.id !== draggedId) {
          afterTaskId = node.dataset.id;
          break;
        }
        node = node.nextSibling;
      }
    }

    const tasksCopy = state.tasks.filter(t => t.id !== draggedId);
    const wasInDifferentLane = draggedTask.laneId !== targetLaneId;
    draggedTask.laneId = targetLaneId;

    if (afterTaskId !== null) {
      const insertIdx = tasksCopy.findIndex(t => t.id === afterTaskId);
      if (insertIdx >= 0) tasksCopy.splice(insertIdx, 0, draggedTask);
      else tasksCopy.push(draggedTask);
    } else {
      let lastIdx = -1;
      for (let i = tasksCopy.length - 1; i >= 0; i--) {
        if (tasksCopy[i].laneId === targetLaneId) { lastIdx = i; break; }
      }
      if (lastIdx >= 0) tasksCopy.splice(lastIdx + 1, 0, draggedTask);
      else tasksCopy.push(draggedTask);
    }
    state.tasks = tasksCopy;
    ui.focusedTaskId = draggedId;
    ui.activeLaneId = targetLaneId;
    clearDropIndicator();
    renderAndPersist(new Set([draggedId]));

    // Confetti when the task lands in the LAST lane (typical "done" lane)
    if (wasInDifferentLane) {
      const targetIdx = laneIndexOf(targetLaneId);
      if (targetIdx === state.lanes.length - 1) {
        const newEl = document.querySelector(`[data-id="${draggedId}"]`);
        if (newEl) burstConfetti(newEl);
      }
    }
  }

  // --- Commit lane drop ---
  function commitLaneDrop() {
    if (!ui.draggedLaneId) return;
    let beforeId = null;
    if (ui.laneDropIndicator && ui.laneDropIndicator.parentNode === els.lanes) {
      let next = ui.laneDropIndicator.nextSibling;
      while (next && !(next.classList && next.classList.contains('lane'))) next = next.nextSibling;
      if (next && next.classList.contains('lane')) beforeId = next.dataset.lane;
    }
    reorderLane(ui.draggedLaneId, beforeId);
    ui.activeLaneId = ui.draggedLaneId;
    clearLaneDropIndicator();
  }

  // --- Main pointer event listeners ---
  els.board.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;  // left button only
    if (dndPointer) return;      // already tracking
    if (e.target.isContentEditable || e.target.closest('[contenteditable="true"]')) return;
    if (e.target.closest('.add-task-cta')) return;
    if (e.target.closest('.task-detail')) return;
    if (e.target.closest('.lane-menu-btn, .popover, button, input, textarea, select, a')) return;
    if (e.target.closest('.task-prio, .task-done-btn, .task-actions, .task-tag, .task-tag-more, .task-due')) return;

    const laneHeader = e.target.closest('.lane-header');
    const taskEl = e.target.closest('.task');

    let kind = null, sourceEl = null;
    if (laneHeader && !taskEl) {
      kind = 'lane';
      sourceEl = laneHeader.closest('.lane');
    } else if (taskEl) {
      kind = 'task';
      sourceEl = taskEl;
    }
    if (!kind) return;

    if (kind === 'lane') e.preventDefault();
    dndPointer = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      kind,
      sourceEl,
      ghost: null,
      committed: false
    };
    // Don't capture yet — wait until movement exceeds threshold
  });

  window.addEventListener('pointermove', e => {
    if (!dndPointer || e.pointerId !== dndPointer.pointerId) return;

    const dx = e.clientX - dndPointer.startX;
    const dy = e.clientY - dndPointer.startY;

    if (!dndPointer.committed) {
      if (Math.abs(dx) < DND_MOVE_THRESHOLD && Math.abs(dy) < DND_MOVE_THRESHOLD) return;

      // --- Commit the drag ---
      e.preventDefault();
      dndPointer.committed = true;
      try { dndPointer.sourceEl.setPointerCapture(e.pointerId); } catch (err) { }
      document.body.classList.add('dnd-active');

      // Cancel any pending click
      ui.pendingClick = null;
      if (ui.clickToggleTimer) { clearTimeout(ui.clickToggleTimer); ui.clickToggleTimer = null; }

      if (dndPointer.kind === 'task') {
        ui.dragKind = 'task';
        ui.draggedTaskId = dndPointer.sourceEl.dataset.id;
        dndPointer.taskDropCache = new Map();
        dndPointer.sourceEl.classList.add('dragging');
        dndPointer.ghost = createGhost(dndPointer.sourceEl);
      } else {
        ui.dragKind = 'lane';
        ui.draggedLaneId = dndPointer.sourceEl.dataset.lane;
        dndPointer.laneEls = [...els.lanes.querySelectorAll('.lane')];
        dndPointer.sourceEl.classList.add('lane-dragging');
        els.lanes.classList.add('lane-drag-active');
        dndPointer.ghost = createGhost(dndPointer.sourceEl);
      }
      positionGhost(dndPointer.ghost, e.clientX, e.clientY);
      if (dndPointer.kind === 'task') updateTaskDropIndicator(e.clientX, e.clientY);
      else updateLaneDropIndicator(e.clientX, e.clientY);
      return;
    }

    // --- Already committed — update ghost + indicator ---
    e.preventDefault();
    positionGhost(dndPointer.ghost, e.clientX, e.clientY);

    if (dndPointer.kind === 'task') {
      updateTaskDropIndicator(e.clientX, e.clientY);
    } else {
      updateLaneDropIndicator(e.clientX, e.clientY);
    }
  });

  window.addEventListener('pointerup', e => {
    if (!dndPointer || e.pointerId !== dndPointer.pointerId) return;

    if (dndPointer.committed) {
      stopAutoScroll();
      if (dndPointer.kind === 'task') commitTaskDrop();
      else commitLaneDrop();
    }
    dndCleanup();
  });

  window.addEventListener('pointercancel', e => {
    if (!dndPointer || e.pointerId !== dndPointer.pointerId) return;
    stopAutoScroll();
    dndCleanup();
  });

  // Escape cancels drag
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && dndPointer && dndPointer.committed) {
      e.preventDefault();
      stopAutoScroll();
      dndCleanup();
    }
  });

  // ============================================================
  // KEYBOARD
  // ============================================================
  window.addEventListener('resize', () => {
    markWindowResizing();
    scheduleWindowWidthPersistence();
    if (ui.openPopover) schedulePopoverPosition();
  });

  function currentLaneContext() {
    return ui.activeLaneId || currentSelectedTask()?.laneId || state.lanes[0]?.id || null;
  }

  function addTaskInCurrentContext() {
    const laneId = currentLaneContext();
    if (laneId) addTaskInLane(laneId);
  }

  function isDeleteTaskShortcut(e) {
    const isForwardDelete = e.key === 'Delete' || e.code === 'Delete';
    const isCommandBackspace = e.metaKey && (e.key === 'Backspace' || e.code === 'Backspace');
    return isForwardDelete || isCommandBackspace;
  }

  function selectTaskByVerticalDelta(delta) {
    const ids = visibleTaskIds();
    if (ids.length === 0) return false;
    const currentId = restoreSelection({ focus: false });
    const currentIndex = Math.max(0, ids.indexOf(currentId));
    const nextIndex = Math.min(ids.length - 1, Math.max(0, currentIndex + delta));
    selectTask(ids[nextIndex], { focus: true });
    return true;
  }

  function nearestTaskInLaneByY(laneId, y) {
    const taskEls = [...document.querySelectorAll(`.lane[data-lane="${laneId}"] .task`)];
    if (taskEls.length === 0) return null;
    let best = taskEls[0];
    let bestDist = Infinity;
    taskEls.forEach(taskEl => {
      const rect = taskEl.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const dist = Math.abs(centerY - y);
      if (dist < bestDist) {
        best = taskEl;
        bestDist = dist;
      }
    });
    return best.dataset.id;
  }

  function selectLaneByDelta(delta) {
    const lanes = state.lanes;
    if (lanes.length === 0) return false;
    const currentLaneId = currentLaneContext();
    const currentIndex = Math.max(0, lanes.findIndex(lane => lane.id === currentLaneId));
    const nextLane = lanes[currentIndex + delta];
    if (!nextLane) {
      restoreSelection({ focus: true });
      return false;
    }

    rememberSelectionGeometry();
    ui.activeLaneId = nextLane.id;
    const targetTaskId = nearestTaskInLaneByY(nextLane.id, ui.lastSelectionY || 0);
    if (targetTaskId) {
      selectTask(targetTaskId, { focus: true, fallbackLaneId: nextLane.id });
      return true;
    }

    focusLane(nextLane.id);
    return true;
  }

  let mainWindowReadyMarked = false;

  function markMainWindowReady() {
    if (mainWindowReadyMarked) return;
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;

    mainWindowReadyMarked = true;
    invoke('mark_main_window_ready').catch(() => {
      mainWindowReadyMarked = false;
    });
  }

  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const isSearch = e.target === els.searchInput;
    const isEditing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    if (e.key === 'Escape') {
      e.preventDefault();
      if (isSearch) return;
      handleIdleEscape();
      return;
    }

    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (!isEditing || isSearch) {
        e.preventDefault();
        openSearch();
      }
      return;
    }

    if (e.key.startsWith('Arrow')) {
      if (isEditing && !isSearch) return;
      e.preventDefault();
      if (e.metaKey && e.key === 'ArrowLeft') { moveSelectedTaskByLane(-1); return; }
      if (e.metaKey && e.key === 'ArrowRight') { moveSelectedTaskByLane(1); return; }
      if (e.metaKey && e.key === 'ArrowUp') { adjustSelectedTaskPriority(1); return; }
      if (e.metaKey && e.key === 'ArrowDown') { adjustSelectedTaskPriority(-1); return; }
      if (e.key === 'ArrowUp') { selectTaskByVerticalDelta(-1); return; }
      if (e.key === 'ArrowDown') { selectTaskByVerticalDelta(1); return; }
      if (e.key === 'ArrowLeft') { selectLaneByDelta(-1); return; }
      if (e.key === 'ArrowRight') { selectLaneByDelta(1); return; }
      return;
    }

    if (isEditing) return;

    if ((e.key === 'z' || e.key === 'Z') && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (undoLastAction()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if ((e.key === 'a' || e.key === 'A' || e.key === '+') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      addTaskInCurrentContext();
      return;
    }

    const selectedId = restoreSelection({ focus: false });

    if (e.key === 'Enter' && selectedId) {
      e.preventDefault();
      selectTask(selectedId, { focus: true });
      toggleExpandTask(selectedId);
      return;
    }

    if (e.key === ' ' && selectedId) {
      e.preventDefault();
      toggleTaskCompletion(selectedId, selectedTaskElement());
      return;
    }

    if (isDeleteTaskShortcut(e) && selectedId) {
      e.preventDefault();
      e.stopPropagation();
      deleteTask(selectedId);
      return;
    }
  });

  // ============================================================
  // INIT
  // ============================================================
  syncAutosizeMenu();
  isLaunchAtLoginEnabled().then(syncLaunchAtLoginMenu);
  render();
  markMainWindowReady();
  showAfterUpdateRestartIfNeeded();
  if (!hadStoredBoard && localStorage.getItem(ONBOARDING_SEEN_KEY) !== 'true') {
    setTimeout(showOnboarding, 350);
  }
})();
