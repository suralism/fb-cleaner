// ============================================================
// FB Activity Cleaner - Content Script (v2.2)
// Strategy: Find "View" buttons first, then locate the "..." 
// button next to each "View" as the sibling/adjacent element.
// ============================================================

// --- State Variables ---
let isRunning = false;
let isPaused = false;
let deletedCount = 0;
let scannedCount = 0;
let currentLogs = [];
let settings = { delay: 3000, mode: 'individual' };
let scrollAttempts = 0;
let loopTimeoutId = null;
let processedRowKeys = new Set(); // Track unique row text keys we already tried to prevent skipping due to DOM recycling
let rowAttempts = new Map(); // Track attempts per row key to prevent infinite loops

// --- Helpers ---

function addLog(text, logType = 'info') {
  const logEntry = { text, type: logType, time: new Date().toLocaleTimeString() };
  currentLogs.push(logEntry);
  if (currentLogs.length > 100) currentLogs.shift();
  chrome.runtime.sendMessage({ type: 'log', text, logType }).catch(() => {});
}

function broadcastState() {
  const state = isPaused ? 'paused' : (isRunning ? 'running' : 'idle');
  chrome.runtime.sendMessage({ type: 'state_update', state, deletedCount, scannedCount }).catch(() => {});
}

const sleep = (ms) => new Promise(resolve => {
  loopTimeoutId = setTimeout(resolve, ms);
});

// --- Click Simulation ---
// Scroll element into view, then dispatch a full pointer/mouse event chain.
// NOTE: We do NOT call el.click() in addition to dispatched events —
// doing both causes React to see two clicks which can toggle menus closed.
function simulateClick(el) {
  if (!el) return;

  // Scroll element into viewport center
  el.scrollIntoView({ behavior: 'instant', block: 'center' });

  // Recompute rect AFTER scrollIntoView
  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  // Find the actual topmost element at the center coordinates (e.g. the text span inside the button)
  // This is critical because React click handlers often check event.target or event.path
  // and expect the click to originate from the innermost child (just like a real user click).
  let targetEl = document.elementFromPoint(x, y) || el;

  // SAFETY CHECK: If elementFromPoint returns a backdrop, dialog wrapper, or transparent overlay 
  // that is outside our intended element, fall back to the element itself or its innermost text child.
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

  // Full event chain for React on the target element
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

  // Native click fallback on both the target and the original element
  try {
    targetEl.click();
  } catch (e) {}
  if (targetEl !== el) {
    try {
      el.click();
    } catch (e) {}
  }
}

// Fallback click — used only when the full event chain fails
function fallbackClick(el) {
  if (!el) return;
  try { el.click(); } catch (e) {}
}

// ============================================================
// KEY STRATEGY: Find "..." buttons directly via aria-label
// ============================================================
// From diagnostics, the "..." buttons have:
//   aria-label="More options for ..." (EN)
//   aria-label="ตัวเลือกเพิ่มเติมสำหรับ ..." (TH)
// This is much more reliable than searching through "View" text.
// ============================================================

// Helper to uniquely identify a row's content.
// Since Facebook uses virtual lists (recycling DOM elements), storing DOM references in WeakSet
// causes shifting elements to be skipped. Storing a content-based text key is 100% robust.
function getRowKey(rowContainer) {
  if (!rowContainer) return '';
  // Extract visible text, remove excessive whitespaces, and use it as a signature
  return (rowContainer.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 500);
}

