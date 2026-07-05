const accountText = document.getElementById('accountText');
const signInButton = document.getElementById('signInButton');
const signOutButton = document.getElementById('signOutButton');
const authError = document.getElementById('authError');
const enableToggle = document.getElementById('enableToggle');
const receiverDot = document.getElementById('receiverDot');
const receiverStatus = document.getElementById('receiverStatus');
const receiverDetail = document.getElementById('receiverDetail');

let latestStatus = null;
let refreshTimer = null;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { success: false, error: 'No response from extension.' });
    });
  });
}

function setAuthError(message) {
  if (!message) {
    authError.textContent = '';
    authError.classList.add('hidden');
    return;
  }
  authError.textContent = message;
  authError.classList.remove('hidden');
}

function renderAccount(status) {
  const user = status?.user || null;
  const email = user?.email || user?.user_metadata?.email || '';
  if (status?.signedIn) {
    accountText.textContent = email ? `Signed in as ${email}` : 'Signed in';
    signInButton.classList.add('hidden');
    signOutButton.classList.remove('hidden');
    return;
  }

  accountText.textContent = 'Sign in to sync with Lectra.';
  signInButton.classList.remove('hidden');
  signOutButton.classList.add('hidden');
}

function renderReceiver(status) {
  const dropBridge = status?.dropBridge || {};
  receiverDot.className = 'dot';

  if (!status?.signedIn) {
    receiverDot.classList.add('warn');
    receiverStatus.textContent = 'Signed out';
    receiverDetail.textContent = 'Sign in to receive files from Lectra.';
    return;
  }

  if (!status?.enabled) {
    receiverDot.classList.add('warn');
    receiverStatus.textContent = 'Lectra tools are off';
    receiverDetail.textContent = 'Turn on Lectra tools to receive files.';
    return;
  }

  const health = String(dropBridge.health || dropBridge.status || '').toLowerCase();
  const label = dropBridge.label || dropBridge.status || dropBridge.receiverStatus || 'Receiver ready';
  const detail = dropBridge.detail || dropBridge.lastEventLabel || dropBridge.lastTransferStage || '';

  if (health.includes('error') || health.includes('failed')) {
    receiverDot.classList.add('error');
  } else if (health.includes('warn') || health.includes('disabled') || health.includes('signed')) {
    receiverDot.classList.add('warn');
  } else {
    receiverDot.classList.add('ready');
  }

  receiverStatus.textContent = label;
  receiverDetail.textContent = detail;
}

async function refreshStatus() {
  const status = await sendMessage({ type: 'getLectraStatus' });
  if (!status?.success) {
    receiverDot.className = 'dot error';
    receiverStatus.textContent = 'Status unavailable';
    receiverDetail.textContent = status?.error || 'Could not reach the service worker.';
    return;
  }

  latestStatus = status;
  enableToggle.checked = Boolean(status.enabled);
  renderAccount(status);
  renderReceiver(status);
}

async function setEnabled(enabled) {
  enableToggle.disabled = true;
  try {
    const current = await chrome.storage.local.get(['settings']);
    await chrome.storage.local.set({
      settings: {
        ...(current.settings || {}),
        enableSendToLectra: Boolean(enabled)
      }
    });
    if (enabled) {
      await sendMessage({ action: 'syncPdfViewerOverlayRegistration', reason: 'popup-toggle' });
      await sendMessage({ action: 'ensureDropBridgeReceiver', reason: 'popup-toggle' });
    }
    await refreshStatus();
  } finally {
    enableToggle.disabled = false;
  }
}

signInButton.addEventListener('click', async () => {
  setAuthError(null);
  signInButton.disabled = true;
  signInButton.textContent = 'Signing in...';
  const response = await sendMessage({ type: 'signInWithGoogle' });
  signInButton.disabled = false;
  signInButton.textContent = 'Sign in with Google';
  if (!response?.success) {
    setAuthError(response?.error || 'Sign-in failed.');
  }
  await refreshStatus();
});

signOutButton.addEventListener('click', async () => {
  setAuthError(null);
  signOutButton.disabled = true;
  const response = await sendMessage({ type: 'signOut' });
  signOutButton.disabled = false;
  if (!response?.success) {
    setAuthError(response?.error || 'Sign-out failed.');
  }
  await refreshStatus();
});

enableToggle.addEventListener('change', () => {
  setEnabled(enableToggle.checked).catch((error) => {
    setAuthError(error?.message || String(error));
    enableToggle.checked = Boolean(latestStatus?.enabled);
  });
});

refreshStatus();
refreshTimer = setInterval(refreshStatus, 5000);
window.addEventListener('unload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
