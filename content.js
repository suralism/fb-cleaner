// ============================================================
// FB Activity Cleaner - Content Script (v2.3)
// Features: Multi-action support, persistent stats, rate-limit auto-pause,
// emergency hotkeys (Alt+S), and audio notifications.
// ============================================================

// --- State Variables ---
let isRunning = false;
let isPaused = false;
let deletedCount = 0;
let totalDeletedAllTime = 0;
let scannedCount = 0;
let currentLogs = [];
let settings = { delay: 3000, mode: 'individual', targetAction: 'trash' };
let scrollAttempts = 0;
let loopTimeoutId = null;
let processedRowKeys = new Set(); // Track unique row text keys we already tried to prevent skipping due to DOM recycling
let rowAttempts = new Map(); // Track attempts per row key to prevent infinite loops

// Initialize persistent stats from storage
(async function initStats() {
  try {
    const res = await chrome.storage.local.get(['totalDeletedAllTime', 'extensionSettings']);
    if (res.totalDeletedAllTime !== undefined) {
      totalDeletedAllTime = res.totalDeletedAllTime;
    }
    if (res.extensionSettings) {
      settings = { ...settings, ...res.extensionSettings };
    }
  } catch (e) {}
})();

// --- Helpers ---

function addLog(text, logType = 'info') {
  const logEntry = { text, type: logType, time: new Date().toLocaleTimeString() };
  currentLogs.push(logEntry);
  if (currentLogs.length > 100) currentLogs.shift();
  chrome.runtime.sendMessage({ type: 'log', text, logType }).catch(() => {});
}

function broadcastState() {
  const state = isPaused ? 'paused' : (isRunning ? 'running' : 'idle');
  chrome.runtime.sendMessage({
    type: 'state_update',
    state,
    deletedCount,
    totalDeletedAllTime,
    scannedCount
  }).catch(() => {});
}

async function incrementDeletedCount(amount = 1) {
  deletedCount += amount;
  totalDeletedAllTime += amount;
  try {
    await chrome.storage.local.set({ totalDeletedAllTime });
  } catch (e) {}
  broadcastState();
}

const sleep = (ms) => new Promise(resolve => {
  loopTimeoutId = setTimeout(resolve, ms);
});

// Audio chime Synthesizer using Web Audio API (Zero external dependencies)
function playAudioChime(type = 'success') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } else if (type === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime); // A3
      osc.frequency.setValueAtTime(164.81, ctx.currentTime + 0.15); // E3
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    }
  } catch (e) {}
}

// Emergency Hotkey Listener (Alt + S)
window.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 's' || e.key === 'S')) {
    if (isRunning) {
      isRunning = false;
      isPaused = false;
      if (loopTimeoutId) clearTimeout(loopTimeoutId);
      addLog('🚨 Emergency stop triggered via Alt+S hotkey!', 'error');
      playAudioChime('error');
      broadcastState();
    }
  }
});

// Check if Facebook is showing a Rate Limit or Block message
function checkRateLimitBlock() {
  const pageText = (document.body ? document.body.textContent || '' : '').toLowerCase();
  const blockKeywords = [
    "you're temporarily blocked", "you’re temporarily blocked",
    "you have been temporarily blocked", "action blocked",
    "คุณถูกจำกัดการใช้งานชั่วคราว", "การดำเนินการถูกบล็อก",
    "คุณถูกบล็อกชั่วคราว", "ลองอีกครั้งในภายหลัง", "try again later"
  ];
  for (const kw of blockKeywords) {
    if (pageText.includes(kw)) {
      return kw;
    }
  }
  return null;
}