function findActivityRows() {
  const results = [];

  // Strategy 1 (Primary): Find buttons by aria-label containing "More options" / "ตัวเลือกเพิ่มเติม"
  const allButtons = document.querySelectorAll('[role="button"]');

  for (const btn of allButtons) {
    const aria = (btn.getAttribute('aria-label') || '');
    const ariaLower = aria.toLowerCase();

    // Match "More options" (EN) or Thai equivalents
    const isMoreOptions = ariaLower.startsWith('more options') ||
                          ariaLower.includes('ตัวเลือกเพิ่มเติม') ||
                          ariaLower.includes('การดำเนินการเพิ่มเติม');

    if (!isMoreOptions) continue;

    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    // Walk up to find the parent row container
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
      label: aria,
      key: rowKey
    });
  }

  // Strategy 2 (Fallback): Find small icon-only buttons with SVG
  // This catches buttons that don't have a descriptive aria-label
  if (results.length === 0) {
    for (const btn of allButtons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width > 50 || rect.height > 50) continue; // Must be small

      const btnText = (btn.textContent || '').trim();
      const hasIcon = btn.querySelector('svg') !== null;
      const isIconOnly = btnText.length <= 3 || btnText === '';

      if (!hasIcon || !isIconOnly) continue;

      // Walk up to find row container
      let rowContainer = btn.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!rowContainer) break;
        const r = rowContainer.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.4) break;
        rowContainer = rowContainer.parentElement;
      }

      const rowKey = getRowKey(rowContainer);
      if (!rowContainer || !rowKey || processedRowKeys.has(rowKey)) continue;

      // Make sure this row looks like an activity row (has some text content)
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

// ============================================================
// Find "Move to trash" in opened dropdown
// ============================================================
// IMPORTANT: Only search within dropdown menu containers and popup
// overlay layers. Never search the entire page — that would match
// sidebar navigation links (e.g. "ถังขยะ") and navigate away.
// ============================================================
function findMoveToTrashOption() {
  const trashKeywordsExact = [
    'move to trash', 'move to bin',
    'ย้ายไปที่ถังขยะ', 'ย้ายไปยังถังขยะ', 'ย้ายลงถังขยะ'
  ];
  const trashKeywordsPartial = [
    'trash', 'delete', 'remove', 'ถังขยะ', 'ลบ', 'ลบออก', 'นำออก'
  ];

  addLog('🔍 Searching for "Move to trash" button in dropdown...', 'info');

  // --- Strategy 1: Look inside [role="menu"] / [role="listbox"] ---
  const menuContainers = document.querySelectorAll('[role="menu"], [role="listbox"]');
  addLog(`  Strategy 1: Found ${menuContainers.length} menu container(s)`, 'info');
  for (const menu of menuContainers) {
    const items = menu.querySelectorAll('[role="menuitem"], [role="option"], [role="button"], span, div');
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const text = (item.textContent || '').trim().toLowerCase();
      const aria = (item.getAttribute('aria-label') || '').trim().toLowerCase();
      
      // Exact match first
      for (const kw of trashKeywordsExact) {
        if (text === kw || aria === kw) {
          addLog(`   🎯 Found exact match (Strategy 1): "${text}"`, 'success');
          return item;
        }
      }
      // Partial match (within menu only — safe)
      for (const kw of trashKeywordsPartial) {
        if ((text.includes(kw) && text.length < 60) || aria.includes(kw)) {
          addLog(`   🎯 Found partial match (Strategy 1): "${text}"`, 'success');
          return item;
        }
      }
    }
  }

  // --- Strategy 2: Look for [role="menuitem"] anywhere (they only exist in menus) ---
  const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"]');
  addLog(`  Strategy 2: Found ${menuItems.length} menu items on page`, 'info');
  for (const item of menuItems) {
    const rect = item.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = (item.textContent || '').trim().toLowerCase();
    const aria = (item.getAttribute('aria-label') || '').trim().toLowerCase();
    
    for (const kw of trashKeywordsExact) {
      if (text.includes(kw) || aria.includes(kw)) {
        addLog(`   🎯 Found exact match (Strategy 2): "${text}"`, 'success');
        return item;
      }
    }
    for (const kw of trashKeywordsPartial) {
      if ((text.includes(kw) && text.length < 60) || aria.includes(kw)) {
        addLog(`   🎯 Found partial match (Strategy 2): "${text}"`, 'success');
        return item;
      }
    }
  }

  // --- Strategy 3: Search inside popup overlay layers only ---
  // Facebook renders popups in special overlay layers near the end of <body>
  // Look for recently-appeared floating elements (not main content)
  const overlayContainers = document.querySelectorAll(
    '[data-pagelet*="Popover"], [data-pagelet*="popover"], ' +
    '[class*="uiContextualLayer"], [class*="__fb-light-mode"] > div:last-child'
  );
  for (const container of overlayContainers) {
    const items = container.querySelectorAll('[role="button"], span, div');
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width > 350) continue; // Skip if too wide (not a menu item)
      const text = (item.textContent || '').trim().toLowerCase();
      for (const kw of trashKeywordsExact) {
        if (text === kw) return item;
      }
    }
  }

  // --- Strategy 4: Look for floating/detached popup elements near end of body ---
  // Facebook popups are often the last few children of <body>
  const bodyChildren = document.body.children;
  for (let i = bodyChildren.length - 1; i >= Math.max(0, bodyChildren.length - 5); i--) {
    const layer = bodyChildren[i];
    // Skip the main content container (usually the first child)
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
        if (text === kw) return item;
      }
      // Only allow short partial match for safety
      for (const kw of trashKeywordsPartial) {
        if (text === kw || (text.includes(kw) && text.length < 30)) return item;
      }
    }
  }

  return null;
}

