/**
 * Attach from Lectra — generic, page-agnostic picker.
 *
 * Exposes window.LectraAttach with three primitives that any
 * surface (Gradescope, and future "attach an assignment" flows) can compose:
 *
 *   openPicker()                  -> Promise<doc|null>   (shadow-DOM overlay)
 *   downloadDocumentAsFile(doc)   -> Promise<File>        (annotated-else-original)
 *   fillFileInput(inputEl, file)  -> boolean              (DataTransfer assign)
 *
 * All Lectra/Supabase access is routed through the background service worker
 * (it holds the auth session). This module never touches Supabase directly.
 * It must NOT contain any consumer-specific (e.g. Gradescope) logic.
 */
(function () {
  'use strict';

  if (window.LectraAttach) return;

  const NS = 'lectra-attach';
  // Inline SVG markup (not a data: URI) so it renders under strict page CSP.
  const PLACEHOLDER_SVG =
    `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#9aa3b2" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  let pdfWorkerConfigured = false;

  function configurePdfWorker() {
    if (pdfWorkerConfigured) return Boolean(window.pdfjsLib);
    if (!window.pdfjsLib) return false;
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL('src/lib/pdf.worker.min.js');
      pdfWorkerConfigured = true;
    } catch (_) {
      return false;
    }
    return true;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, message: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { success: false, message: 'No response' });
        });
      } catch (e) {
        resolve({ success: false, message: e?.message || String(e) });
      }
    });
  }

  // ---- Background-backed data access ---------------------------------------

  async function listDocuments() {
    const res = await sendMessage({ action: 'listLectraDocuments' });
    if (!res?.success) {
      throw new Error(res?.message || 'Could not load your Lectra documents.');
    }
    return {
      documents: Array.isArray(res.documents) ? res.documents : [],
      currentIpadDocId: res.currentIpadDocId || null
    };
  }

  async function resolveSignedUrl(doc) {
    const res = await sendMessage({
      action: 'fetchLectraDocumentBytes',
      documentId: doc.id
    });
    if (!res?.success || !res.signedUrl) {
      throw new Error(res?.message || 'Could not open this document.');
    }
    return { signedUrl: res.signedUrl, filename: res.filename || `${doc.title || 'lectra'}.pdf` };
  }

  async function downloadDocumentAsFile(doc) {
    const { signedUrl, filename } = await resolveSignedUrl(doc);
    const response = await fetch(signedUrl);
    if (!response.ok) {
      throw new Error(`Download failed (${response.status}).`);
    }
    const blob = await response.blob();
    const safeName = /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
    return new File([blob], safeName, { type: 'application/pdf' });
  }

  // ---- Generic file-input filler -------------------------------------------

  function fillFileInput(inputEl, file) {
    if (!inputEl || inputEl.tagName !== 'INPUT' || inputEl.type !== 'file') return false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      inputEl.files = dt.files;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      return inputEl.files.length === 1;
    } catch (e) {
      console.warn('[Lectra][AttachFromLectra] fillFileInput failed', e);
      return false;
    }
  }

  // ---- Thumbnails (lazy) ----------------------------------------------------
  // Rendered directly onto a <canvas>, which is exempt from page img-src CSP.
  // Lazy per-visible-row; first page only.

  async function renderThumbnailToCanvas(doc, canvas) {
    if (!configurePdfWorker()) return false;

    const { signedUrl } = await resolveSignedUrl(doc);
    const response = await fetch(signedUrl);
    if (!response.ok) return false;
    const buffer = await response.arrayBuffer();

    const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
    try {
      const page = await pdf.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = 80; // 2x of the 40px display box for crispness
      const scale = targetWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      return true;
    } finally {
      void pdf.destroy();
    }
  }

  // ---- Picker overlay (shadow DOM) -----------------------------------------

  const OVERLAY_CSS = `
    :host { all: initial; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483000;
      background: rgba(15, 23, 36, 0.45);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .panel {
      width: 420px; max-width: calc(100vw - 32px); max-height: 70vh;
      background: #ffffff; border-radius: 12px; overflow: hidden;
      box-shadow: 0 24px 60px rgba(0,0,0,0.32);
      display: flex; flex-direction: column;
    }
    .head {
      padding: 14px 16px; border-bottom: 1px solid #e7eaf0;
      display: flex; align-items: center; gap: 8px;
    }
    .head h2 { margin: 0; font-size: 15px; font-weight: 700; color: #1c2330; flex: 1; }
    .head button {
      border: none; background: transparent; cursor: pointer;
      color: #6b7280; font-size: 18px; line-height: 1; padding: 4px;
    }
    .search { padding: 10px 16px; border-bottom: 1px solid #eef1f5; }
    .search input {
      width: 100%; box-sizing: border-box; padding: 8px 10px;
      border: 1px solid #d6dbe3; border-radius: 8px; font-size: 13px; color: #1c2330;
    }
    .search input:focus { outline: none; border-color: #2d7d8a; box-shadow: 0 0 0 3px rgba(45,125,138,0.15); }
    .body { overflow-y: auto; flex: 1; padding: 6px; }
    .row {
      display: flex; align-items: center; gap: 12px; padding: 8px 10px;
      border-radius: 8px; cursor: pointer; border: 1px solid transparent;
    }
    .row:hover, .row:focus { background: #f1f6f7; border-color: #d7e6e8; outline: none; }
    .row.pinned { background: #eef9f1; border-color: #bfe6cb; }
    .thumb {
      width: 40px; height: 52px; border-radius: 4px; overflow: hidden;
      background: #f3f5f8; border: 1px solid #e3e7ee; flex: 0 0 auto;
      display: flex; align-items: center; justify-content: center;
    }
    .thumb canvas { width: 100%; height: 100%; object-fit: cover; display: block; }
    .meta { min-width: 0; flex: 1; }
    .title { font-size: 13px; font-weight: 600; color: #1c2330; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 11.5px; color: #6b7280; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge { display: inline-block; font-size: 10px; font-weight: 700; color: #1d7a4c; background: #d8f3e2; border-radius: 4px; padding: 1px 6px; margin-left: 6px; }
    .pin-badge { display: inline-block; font-size: 10px; font-weight: 700; color: #b25c00; background: #ffe9cc; border-radius: 4px; padding: 1px 6px; margin-left: 6px; }
    .state { padding: 28px 16px; text-align: center; color: #6b7280; font-size: 13px; }
    .state.error { color: #b42318; }
    .spinner { width: 18px; height: 18px; border: 2px solid #d6dbe3; border-top-color: #2d7d8a; border-radius: 50%; animation: spin 0.7s linear infinite; margin: 0 auto 10px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  function openPicker() {
    return new Promise((resolve) => {
      // Tear down any prior instance.
      document.getElementById(NS)?.remove();

      const host = document.createElement('div');
      host.id = NS;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = OVERLAY_CSS;
      shadow.appendChild(style);

      const backdrop = document.createElement('div');
      backdrop.className = 'backdrop';
      backdrop.innerHTML = `
        <div class="panel" role="dialog" aria-modal="true" aria-label="Select from Lectra">
          <div class="head">
            <h2>Select from Lectra</h2>
            <button data-close aria-label="Close">&times;</button>
          </div>
          <div class="search"><input type="text" placeholder="Search your Lectra documents…" autocomplete="off" /></div>
          <div class="body"><div class="state"><div class="spinner"></div>Loading your Lectra documents…</div></div>
        </div>`;
      shadow.appendChild(backdrop);
      document.body.appendChild(host);

      const panel = backdrop.querySelector('.panel');
      const bodyEl = backdrop.querySelector('.body');
      const searchInput = backdrop.querySelector('.search input');

      let settled = false;
      let allDocs = [];
      const thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const thumb = entry.target;
          thumbObserver.unobserve(thumb);
          const doc = thumb.__doc;
          if (!doc) continue;
          const canvas = document.createElement('canvas');
          renderThumbnailToCanvas(doc, canvas)
            .then((ok) => { if (ok) { thumb.innerHTML = ''; thumb.appendChild(canvas); } })
            .catch(() => { /* keep placeholder icon */ });
        }
      }, { root: bodyEl, rootMargin: '120px' });

      const cleanup = () => {
        thumbObserver.disconnect();
        document.removeEventListener('keydown', onKey, true);
        host.remove();
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
      };
      document.addEventListener('keydown', onKey, true);
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(null); });
      backdrop.querySelector('[data-close]').addEventListener('click', () => finish(null));

      const renderList = (docs, currentIpadDocId) => {
        bodyEl.innerHTML = '';
        if (!docs.length) {
          bodyEl.innerHTML = '<div class="state">No documents in your Lectra library yet.</div>';
          return;
        }
        for (const doc of docs) {
          const row = document.createElement('div');
          row.className = 'row' + (doc.id === currentIpadDocId ? ' pinned' : '');
          row.tabIndex = 0;
          row.setAttribute('role', 'button');

          const thumb = document.createElement('div');
          thumb.className = 'thumb';
          thumb.innerHTML = PLACEHOLDER_SVG;
          thumb.__doc = doc;
          thumbObserver.observe(thumb);

          const meta = document.createElement('div');
          meta.className = 'meta';
          const title = document.createElement('div');
          title.className = 'title';
          title.textContent = doc.title || 'Untitled PDF';
          if (doc.id === currentIpadDocId) {
            const pin = document.createElement('span');
            pin.className = 'pin-badge';
            pin.textContent = 'Open on iPad';
            title.appendChild(pin);
          } else if (doc.hasAnnotated) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = 'Annotated';
            title.appendChild(badge);
          }
          const sub = document.createElement('div');
          sub.className = 'sub';
          sub.textContent = doc.course || 'No course';
          meta.appendChild(title);
          meta.appendChild(sub);

          row.appendChild(thumb);
          row.appendChild(meta);
          const pick = () => finish(doc);
          row.addEventListener('click', pick);
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
          });
          bodyEl.appendChild(row);
        }
      };

      let currentIpadDocId = null;
      const applyFilter = () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = !q
          ? allDocs
          : allDocs.filter((d) =>
              (d.title || '').toLowerCase().includes(q) ||
              (d.course || '').toLowerCase().includes(q));
        renderList(filtered, currentIpadDocId);
      };
      searchInput.addEventListener('input', applyFilter);

      listDocuments()
        .then(({ documents, currentIpadDocId: pinId }) => {
          if (settled) return;
          currentIpadDocId = pinId;
          // Pinned (currently open on iPad) doc floats to the top.
          allDocs = documents.slice().sort((a, b) => {
            if (a.id === pinId) return -1;
            if (b.id === pinId) return 1;
            return 0;
          });
          applyFilter();
          searchInput.focus();
        })
        .catch((err) => {
          if (settled) return;
          bodyEl.innerHTML = `<div class="state error">${(err?.message || 'Could not load documents.').replace(/</g, '&lt;')}</div>`;
        });

      // Keep the panel from swallowing clicks meant for the host page beneath.
      panel.addEventListener('mousedown', (e) => e.stopPropagation());
    });
  }

  window.LectraAttach = {
    openPicker,
    downloadDocumentAsFile,
    fillFileInput
  };
})();