// Action Keyword Mapping for Multi-Action Support
function getActionKeywords() {
  const mode = settings.targetAction || 'trash';
  if (mode === 'untag') {
    return {
      exact: ['remove tag', 'untag', 'เอาแท็กออก', 'ลบแท็ก'],
      partial: ['remove tag', 'untag', 'เอาแท็กออก', 'ลบแท็ก', 'แท็ก', 'tag'],
      label: 'Remove Tag'
    };
  } else if (mode === 'hide') {
    return {
      exact: ['hide from profile', 'hide from timeline', 'ซ่อนจากโปรไฟล์', 'ซ่อนจากไทม์ไลน์'],
      partial: ['hide from profile', 'hide from timeline', 'ซ่อนจากโปรไฟล์', 'ซ่อนจากไทม์ไลน์', 'ซ่อน'],
      label: 'Hide from Profile'
    };
  } else if (mode === 'unreact') {
    return {
      exact: ['remove reaction', 'unlike', 'ยกเลิกการแสดงความรู้สึก', 'เลิกถูกใจ', 'ยกเลิกความรู้สึก'],
      partial: ['remove reaction', 'unlike', 'ยกเลิกการแสดงความรู้สึก', 'เลิกถูกใจ', 'ความรู้สึก', 'ถูกใจ'],
      label: 'Remove Reaction'
    };
  }
  // Default: trash
  return {
    exact: ['move to trash', 'move to bin', 'ย้ายไปที่ถังขยะ', 'ย้ายไปยังถังขยะ', 'ย้ายลงถังขยะ', 'delete', 'ลบ'],
    partial: ['trash', 'delete', 'remove', 'ถังขยะ', 'ลบ', 'ลบออก', 'นำออก'],
    label: 'Move to Trash'
  };
}

// --- Click Simulation ---
function simulateClick(el) {
  if (!el) return;

  el.scrollIntoView({ behavior: 'instant', block: 'center' });

  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  let targetEl = document.elementFromPoint(x, y) || el;

  if (targetEl !== el && !el.contains(targetEl)) {
    targetEl = el.querySelector('span, div') || el;
  }

  const opts = {
    view: window,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    screenX: window.screenX + x,
    screenY: window.screenY + y,
    button: 0,
    buttons: 1
  };

  targetEl.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerId: 1 }));
  targetEl.dispatchEvent(new MouseEvent('mouseover', opts));
  targetEl.dispatchEvent(new PointerEvent('pointerenter', { ...opts, pointerId: 1 }));
  targetEl.dispatchEvent(new MouseEvent('mouseenter', opts));

  targetEl.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
  targetEl.dispatchEvent(new MouseEvent('mousedown', opts));
  targetEl.focus();

  targetEl.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
  targetEl.dispatchEvent(new MouseEvent('mouseup', opts));
  targetEl.dispatchEvent(new MouseEvent('click', opts));

  try { targetEl.click(); } catch (e) {}
  if (targetEl !== el) {
    try { el.click(); } catch (e) {}
  }
}

function fallbackClick(el) {
  if (!el) return;
  try { el.click(); } catch (e) {}
}

function getRowKey(rowContainer) {
  if (!rowContainer) return '';
  return (rowContainer.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 500);
}

function findActivityRows() {
  const results = [];
  const allButtons = document.querySelectorAll('[role="button"], [aria-haspopup="menu"]');

  for (const btn of allButtons) {
    const aria = (btn.getAttribute('aria-label') || '');
    const ariaLower = aria.toLowerCase();
    const hasMenuPopup = btn.getAttribute('aria-haspopup') === 'menu' || btn.getAttribute('aria-haspopup') === 'true';

    const isMoreOptions = ariaLower.startsWith('more options') ||
                          ariaLower.includes('ตัวเลือกเพิ่มเติม') ||
                          ariaLower.includes('การดำเนินการเพิ่มเติม') ||
                          ariaLower.includes('ตัวเลือกสำหรับ') ||
                          (hasMenuPopup && (ariaLower.includes('option') || ariaLower.includes('ตัวเลือก') || ariaLower === ''));

    if (!isMoreOptions) continue;

    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    let rowContainer = btn.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!rowContainer) break;
      const r = rowContainer.getBoundingClientRect();
      if (r.width > window.innerWidth * 0.4) break;
      rowContainer = rowContainer.parentElement;
    }

    const rowKey = getRowKey(rowContainer);
    if (!rowContainer || !rowKey || processedRowKeys.has(rowKey)) continue;

    results.push({
      row: rowContainer,
      viewBtn: null,
      menuBtn: btn,
      label: aria || 'Menu Button',
      key: rowKey
    });
  }

  // Strategy 2 (Fallback): Find small icon-only buttons with SVG
  if (results.length === 0) {
    for (const btn of allButtons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width > 50 || rect.height > 50) continue;

      const btnText = (btn.textContent || '').trim();
      const hasIcon = btn.querySelector('svg') !== null;
      const isIconOnly = btnText.length <= 3 || btnText === '';

      if (!hasIcon || !isIconOnly) continue;

      let rowContainer = btn.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!rowContainer) break;
        const r = rowContainer.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.4) break;
        rowContainer = rowContainer.parentElement;
      }

      const rowKey = getRowKey(rowContainer);
      if (!rowContainer || !rowKey || processedRowKeys.has(rowKey)) continue;

      const rowText = (rowContainer.textContent || '').trim();
      if (rowText.length < 10) continue;

      results.push({
        row: rowContainer,
        viewBtn: null,
        menuBtn: btn,
        label: btn.getAttribute('aria-label') || '(icon)',
        key: rowKey
      });
    }
  }

  return results;
}