function findConfirmButton() {
  // Find search root (dialog container if exists, otherwise document.body)
  let searchRoot = document.querySelector('[role="dialog"]');
  if (!searchRoot) {
    // Find dialog by searching for a container that has both Cancel and Move to Trash text
    const divs = document.querySelectorAll('div');
    for (const div of divs) {
      const rect = div.getBoundingClientRect();
      if (rect.width > 250 && rect.width < 650 && rect.height > 100 && rect.height < 450) {
        const text = div.textContent || '';
        const hasCancel = text.includes('Cancel') || text.includes('ยกเลิก');
        const hasTrash = text.includes('Move to Trash') || text.includes('ย้ายไปที่ถังขยะ') || text.includes('Move to trash');
        if (hasCancel && hasTrash) {
          searchRoot = div;
          addLog('🎯 Found confirmation dialog container via dimensions & buttons', 'success');
          break;
        }
      }
    }
  }

  if (!searchRoot) {
    searchRoot = document.body;
    addLog('⚠ Dialog container not isolated. Searching entire page for confirm button...', 'warning');
  }

  const confirmKeywords = [
    'move to trash', 'move to bin', 'trash', 'delete', 'confirm', 'yes', 'continue', 'done', 'ok',
    'ย้ายไปที่ถังขยะ', 'ย้ายไปยังถังขยะ', 'ถังขยะ', 'ลบ', 'ยืนยัน', 'ตกลง', 'เสร็จ'
  ];

  addLog('🔍 Searching for confirm button inside dialog...', 'info');

  // Strategy 1: Look for role="button" or native <button>
  const btns = searchRoot.querySelectorAll('[role="button"], button');
  const matches = [];
  for (const btn of btns) {
    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = (btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
    for (const kw of confirmKeywords) {
      if (text.includes(kw.toLowerCase()) || aria.includes(kw.toLowerCase())) {
        // Prioritize exact/strong matches
        if (text === 'move to trash' || text === 'ย้ายไปที่ถังขยะ') {
          addLog(`   🎯 Found exact confirm button (Strategy 1): "${btn.textContent.trim()}"`, 'success');
          return btn;
        }
        matches.push(btn);
        break;
      }
    }
  }

  if (matches.length > 0) {
    return matches[matches.length - 1];
  }

  // Strategy 2: Fallback to scanning spans and divs that contain the text directly
  const textEls = searchRoot.querySelectorAll('span, div, [role="link"], a');
  for (const el of textEls) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.width > 200 || rect.height > 80) continue; // Skip large layouts

    const text = (el.textContent || '').trim().toLowerCase();
    for (const kw of ['move to trash', 'move to bin', 'ย้ายไปที่ถังขยะ', 'ย้ายไปยังถังขยะ', 'ลบ', 'ยืนยัน']) {
      if (text === kw) {
        // Walk up to find the closest clickable parent (up to 3 levels)
        let clickable = el;
        for (let i = 0; i < 3; i++) {
          if (clickable.parentElement && (
              clickable.parentElement.getAttribute('role') === 'button' ||
              clickable.parentElement.tagName === 'BUTTON' ||
              clickable.parentElement.classList.contains('x1lliihq')
          )) {
            clickable = clickable.parentElement;
            break;
          }
        }
        addLog(`   🎯 Found confirm element (Strategy 2): "${el.textContent.trim()}"`, 'success');
        return clickable;
      }
    }
  }

  return null;
}

