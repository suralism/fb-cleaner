// DOM Elements
const badge = document.getElementById('status-badge');
const warningBanner = document.getElementById('page-warning');
const mainControls = document.getElementById('main-controls');
const countDeleted = document.getElementById('count-deleted');
const countTotal = document.getElementById('count-total');
const countScanned = document.getElementById('count-scanned');
const delaySlider = document.getElementById('delay-slider');
const delayVal = document.getElementById('delay-val');
const actionSelect = document.getElementById('action-select');
const radioModes = document.getElementsByName('delete-mode');
const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const logConsole = document.getElementById('log-console');
const btnClearLog = document.getElementById('btn-clear-log');
const btnDiagnose = document.getElementById('btn-diagnose');
const btnResetStats = document.getElementById('btn-reset-stats');

// Local variables
let currentTabId = null;

// Initialize Popup
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab) {
    showWarning();
    return;
  }
  
  currentTabId = tab.id;
  const url = tab.url || '';
  
  // Check if URL is Facebook Activity Log page (expanded matching)
  const isFbActivity = url.includes('facebook.com') && 
    (url.includes('allactivity') || url.includes('activity_log') || url.includes('activity_history') || 
     url.includes('your_facebook_information') || url.includes('your_activity'));
  
  if (!isFbActivity) {
    showWarning();
    return;
  }
  
  hideWarning();
  await loadSavedSettings();
  await syncTotalStats();
  queryContentScriptState();
});

// Event Listeners
delaySlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value).toFixed(1);
  delayVal.textContent = `${val}s`;
  saveSettings();
});

actionSelect.addEventListener('change', saveSettings);

radioModes.forEach(radio => {
  radio.addEventListener('change', saveSettings);
});

btnStart.addEventListener('click', () => {
  const settings = getSettings();
  sendMessageToContentScript({ action: 'start', settings });
});

btnPause.addEventListener('click', () => {
  sendMessageToContentScript({ action: 'pause' });
});

btnStop.addEventListener('click', () => {
  sendMessageToContentScript({ action: 'stop' });
});

btnClearLog.addEventListener('click', () => {
  logConsole.innerHTML = '';
  addLog('Console cleared', 'system');
});

btnDiagnose.addEventListener('click', () => {
  addLog('Requesting page diagnostics...', 'system');
  sendMessageToContentScript({ action: 'diagnose' });
});

btnResetStats.addEventListener('click', async () => {
  if (confirm('ต้องการล้างสถิติยอดลบสะสมทั้งหมด (All-Time Total) หรือไม่?')) {
    await chrome.storage.local.set({ totalDeletedAllTime: 0 });
    countTotal.textContent = '0';
    addLog('🧹 Stats reset to 0', 'system');
  }
});

// Helper Functions
function showWarning() {
  warningBanner.classList.remove('hidden');
  mainControls.classList.add('hidden');
  badge.className = 'badge idle';
  badge.textContent = 'Disconnected';
}

function hideWarning() {
  warningBanner.classList.add('hidden');
  mainControls.classList.remove('hidden');
}

function getSettings() {
  let selectedMode = 'batch';
  for (const radio of radioModes) {
    if (radio.checked) {
      selectedMode = radio.value;
      break;
    }
  }
  return {
    delay: parseFloat(delaySlider.value) * 1000,
    mode: selectedMode,
    targetAction: actionSelect.value || 'trash'
  };
}

async function saveSettings() {
  const settings = getSettings();
  await chrome.storage.local.set({ extensionSettings: settings });
  sendMessageToContentScript({ action: 'update_settings', settings });
}

async function loadSavedSettings() {
  const res = await chrome.storage.local.get('extensionSettings');
  if (res.extensionSettings) {
    const settings = res.extensionSettings;
    delaySlider.value = settings.delay / 1000;
    delayVal.textContent = `${(settings.delay / 1000).toFixed(1)}s`;
    if (settings.targetAction) {
      actionSelect.value = settings.targetAction;
    }
    for (const radio of radioModes) {
      radio.checked = (radio.value === settings.mode);
    }
  }
}

async function syncTotalStats() {
  const data = await chrome.storage.local.get('totalDeletedAllTime');
  countTotal.textContent = data.totalDeletedAllTime || 0;
}

function queryContentScriptState() {
  sendMessageToContentScript({ action: 'query_state' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      addLog('⚠ Content script not responding. Try refreshing the Facebook page.', 'warning');
      updateUIState('idle');
      return;
    }
    updateUIState(response.state);
    countDeleted.textContent = response.deletedCount || 0;
    countScanned.textContent = response.scannedCount || 0;
    if (response.totalDeletedAllTime !== undefined) {
      countTotal.textContent = response.totalDeletedAllTime;
    }
    if (response.logs && response.logs.length > 0) {
      logConsole.innerHTML = '';
      response.logs.forEach(l => addLog(l.text, l.type));
    }
  });
}

function sendMessageToContentScript(message, callback) {
  if (!currentTabId) return;
  chrome.tabs.sendMessage(currentTabId, message, (response) => {
    if (chrome.runtime.lastError) {
      if (callback) callback(null);
      return;
    }
    if (callback) callback(response);
  });
}

function updateUIState(state) {
  badge.className = `badge ${state}`;
  const stateLabels = { running: 'Running', paused: 'Paused', idle: 'Ready' };
  badge.textContent = stateLabels[state] || state;

  if (state === 'running') {
    btnStart.classList.add('hidden');
    btnPause.classList.remove('hidden');
    btnStop.classList.remove('hidden');
  } else if (state === 'paused') {
    btnStart.classList.remove('hidden');
    btnStart.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Resume`;
    btnPause.classList.add('hidden');
    btnStop.classList.remove('hidden');
  } else {
    btnStart.classList.remove('hidden');
    btnStart.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Start`;
    btnPause.classList.add('hidden');
    btnStop.classList.add('hidden');
  }
}

function addLog(text, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  line.textContent = `[${time}] ${text}`;
  logConsole.appendChild(line);
  logConsole.scrollTop = logConsole.scrollHeight;
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab && sender.tab.id !== currentTabId) return;

  if (message.type === 'state_update') {
    updateUIState(message.state);
    countDeleted.textContent = message.deletedCount || 0;
    countScanned.textContent = message.scannedCount || 0;
    if (message.totalDeletedAllTime !== undefined) {
      countTotal.textContent = message.totalDeletedAllTime;
    }
  } else if (message.type === 'log') {
    addLog(message.text, message.logType);
  }
});