// Multi-Action option finder inside open dropdown menus
function findTargetActionOption() {
  const { exact: trashKeywordsExact, partial: trashKeywordsPartial, label: actionLabel } = getActionKeywords();

  addLog(`🔍 Searching for "${actionLabel}" option in dropdown...`, 'info');

  // Strategy 1: Look inside [role="menu"] / [role="listbox"]
  const menuContainers = document.querySelectorAll('[role="menu"], [role="listbox"]');
  for (const menu of menuContainers) {
    const items = menu.querySelectorAll('[role="menuitem"], [role="option"], [role="button"], span, div');
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const text = (item.textContent || '').trim().toLowerCase();
      const aria = (item.getAttribute('aria-label') || '').trim().toLowerCase();
      
      for (const kw of trashKeywordsExact) {
        if (text === kw.toLowerCase() || aria === kw.toLowerCase()) {
          addLog(`   🎯 Found exact match: "${text}"`, 'success');
          return item;
        }
      }
      for (const kw of trashKeywordsPartial) {
        if ((text.includes(kw.toLowerCase()) && text.length < 60) || aria.includes(kw.toLowerCase())) {
          addLog(`   🎯 Found partial match: "${text}"`, 'success');
          return item;
        }
      }
    }
  }

  // Strategy 2: Look for [role="menuitem"] anywhere
  const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"]');
  for (const item of menuItems) {
    const rect = item.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = (item.textContent || '').trim().toLowerCase();
    const aria = (item.getAttribute('aria-label') || '').trim().toLowerCase();
    
    for (const kw of trashKeywordsExact) {
      if (text.includes(kw.toLowerCase()) || aria.includes(kw.toLowerCase())) {
        addLog(`   🎯 Found menu item: "${text}"`, 'success');
        return item;
      }
    }
    for (const kw of trashKeywordsPartial) {
      if ((text.includes(kw.toLowerCase()) && text.length < 60) || aria.includes(kw.toLowerCase())) {
        addLog(`   🎯 Found menu item partial: "${text}"`, 'success');
        return item;
      }
    }
  }

  // Strategy 3: Search inside popup overlay layers
  const overlayContainers = document.querySelectorAll(
    '[data-pagelet*="Popover"], [data-pagelet*="popover"], ' +
    '[class*="uiContextualLayer"], [class*="__fb-light-mode"] > div:last-child'
  );
  for (const container of overlayContainers) {
    const items = container.querySelectorAll('[role="button"], span, div');
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width > 350) continue;
      const text = (item.textContent || '').trim().toLowerCase();
      for (const kw of trashKeywordsExact) {
        if (text === kw.toLowerCase()) return item;
      }
    }
  }

  // Strategy 4: Popup elements near end of body
  const bodyChildren = document.body.children;
  for (let i = bodyChildren.length - 1; i >= Math.max(0, bodyChildren.length - 5); i--) {
    const layer = bodyChildren[i];
    if (i === 0) continue;
    const rect = layer.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const items = layer.querySelectorAll('[role="button"], span, div');
    for (const item of items) {
      const ir = item.getBoundingClientRect();
      if (ir.width === 0 || ir.height === 0) continue;
      if (ir.width > 350) continue;
      const text = (item.textContent || '').trim().toLowerCase();
      for (const kw of trashKeywordsExact) {
        if (text === kw.toLowerCase()) return item;
      }
      for (const kw of trashKeywordsPartial) {
        if (text === kw.toLowerCase() || (text.includes(kw.toLowerCase()) && text.length < 30)) return item;
      }
    }
  }

  return null;
}