async function waitForDialogAppear(maxWaitMs = 4000) {
  const interval = 300;
  const max = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < max; i++) {
    // 1. Standard dialog element check
    if (document.querySelector('[role="dialog"]')) return true;

    // 2. Text heuristics inside body
    const bodyText = document.body.textContent || '';
    if (bodyText.includes('Move to Trash?') || bodyText.includes('ย้ายไปที่ถังขยะใช่หรือไม่') || bodyText.includes('ย้ายลงถังขยะ?')) {
      return true;
    }

    // 3. Presence of Cancel and Move to Trash button combination
    const hasCancel = Array.from(document.querySelectorAll('span, div, button')).some(el => {
      const t = el.textContent.trim();
      return t === 'Cancel' || t === 'ยกเลิก';
    });
    const hasTrash = Array.from(document.querySelectorAll('span, div, button')).some(el => {
      const t = el.textContent.trim().toLowerCase();
      return t === 'move to trash' || t === 'ย้ายไปที่ถังขยะ';
    });

    if (hasCancel && hasTrash) return true;

    await sleep(interval);
  }
  return false;
}

// ============================================================
// Helpers
// ============================================================
async function waitForDialogClose(maxWaitMs = 8000) {
  const interval = 400;
  const max = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < max; i++) {
    if (!isRunning || isPaused) return false;
    await sleep(interval);
    
    // Check if dialog is closed using both role and button presence checks
    const dialogExists = document.querySelector('[role="dialog"]') !== null;
    const hasConfirmButtons = Array.from(document.querySelectorAll('span, div, button')).some(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const t = el.textContent.trim().toLowerCase();
      return t === 'move to trash' || t === 'ย้ายไปที่ถังขยะ';
    });

    if (!dialogExists && !hasConfirmButtons) return true;
  }
  return false;
}

async function waitForMenuAppear(maxWaitMs = 3000) {
  const interval = 300;
  const max = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < max; i++) {
    await sleep(interval);
    if (document.querySelectorAll('[role="menu"], [role="listbox"]').length > 0) return true;
    if (findMoveToTrashOption()) return true;
  }
  return false;
}

function closeMenu() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  setTimeout(() => document.body.click(), 200);
}

// Find checkboxes (for "Manage your posts" pages)
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

// ============================================================
// MESSAGE HANDLER
// ============================================================
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
      addLog('▶ Starting cleaning process...', 'info');
      addLog('URL: ' + window.location.href, 'system');

      // Auto-detect: if no checkboxes, force individual mode
      const { elements: cbs } = findCheckboxes();
      const rows = findActivityRows();
      addLog(`Scan: ${cbs.length} checkboxes, ${rows.length} activity rows with menus`, 'info');
      if (settings.mode === 'batch' && cbs.length === 0 && rows.length > 0) {
        addLog('⚠ No checkboxes. Auto-switching to One-by-One.', 'warning');
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
    addLog('⏹ Stopped. Total deleted: ' + deletedCount, 'success');
    broadcastState();
    sendResponse({ success: true });
  }
  else if (message.action === 'update_settings') {
    settings = message.settings;
    addLog('⚙ Settings: Delay=' + (settings.delay / 1000) + 's, Mode=' + settings.mode, 'system');
    sendResponse({ success: true });
  }
  else if (message.action === 'query_state') {
    sendResponse({
      state: isPaused ? 'paused' : (isRunning ? 'running' : 'idle'),
      deletedCount, scannedCount, logs: currentLogs, settings
    });
  }
  else if (message.action === 'diagnose') {
    runDiagnostics();
    sendResponse({ success: true });
  }
  return true;
});

