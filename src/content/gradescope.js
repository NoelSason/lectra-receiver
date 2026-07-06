/**
 * Gradescope — first consumer of the generic Attach-from-Lectra picker.
 *
 * Detects the "Upload Submission" modal (the dialog with a "Select File"
 * control + a file <input>) and injects a small "Select from Lectra" button
 * beside it. Picking a document downloads the annotated-else-original PDF and
 * fills Gradescope's hidden file input so the user just clicks Upload.
 *
 * Everything generic (picker UI, downloads, input filling) lives in
 * attach-from-lectra.js. This file is intentionally Gradescope-specific only.
 */
(function () {
  'use strict';

  const BTN_FLAG = 'data-lectra-lectra-btn';
  const HOST_FLAG = 'data-lectra-lectra-host';
  const ACTIVE_ATTR = 'data-lectra-receiver-active';
  const ACTIVE_EVENT = 'lectra-receiver:active';
  const CANVASCOPE_LECTRA_SELECTORS = [
    '[data-canvascope-lectra-btn]',
    '[data-canvascope-lectra-host]',
    '[data-canvascope-lectra-root]',
    '[data-canvascope-lectra-overlay]'
  ].join(',');
  const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
    enableSendToLectra: true
  });
  let extensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
  let suppressionObserver = null;

  function api() {
    return window.LectraAttach || null;
  }

  function normalizeExtensionSettings(rawSettings) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const hasExplicitSendSetting = Object.prototype.hasOwnProperty.call(source, 'enableSendToLectra');
    return {
      ...DEFAULT_EXTENSION_SETTINGS,
      ...source,
      enableSendToLectra: hasExplicitSendSetting
        ? Boolean(source.enableSendToLectra)
        : DEFAULT_EXTENSION_SETTINGS.enableSendToLectra
    };
  }

  function isLectraEnabled() {
    return Boolean(extensionSettings.enableSendToLectra);
  }

  function markLectraReceiverActive() {
    try {
      document.documentElement?.setAttribute(ACTIVE_ATTR, 'true');
      window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, {
        detail: {
          active: true,
          extensionId: chrome.runtime?.id || null
        }
      }));
    } catch (_) { /* ignore */ }
  }

  function clearLectraReceiverActive() {
    try {
      document.documentElement?.removeAttribute(ACTIVE_ATTR);
      window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, {
        detail: {
          active: false,
          extensionId: chrome.runtime?.id || null
        }
      }));
    } catch (_) { /* ignore */ }
  }

  function suppressCanvascopeLectraUi() {
    try {
      document.querySelectorAll(CANVASCOPE_LECTRA_SELECTORS).forEach((node) => {
        if (node.hasAttribute?.('data-canvascope-lectra-host')) {
          node.removeAttribute('data-canvascope-lectra-host');
        } else {
          node.remove();
        }
      });
    } catch (_) { /* ignore */ }
  }

  function installCanvascopeSuppression() {
    if (suppressionObserver) return;
    markLectraReceiverActive();
    suppressCanvascopeLectraUi();
    suppressionObserver = new MutationObserver(suppressCanvascopeLectraUi);
    const root = document.documentElement || document.body;
    if (root) {
      suppressionObserver.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-canvascope-lectra-btn', 'data-canvascope-lectra-host', 'data-canvascope-lectra-root', 'data-canvascope-lectra-overlay']
      });
    }
  }

  function uninstallCanvascopeSuppression() {
    suppressionObserver?.disconnect();
    suppressionObserver = null;
    clearLectraReceiverActive();
  }

  function removeButtons() {
    document.querySelectorAll(`[${BTN_FLAG}]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${HOST_FLAG}]`).forEach((node) => node.removeAttribute(HOST_FLAG));
  }

  function isVisible(el) {
    return Boolean(el && el.offsetParent !== null);
  }

  /**
   * Find visible "Select File" controls. Gradescope renders this as a button
   * or label that proxies to a hidden file input. We match on text rather than
   * a brittle class so we survive their markup churn.
   */
  function findSelectFileControls() {
    const candidates = document.querySelectorAll('button, a, label, span, .btn');
    const out = [];
    for (const node of candidates) {
      // Only leaf-ish controls — avoid matching a big container that happens
      // to contain the phrase. Gradescope labels this "Select PDF" (some
      // assignment types say "Select File"); never match the "Upload" button.
      const text = (node.textContent || '').trim();
      if (!/^(select|choose)\s+(pdf|file)$/i.test(text)) continue;
      if (!isVisible(node)) continue;
      out.push(node);
    }
    // The control is often a <button> wrapping a <span>/<label> with the same
    // text, so we match both. Keep only the outermost to avoid double buttons.
    return out.filter((node) => !out.some((other) => other !== node && other.contains(node)));
  }

  /** Locate the file input associated with a Select File control. */
  function findFileInputFor(control) {
    const scope =
      control.closest('form') ||
      control.closest('[role="dialog"]') ||
      control.closest('.tiptap, .modal, .panel') ||
      document;
    const inputs = scope.querySelectorAll('input[type="file"]');
    for (const input of inputs) {
      // Prefer a PDF-accepting input; otherwise take the first.
      const accept = (input.getAttribute('accept') || '').toLowerCase();
      if (!accept || accept.includes('pdf') || accept.includes('application')) {
        return input;
      }
    }
    return inputs[0] || null;
  }

  function buildButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(BTN_FLAG, 'true');
    btn.textContent = 'Select from Lectra';
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'margin-left:8px', 'padding:6px 12px',
      'border:1px solid #2d7d8a', 'border-radius:6px',
      'background:#2d7d8a', 'color:#ffffff',
      'font-size:13px', 'font-weight:600', 'line-height:1.2',
      'cursor:pointer', 'vertical-align:middle', 'font-family:inherit'
    ].join(';');
    return btn;
  }

  function setBtnState(btn, text, disabled) {
    btn.textContent = text;
    btn.disabled = Boolean(disabled);
    btn.style.opacity = disabled ? '0.7' : '1';
    btn.style.cursor = disabled ? 'default' : 'pointer';
  }

  async function onClick(btn, control) {
    const lectra = api();
    if (!lectra) {
      setBtnState(btn, 'Picker unavailable', true);
      setTimeout(() => setBtnState(btn, 'Select from Lectra', false), 2000);
      return;
    }

    const input = findFileInputFor(control);
    if (!input) {
      setBtnState(btn, 'No file field found', true);
      setTimeout(() => setBtnState(btn, 'Select from Lectra', false), 2000);
      return;
    }

    let doc;
    try {
      doc = await lectra.openPicker();
    } catch (e) {
      setBtnState(btn, 'Picker error', true);
      setTimeout(() => setBtnState(btn, 'Select from Lectra', false), 2000);
      return;
    }
    if (!doc) return; // cancelled

    setBtnState(btn, 'Loading…', true);
    try {
      const file = await lectra.downloadDocumentAsFile(doc);
      const ok = lectra.fillFileInput(input, file);
      if (ok) {
        setBtnState(btn, '✓ ' + (doc.title || 'PDF') + ' ready', false);
        setTimeout(() => setBtnState(btn, 'Select from Lectra', false), 3000);
      } else {
        setBtnState(btn, 'Could not attach', true);
        setTimeout(() => setBtnState(btn, 'Select from Lectra', false), 2500);
      }
    } catch (e) {
      console.warn('[Lectra][Gradescope] attach failed', e);
      setBtnState(btn, (e?.message || 'Failed').slice(0, 40), true);
      setTimeout(() => setBtnState(btn, 'Select from Lectra', false), 3000);
    }
  }

  function injectButtons() {
    if (!isLectraEnabled()) {
      removeButtons();
      uninstallCanvascopeSuppression();
      return;
    }
    installCanvascopeSuppression();

    const controls = findSelectFileControls();
    for (const control of controls) {
      // Anchor on the control's parent so duplicates are easy to detect.
      const anchor = control.parentElement || control;
      if (anchor.querySelector(`[${BTN_FLAG}]`)) continue;
      if (anchor.hasAttribute(HOST_FLAG)) continue;
      anchor.setAttribute(HOST_FLAG, 'true');

      const btn = buildButton();
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(btn, control);
      });
      control.insertAdjacentElement('afterend', btn);
    }
  }

  // The Upload Submission modal is injected dynamically (Gradescope is an SPA),
  // so watch the DOM and (re)inject as modals appear.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try { injectButtons(); } catch (_) { /* ignore */ }
    }, 150);
  };

  const observer = new MutationObserver(schedule);
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();
    });
  }

  try {
    chrome.storage.local.get(['settings']).then((data) => {
      extensionSettings = normalizeExtensionSettings(data.settings);
      schedule();
    });
  } catch (_) {
    removeButtons();
  }

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.settings) return;
      extensionSettings = normalizeExtensionSettings(changes.settings.newValue);
      if (isLectraEnabled()) {
        schedule();
      } else {
        removeButtons();
      }
    });
  } catch (_) { /* ignore */ }
})();