function findConfirmButton() {
  let searchRoot = document.querySelector('[role="dialog"], [aria-modal="true"]');
  if (!searchRoot) {
    const divs = document.querySelectorAll('div');
    for (const div of divs) {
      const rect = div.getBoundingClientRect();
      if (rect.width > 220 && rect.width < 700 && rect.height > 80 && rect.height < 500) {
        const text = div.textContent || '';
        const hasCancel = text.includes('Cancel') || text.includes('ยกเลิก');
        const hasConfirm = text.includes('Move') || text.includes('Trash') || text.includes('Delete') ||
                           text.includes('ย้าย') || text.includes('เอาออก') || text.includes('ลบ') || text.includes('ต้องการลบ');
        if (hasCancel && hasConfirm) {
          searchRoot = div;
          addLog('🎯 Found confirmation dialog container via heuristics', 'success');
          break;
        }
      }
    }
  }

  if (!searchRoot) {
    searchRoot = document.body;
  }

  const cancelKeywords = ['ยกเลิก', 'cancel', 'close', 'ปิด'];
  const confirmKeywordsExact = [
    'ลบ', 'delete', 'move to trash', 'move to bin', 'ย้ายไปที่ถังขยะ', 'ย้ายไปยังถังขยะ', 'ย้ายลงถังขยะ',
    'ย้าย', 'เอาแท็กออก', 'remove tag', 'remove', 'ซ่อน', 'hide', 'confirm', 'ยืนยัน'
  ];

  const candidates = Array.from(searchRoot.querySelectorAll('[role="button"], button, div[tabindex="0"]')).filter(btn => {
    const rect = btn.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // Strategy 1: Exact text/aria match for confirm keywords
  for (const btn of candidates) {
    const text = (btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
    for (const kw of confirmKeywordsExact) {
      if (text === kw.toLowerCase() || aria === kw.toLowerCase()) {
        addLog(`   🎯 Found exact confirm button (Strategy 1): "${btn.textContent.trim()}"`, 'success');
        return btn;
      }
    }
  }

  // Strategy 2: Candidate button containing confirm keywords and NOT cancel keywords
  for (const btn of candidates) {
    const text = (btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
    const isCancel = cancelKeywords.some(c => text === c || aria === c || text.includes(c));
    if (isCancel) continue;

    for (const kw of confirmKeywordsExact) {
      if (text.includes(kw.toLowerCase()) || aria.includes(kw.toLowerCase())) {
        addLog(`   🎯 Found confirm button candidate (Strategy 2): "${btn.textContent.trim()}"`, 'success');
        return btn;
      }
    }
  }

  // Strategy 3: Non-cancel button in dialog (Deduction method: exclude 'ยกเลิก')
  const validBtns = candidates.filter(btn => {
    const t = (btn.textContent || '').trim().toLowerCase();
    return t.length > 0 && t.length < 30;
  });

  const nonCancel = validBtns.find(btn => {
    const t = (btn.textContent || '').trim().toLowerCase();
    return !cancelKeywords.some(c => t.includes(c));
  });

  if (nonCancel) {
    addLog(`   🎯 Inferred confirm button by excluding Cancel: "${nonCancel.textContent.trim()}"`, 'success');
    return nonCancel;
  }

  // Strategy 4: Fallback to searching spans/divs with exact text "ลบ" or "Delete"
  const textEls = searchRoot.querySelectorAll('span, div, a');
  for (const el of textEls) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.width > 200 || rect.height > 80) continue;

    const text = (el.textContent || '').trim().toLowerCase();
    if (text === 'ลบ' || text === 'delete' || text === 'move to trash' || text === 'ย้ายไปที่ถังขยะ' || text === 'เอาแท็กออก') {
      let clickable = el;
      for (let i = 0; i < 3; i++) {
        if (clickable.parentElement && (
            clickable.parentElement.getAttribute('role') === 'button' ||
            clickable.parentElement.tagName === 'BUTTON'
        )) {
          clickable = clickable.parentElement;
          break;
        }
      }
      addLog(`   🎯 Found text match confirm element (Strategy 4): "${el.textContent.trim()}"`, 'success');
      return clickable;
    }
  }

  return null;
}

async function waitForDialogAppear(maxWaitMs = 4000) {
  const interval = 300;
  const max = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < max; i++) {
    if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return true;
    const bodyText = document.body.textContent || '';
    if (
      bodyText.includes('ต้องการลบใช่ไหม') ||
      bodyText.includes('ต้องการลบ') ||
      bodyText.includes('Move to Trash') ||
      bodyText.includes('ย้ายไปที่ถังขยะ') ||
      bodyText.includes('Remove Tag') ||
      bodyText.includes('เอาแท็กออก')
    ) {
      return true;
    }
    await sleep(interval);
  }
  return false;
}

async function waitForDialogClose(maxWaitMs = 8000) {
  const interval = 400;
  const max = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < max; i++) {
    if (!isRunning || isPaused) return false;
    await sleep(interval);
    const dialogExists = document.querySelector('[role="dialog"], [aria-modal="true"]') !== null;
    const bodyText = document.body.textContent || '';
    const titleExists = bodyText.includes('ต้องการลบใช่ไหม') || bodyText.includes('Move to Trash?');
    if (!dialogExists && !titleExists) return true;
  }
  return false;
}