// ============================================================
// MAIN LOOP
// ============================================================
async function startLoop() {
  while (isRunning && !isPaused) {
    try {
      let result = false;

      if (settings.mode === 'batch') {
        result = await processBatchMode();
      } else {
        result = await processIndividualMode();
      }

      if (!result) {
        scrollAttempts++;
        if (scrollAttempts > 10) {
          addLog('⛔ No more items. Total deleted: ' + deletedCount, 'warning');
          isRunning = false;
          broadcastState();
          break;
        }
        addLog(`📜 Scrolling... (${scrollAttempts}/10)`, 'info');
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

// ============================================================
// INDIVIDUAL MODE - Using the "View" anchor strategy
// ============================================================
async function processIndividualMode() {
  if (!isRunning || isPaused) return false;

  // Find activity rows (each has a View button and a ... button)
  const rows = findActivityRows();
  scannedCount = rows.length;
  broadcastState();

  if (rows.length === 0) {
    addLog('No activity rows with menu buttons found.', 'info');
    return false;
  }

  addLog(`Found ${rows.length} activity row(s). Processing first one...`, 'info');

  const { row, menuBtn, key: rowKey } = rows[0];

  // Track attempts for this specific row key to avoid stuck infinite loops
  const attempts = rowAttempts.get(rowKey) || 0;
  if (attempts >= 2) {
    addLog('⚠ Row failed twice. Marking as processed (skipped) to prevent getting stuck.', 'warning');
    processedRowKeys.add(rowKey);
    return false;
  }
  rowAttempts.set(rowKey, attempts + 1);

  // Step 1: Click the "..." button
  const menuLabel = rows[0].label || menuBtn.getAttribute('aria-label') || '(icon)';
  addLog(`🔘 Clicking: "${menuLabel.substring(0, 50)}"`, 'info');
  
  // Scroll into view and wait for rendering
  menuBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
  await sleep(500);

  // Single click ONLY — do NOT double-click or it toggles the menu closed!
  simulateClick(menuBtn);

  // If the event chain didn't work, try fallback click after a short delay
  await sleep(300);
  const menuAlready = document.querySelectorAll('[role="menu"], [role="listbox"]').length > 0;
  if (!menuAlready) {
    addLog('  ↳ Retrying with fallback click...', 'info');
    fallbackClick(menuBtn);
  }

  // Step 2: Wait for dropdown menu
  const appeared = await waitForMenuAppear(3500);
  if (!appeared) {
    addLog('⚠ Dropdown did not appear. Skipping this item.', 'warning');
    closeMenu();
    await sleep(500);
    return false;
  }

  await sleep(600);

  // Step 3: Click "Move to trash"
  const trashOption = findMoveToTrashOption();
  if (!trashOption) {
    addLog('⚠ "Move to trash" not found in dropdown. Marking as processed (non-deletable) and closing menu.', 'warning');
    processedRowKeys.add(rowKey); // Skip it in future scans!
    closeMenu();
    await sleep(500);
    return false;
  }

  const optText = (trashOption.textContent || '').trim().substring(0, 40);
  addLog(`🗑 Clicking: "${optText}"`, 'info');
  simulateClick(trashOption);
  await sleep(1500);

  // Step 4: Handle confirmation dialog
  addLog('📋 Waiting for confirmation dialog...', 'info');
  const dialogAppeared = await waitForDialogAppear(4000);
  if (dialogAppeared) {
    addLog('📋 Dialog detected. Waiting for animation/fade-in to complete...', 'info');
    await sleep(800); // Critical: Wait for transition/fade-in animation to complete so listeners hydated
    const dialog = document.querySelector('[role="dialog"]');
    addLog('📋 Confirmation dialog ready. Locating confirm button...', 'info');
    const confirmBtn = findConfirmButton();
    if (confirmBtn) {
      const cText = (confirmBtn.textContent || '').trim().substring(0, 30);
      addLog(`✅ Confirming: "${cText}"`, 'info');
      simulateClick(confirmBtn);
      const closed = await waitForDialogClose();
      if (closed) {
        deletedCount++;
        addLog(`🎉 #${deletedCount} moved to trash!`, 'success');
        processedRowKeys.add(rowKey); // Successfully deleted, mark as processed!
        broadcastState();
        return true;
      } else {
        addLog('⚠ Dialog stuck. Trying Escape...', 'warning');
        closeMenu();
        await sleep(1000);
        return false;
      }
    } else {
      addLog('⚠ Confirm button not found.', 'warning');
      closeMenu();
      return false;
    }
  } else {
    // No dialog appeared within timeout
    addLog('⚠ No confirmation dialog appeared. Skipping item for safety.', 'warning');
    closeMenu();
    return false;
  }
}

// ============================================================
// BATCH MODE - For pages with checkboxes
// ============================================================
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
    addLog('No checkboxes. Falling back to One-by-One.', 'info');
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

  addLog(`✔ Selected ${selected}. Looking for Trash button...`, 'info');
  await sleep(1200);

  const trashOption = findMoveToTrashOption();
  if (!trashOption) {
    addLog('⚠ Trash button not found. Deselecting...', 'warning');
    for (let i = 0; i < batchSize; i++) {
      simulateClick(unchecked[i]);
      await sleep(150);
    }
    return false;
  }

  simulateClick(trashOption);
  await sleep(1500);

  const confirmBtn = findConfirmButton();
  if (confirmBtn) {
    simulateClick(confirmBtn);
    const closed = await waitForDialogClose();
    if (closed) {
      deletedCount += selected;
      addLog(`🎉 Batch of ${selected} deleted!`, 'success');
      broadcastState();
      return true;
    }
    return false;
  }

  deletedCount += selected;
  addLog(`🎉 ${selected} processed.`, 'success');
  broadcastState();
  return true;
}

// ============================================================
// DIAGNOSTICS
// ============================================================
async function runDiagnostics() {
  addLog('━━━━━━━━ DIAGNOSTICS ━━━━━━━━', 'system');
  addLog('URL: ' + window.location.href, 'info');
  addLog('Lang: ' + document.documentElement.lang, 'info');

  // 1. Activity rows (found via aria-label)
  const rows = findActivityRows();
  addLog(`Activity rows (More options buttons): ${rows.length}`, rows.length > 0 ? 'success' : 'warning');
  rows.slice(0, 3).forEach((r, i) => {
    const aria = r.menuBtn.getAttribute('aria-label') || '(none)';
    const rect = r.menuBtn.getBoundingClientRect();
    const visible = rect.top >= 0 && rect.bottom <= window.innerHeight;
    addLog(`  Row#${i+1}: label="${aria.substring(0, 50)}" pos=(${Math.round(rect.left)},${Math.round(rect.top)}) ${visible ? '✅ visible' : '⚠ offscreen'}`, 'info');
  });

  // 2. Count all "More options" buttons on the page (including off-screen)
  const moreOptionsBtns = Array.from(document.querySelectorAll('[role="button"]')).filter(btn => {
    const a = (btn.getAttribute('aria-label') || '').toLowerCase();
    return a.startsWith('more options') || a.includes('ตัวเลือกเพิ่มเติม');
  });
  const visibleOnes = moreOptionsBtns.filter(btn => {
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
  });
  addLog(`"More options" buttons: ${moreOptionsBtns.length} total, ${visibleOnes.length} visible`, 'info');

  // 3. Checkboxes
  const { elements: cbs, type: cbType } = findCheckboxes();
  addLog(`Checkboxes: ${cbs.length} (${cbType})`, cbs.length > 0 ? 'success' : 'warning');

  // 4. All unique aria-labels on [role="button"]
  const labels = new Set();
  document.querySelectorAll('[role="button"]').forEach(btn => {
    const l = btn.getAttribute('aria-label');
    if (l && l.length < 60) labels.add(l);
  });
  if (labels.size > 0) {
    addLog(`Unique button labels (${labels.size}):`, 'info');
    Array.from(labels).slice(0, 15).forEach(l => addLog(`  → "${l}"`, 'info'));
  }

  // 5. Check for open menus/popups
  const menus = document.querySelectorAll('[role="menu"], [role="listbox"]');
  addLog(`Open menus/listbox: ${menus.length}`, menus.length > 0 ? 'warning' : 'info');

  // Recommendation
  addLog('━━━━ RECOMMENDATION ━━━━', 'system');
  if (rows.length > 0) {
    addLog('☝️ Use One-by-One mode → Click Start', 'success');
  } else if (cbs.length > 0) {
    addLog('📦 Use Batch mode → Click Start', 'success');
  } else {
    addLog('❌ No actionable items. Scroll down or go to a category page.', 'error');
  }
  addLog('━━━━━━━━━━━━━━━━━━━━━━━━', 'system');
}