async function waitForMenuAppear(maxWaitMs = 3500) {
  const interval = 300;
  const max = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < max; i++) {
    await sleep(interval);
    if (document.querySelectorAll('[role="menu"], [role="listbox"]').length > 0) return true;
    if (findTargetActionOption()) return true;
  }
  return false;
}

function closeMenu() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  setTimeout(() => document.body.click(), 200);
}

function findCheckboxes() {
  let cbs = Array.from(document.querySelectorAll('[role="checkbox"]')).filter(cb => {
    const rect = cb.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const aria = (cb.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('select all') || aria.includes('เลือกทั้งหมด')) return false;
    return true;
  });
  if (cbs.length > 0) return { elements: cbs, type: 'role-checkbox' };

  cbs = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(cb => {
    const rect = cb.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (cbs.length > 0) return { elements: cbs, type: 'input-checkbox' };

  return { elements: [], type: 'none' };
}

// --- Message Handler ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'start') {
    settings = message.settings;
    if (isPaused) {
      isPaused = false;
      isRunning = true;
      scrollAttempts = 0;
      addLog('▶ Resuming...', 'info');
      startLoop();
    } else if (!isRunning) {
      isRunning = true;
      isPaused = false;
      scrollAttempts = 0;
      processedRowKeys = new Set();
      rowAttempts = new Map();
      const { label } = getActionKeywords();
      addLog(`▶ Starting process [Action: ${label}]...`, 'info');
      addLog('URL: ' + window.location.href, 'system');

      const { elements: cbs } = findCheckboxes();
      const rows = findActivityRows();
      addLog(`Scan: ${cbs.length} checkboxes, ${rows.length} activity rows with menus`, 'info');
      if (settings.mode === 'batch' && cbs.length === 0 && rows.length > 0) {
        addLog('⚠ No checkboxes found. Auto-switching to One-by-One mode.', 'warning');
        settings.mode = 'individual';
      }
      startLoop();
    }
    broadcastState();
    sendResponse({ success: true });
  }
  else if (message.action === 'pause') {
    isPaused = true;
    isRunning = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    addLog('⏸ Paused.', 'warning');
    broadcastState();
    sendResponse({ success: true });
  }
  else if (message.action === 'stop') {
    isRunning = false;
    isPaused = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    addLog(`⏹ Stopped. Total processed in session: ${deletedCount}`, 'success');
    broadcastState();
    sendResponse({ success: true });
  }
  else if (message.action === 'update_settings') {
    settings = message.settings;
    const { label } = getActionKeywords();
    addLog(`⚙ Settings updated: Delay=${settings.delay / 1000}s, Mode=${settings.mode}, Action=${label}`, 'system');
    sendResponse({ success: true });
  }
  else if (message.action === 'query_state') {
    sendResponse({
      state: isPaused ? 'paused' : (isRunning ? 'running' : 'idle'),
      deletedCount,
      totalDeletedAllTime,
      scannedCount,
      logs: currentLogs,
      settings
    });
  }
  else if (message.action === 'diagnose') {
    runDiagnostics();
    sendResponse({ success: true });
  }
  return true;
});

// --- Main Loop ---
async function startLoop() {
  while (isRunning && !isPaused) {
    try {
      // Rate Limit & Block Detection
      const blockedText = checkRateLimitBlock();
      if (blockedText) {
        addLog(`⛔ Facebook Block / Rate Limit detected ("${blockedText}"). Auto-pausing to protect your account!`, 'error');
        playAudioChime('error');
        isPaused = true;
        isRunning = false;
        broadcastState();
        break;
      }

      let result = false;

      if (settings.mode === 'batch') {
        result = await processBatchMode();
      } else {
        result = await processIndividualMode();
      }

      if (!result) {
        scrollAttempts++;
        if (scrollAttempts > 10) {
          addLog(`⛔ No more items found. Total session items: ${deletedCount}`, 'warning');
          playAudioChime('success');
          isRunning = false;
          broadcastState();
          break;
        }
        addLog(`📜 Scrolling page... (${scrollAttempts}/10)`, 'info');
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(3000);
      } else {
        scrollAttempts = 0;
      }

      const jitter = Math.random() * 1000;
      await sleep(settings.delay + jitter);
    } catch (err) {
      addLog('❌ Error: ' + err.message, 'error');
      await sleep(3000);
    }
  }
}

// --- Individual Mode ---
async function processIndividualMode() {
  if (!isRunning || isPaused) return false;

  const rows = findActivityRows();
  scannedCount = rows.length;
  broadcastState();

  if (rows.length === 0) {
    addLog('No activity rows with menu buttons found.', 'info');
    return false;
  }

  const { label: actionLabel } = getActionKeywords();
  addLog(`Found ${rows.length} activity row(s). Processing first item for [${actionLabel}]...`, 'info');

  const { menuBtn, key: rowKey } = rows[0];

  const attempts = rowAttempts.get(rowKey) || 0;
  if (attempts >= 2) {
    addLog('⚠ Row failed twice. Skipping item to prevent infinite loops.', 'warning');
    processedRowKeys.add(rowKey);
    return false;
  }
  rowAttempts.set(rowKey, attempts + 1);

  const menuLabel = rows[0].label || menuBtn.getAttribute('aria-label') || '(icon)';
  addLog(`🔘 Opening menu: "${menuLabel.substring(0, 40)}"`, 'info');
  
  menuBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
  await sleep(500);

  simulateClick(menuBtn);

  await sleep(300);
  const menuAlready = document.querySelectorAll('[role="menu"], [role="listbox"]').length > 0;
  if (!menuAlready) {
    fallbackClick(menuBtn);
  }

  const appeared = await waitForMenuAppear(3500);
  if (!appeared) {
    addLog('⚠ Menu dropdown did not open. Skipping item.', 'warning');
    closeMenu();
    await sleep(500);
    return false;
  }

  await sleep(600);

  const actionOption = findTargetActionOption();
  if (!actionOption) {
    addLog(`⚠ Target action "${actionLabel}" option not found in dropdown menu. Skipping.`, 'warning');
    processedRowKeys.add(rowKey);
    closeMenu();
    await sleep(500);
    return false;
  }

  const optText = (actionOption.textContent || '').trim().substring(0, 40);
  addLog(`🎯 Clicking action: "${optText}"`, 'info');
  simulateClick(actionOption);
  await sleep(1500);

  const dialogAppeared = await waitForDialogAppear(4000);
  if (dialogAppeared) {
    await sleep(800);
    const confirmBtn = findConfirmButton();
    if (confirmBtn) {
      const cText = (confirmBtn.textContent || '').trim().substring(0, 30);
      addLog(`✅ Confirming action: "${cText}"`, 'info');
      simulateClick(confirmBtn);
      const closed = await waitForDialogClose();
      if (closed) {
        await incrementDeletedCount(1);
        playAudioChime('success');
        addLog(`🎉 Item #${deletedCount} successfully processed!`, 'success');
        processedRowKeys.add(rowKey);
        return true;
      } else {
        addLog('⚠ Confirmation dialog stuck. Closing...', 'warning');
        closeMenu();
        await sleep(1000);
        return false;
      }
    } else {
      addLog('⚠ Confirm button not located in dialog.', 'warning');
      closeMenu();
      return false;
    }
  } else {
    // Action took effect without requiring a confirmation dialog (e.g. untag/unreact)
    await incrementDeletedCount(1);
    playAudioChime('success');
    addLog(`🎉 Item #${deletedCount} processed directly!`, 'success');
    processedRowKeys.add(rowKey);
    return true;
  }
}

// --- Batch Mode ---
async function processBatchMode() {
  if (!isRunning || isPaused) return false;

  const { elements: checkboxes, type: cbType } = findCheckboxes();
  const unchecked = checkboxes.filter(cb => {
    if (cbType === 'input-checkbox') return !cb.checked;
    return cb.getAttribute('aria-checked') !== 'true';
  });

  scannedCount = checkboxes.length;
  broadcastState();

  if (unchecked.length === 0) {
    addLog('No checkboxes remaining. Falling back to One-by-One mode.', 'info');
    return await processIndividualMode();
  }

  addLog(`Found ${unchecked.length} items. Selecting up to 10...`, 'info');
  const batchSize = Math.min(unchecked.length, 10);
  let selected = 0;

  for (let i = 0; i < batchSize; i++) {
    if (!isRunning || isPaused) return false;
    simulateClick(unchecked[i]);
    selected++;
    await sleep(250 + Math.random() * 200);
  }

  addLog(`✔ Selected ${selected} item(s). Locating action button...`, 'info');
  await sleep(1200);

  const actionOption = findTargetActionOption();
  if (!actionOption) {
    addLog('⚠ Batch Action button not found. Deselecting checkboxes...', 'warning');
    for (let i = 0; i < batchSize; i++) {
      simulateClick(unchecked[i]);
      await sleep(150);
    }
    return false;
  }

  simulateClick(actionOption);
  await sleep(1500);

  const confirmBtn = findConfirmButton();
  if (confirmBtn) {
    simulateClick(confirmBtn);
    const closed = await waitForDialogClose();
    if (closed) {
      await incrementDeletedCount(selected);
      playAudioChime('success');
      addLog(`🎉 Batch of ${selected} items successfully processed!`, 'success');
      return true;
    }
    return false;
  }

  await incrementDeletedCount(selected);
  playAudioChime('success');
  addLog(`🎉 ${selected} items processed in batch mode!`, 'success');
  return true;
}

// --- Diagnostics ---
async function runDiagnostics() {
  addLog('━━━━━━━━ DIAGNOSTICS ━━━━━━━━', 'system');
  addLog('URL: ' + window.location.href, 'info');
  addLog('Lang: ' + document.documentElement.lang, 'info');
  const { label } = getActionKeywords();
  addLog(`Selected Target Action: ${label}`, 'system');

  const rows = findActivityRows();
  addLog(`Activity rows found: ${rows.length}`, rows.length > 0 ? 'success' : 'warning');
  rows.slice(0, 3).forEach((r, i) => {
    const aria = r.menuBtn.getAttribute('aria-label') || '(none)';
    const rect = r.menuBtn.getBoundingClientRect();
    const visible = rect.top >= 0 && rect.bottom <= window.innerHeight;
    addLog(`  Row#${i+1}: label="${aria.substring(0, 50)}" pos=(${Math.round(rect.left)},${Math.round(rect.top)}) ${visible ? '✅ visible' : '⚠ offscreen'}`, 'info');
  });

  const { elements: cbs, type: cbType } = findCheckboxes();
  addLog(`Checkboxes: ${cbs.length} (${cbType})`, cbs.length > 0 ? 'success' : 'warning');

  const blockedText = checkRateLimitBlock();
  addLog(`Rate Limit Status: ${blockedText ? '⚠️ BLOCKED (' + blockedText + ')' : '✅ Normal'}`, blockedText ? 'error' : 'success');

  addLog('━━━━ RECOMMENDATION ━━━━', 'system');
  if (rows.length > 0) {
    addLog('☝️ Use One-by-One mode → Click Start', 'success');
  } else if (cbs.length > 0) {
    addLog('📦 Use Batch mode → Click Start', 'success');
  } else {
    addLog('❌ No actionable items found. Try scrolling down or going to a specific category page.', 'error');
  }
  addLog('━━━━━━━━━━━━━━━━━━━━━━━━', 'system');
}
