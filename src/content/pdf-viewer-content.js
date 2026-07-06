(() => {
    const initKey = '__lectraPdfViewerOverlayInitialized';
    const DEBUG = false;
    const VIEWER_CHANGE_DEBOUNCE_MS = 40;
    const ACTIVE_ATTR = 'data-lectra-receiver-active';
    const ACTIVE_EVENT = 'lectra-receiver:active';
    const CANVASCOPE_LECTRA_SELECTORS = [
        '#canvascope-send-to-lectra-btn',
        '[data-canvascope-lectra-btn]',
        '[data-canvascope-lectra-host]',
        '[data-canvascope-lectra-root]',
        '[data-canvascope-lectra-overlay]'
    ].join(',');

    function debug(message, details = undefined) {
        if (!DEBUG) return;
        const prefix = '[Lectra PDF Viewer][Content]';
        if (details === undefined) {
            console.log(prefix, message);
            return;
        }
        console.log(prefix, message, details);
    }

    if (globalThis[initKey]) {
        debug('Skipping init because overlay script already ran once');
        return;
    }
    globalThis[initKey] = true;
    debug('Overlay script booted', {
        href: window.location.href,
        title: document.title
    });

    const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
        enableSendToLectra: true
    });
    const BUTTON_POSITION_STORAGE_KEY = 'lectraSendButtonPositions';
    const BUTTON_POSITION_SLOT = 'pdfViewer';
    const BUTTON_HOLD_TO_DRAG_MS = 350;
    const BUTTON_DRAG_CANCEL_DISTANCE_PX = 12;
    const BUTTON_DEFAULT_RIGHT_PX = 20;
    const BUTTON_DEFAULT_BOTTOM_PX = 96;
    const BUTTON_EDGE_PADDING_PX = 12;
    const BUTTON_DEFAULT_TRANSITION = 'transform 0.15s ease, opacity 0.2s ease';

    let viewerExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
    let overlayContext = null;
    let sendButton = null;
    let sendButtonBusy = false;
    let refreshTimer = null;
    let viewerChangeTimer = null;
    let sendButtonPosition = null;
    let sendButtonDragState = null;
    let suppressNextSendButtonClick = false;
    let latestOverlayRequestId = 0;
    let latestViewerKey = '';
    let navigationHooksInstalled = false;
    let suppressionObserver = null;

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

    function isSendToLectraEnabled() {
        return Boolean(viewerExtensionSettings.enableSendToLectra);
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
        } catch {
            // Ignore page teardown races.
        }
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
        } catch {
            // Ignore page teardown races.
        }
    }

    function suppressCanvascopeLectraUi() {
        try {
            document.querySelectorAll(CANVASCOPE_LECTRA_SELECTORS).forEach((node) => {
                if (node.id === 'canvascope-send-to-lectra-btn') {
                    node.remove();
                    return;
                }
                if (node.hasAttribute?.('data-canvascope-lectra-host')) {
                    node.removeAttribute('data-canvascope-lectra-host');
                    return;
                }
                node.remove();
            });
        } catch {
            // Keep ownership best-effort so host page mutations never break Lectra.
        }
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
                attributeFilter: ['id', 'data-canvascope-lectra-btn', 'data-canvascope-lectra-host', 'data-canvascope-lectra-root', 'data-canvascope-lectra-overlay']
            });
        }
    }

    function uninstallCanvascopeSuppression() {
        suppressionObserver?.disconnect();
        suppressionObserver = null;
        clearLectraReceiverActive();
    }

    function decodePossiblyEncodedUrl(value) {
        let decoded = String(value || '');
        for (let i = 0; i < 3; i += 1) {
            try {
                const next = decodeURIComponent(decoded);
                if (next === decoded) break;
                decoded = next;
            } catch {
                break;
            }
        }
        return decoded;
    }

    function isPdfSupportedProtocol(protocol) {
        return protocol === 'https:' || protocol === 'http:' || protocol === 'file:';
    }

    function normalizePdfCandidateUrl(rawUrl, baseUrl = window.location.href) {
        if (!rawUrl) return null;
        try {
            const parsed = new URL(String(rawUrl), baseUrl || undefined);
            if (!isPdfSupportedProtocol(parsed.protocol)) return null;
            parsed.hash = '';
            return parsed.toString();
        } catch {
            return null;
        }
    }

    function cleanTitleHint(title) {
        return String(title || '').replace(/\s+/g, ' ').trim();
    }

    function isGenericPdfTitleHint(title) {
        const cleaned = cleanTitleHint(title);
        if (!cleaned) return true;

        const lowered = cleaned.toLowerCase();
        if (lowered === 'file' || lowered === 'files') return true;
        if (lowered === 'file preview' || lowered === 'preview') return true;
        if (lowered === 'document' || lowered === 'pdf') return true;
        if (lowered === 'download' || lowered === 'open file') return true;
        return lowered === 'canvas';
    }

    function normalizeDocumentTitleForPdf(rawTitle) {
        const cleaned = cleanTitleHint(rawTitle);
        if (!cleaned) return '';

        const explicitPdf = cleaned.match(/([^|]+?\.pdf)\b/i);
        if (explicitPdf?.[1]) {
            return cleanTitleHint(explicitPdf[1]);
        }

        return cleanTitleHint(
            cleaned
                .replace(/\s+[|:-]\s*(instructure|canvas)(?:\s+files?)?.*$/i, '')
                .replace(/\s+-\s+files?$/i, '')
        );
    }

    function resolvePdfTitleHint() {
        const selectors = [
            '.ef-name-col__text',
            '.ef-name-col .ellipsible',
            '.file-header h1',
            '.ef-header h1',
            '[data-testid="file-name"]',
            'h1'
        ];

        for (const selector of selectors) {
            const nodes = document.querySelectorAll(selector);
            for (const node of nodes) {
                const candidate = normalizeDocumentTitleForPdf(node?.textContent || '');
                if (!isGenericPdfTitleHint(candidate)) {
                    return candidate;
                }
            }
        }

        const docTitle = normalizeDocumentTitleForPdf(document.title || '');
        if (!isGenericPdfTitleHint(docTitle)) {
            return docTitle;
        }

        return '';
    }

    function getViewerSrcFromLocation() {
        try {
            const parsed = new URL(window.location.href);
            const src = parsed.searchParams.get('src');
            if (!src) return null;
            return normalizePdfCandidateUrl(decodePossiblyEncodedUrl(src), window.location.href);
        } catch {
            return null;
        }
    }

    function getEmbeddedPdfSources() {
        const sources = [];
        const seen = new Set();
        const addSource = (rawUrl) => {
            const normalized = normalizePdfCandidateUrl(rawUrl, window.location.href);
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            sources.push(normalized);
        };

        document.querySelectorAll('embed[src], object[data], iframe[src]').forEach((element) => {
            addSource(element.getAttribute('src') || element.getAttribute('data'));
        });

        return sources.sort();
    }

    function buildViewerKey() {
        const parts = [window.location.href];
        const locationSrc = getViewerSrcFromLocation();
        if (locationSrc) {
            parts.push(`src:${locationSrc}`);
        }
        for (const embeddedSrc of getEmbeddedPdfSources()) {
            parts.push(`embed:${embeddedSrc}`);
        }
        if (String(document.contentType || '').toLowerCase().includes('application/pdf')) {
            parts.push('content-type:application/pdf');
        }
        return parts.join('|');
    }

    function normalizeStoredButtonPosition(rawValue) {
        if (!rawValue || typeof rawValue !== 'object') return null;
        const left = Number(rawValue.left);
        const top = Number(rawValue.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) {
            return null;
        }
        return {
            left: Math.round(left),
            top: Math.round(top)
        };
    }

    function clampButtonPosition(position, button = sendButton) {
        if (!position || !button) return null;
        const rect = button.getBoundingClientRect();
        const maxLeft = Math.max(BUTTON_EDGE_PADDING_PX, window.innerWidth - rect.width - BUTTON_EDGE_PADDING_PX);
        const maxTop = Math.max(BUTTON_EDGE_PADDING_PX, window.innerHeight - rect.height - BUTTON_EDGE_PADDING_PX);
        return {
            left: Math.min(Math.max(BUTTON_EDGE_PADDING_PX, Math.round(position.left)), Math.round(maxLeft)),
            top: Math.min(Math.max(BUTTON_EDGE_PADDING_PX, Math.round(position.top)), Math.round(maxTop))
        };
    }

    function applySendButtonPosition(button = sendButton) {
        if (!button) return;

        if (!sendButtonPosition) {
            button.style.left = 'auto';
            button.style.top = 'auto';
            button.style.right = `${BUTTON_DEFAULT_RIGHT_PX}px`;
            button.style.bottom = `${BUTTON_DEFAULT_BOTTOM_PX}px`;
            return;
        }

        const clamped = clampButtonPosition(sendButtonPosition, button);
        if (!clamped) return;
        sendButtonPosition = clamped;
        button.style.left = `${clamped.left}px`;
        button.style.top = `${clamped.top}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
    }

    async function persistSendButtonPosition(position) {
        try {
            const stored = await chrome.storage.local.get([BUTTON_POSITION_STORAGE_KEY]);
            const positions = stored?.[BUTTON_POSITION_STORAGE_KEY] && typeof stored[BUTTON_POSITION_STORAGE_KEY] === 'object'
                ? { ...stored[BUTTON_POSITION_STORAGE_KEY] }
                : {};
            positions[BUTTON_POSITION_SLOT] = position;
            await chrome.storage.local.set({ [BUTTON_POSITION_STORAGE_KEY]: positions });
            debug('Persisted button position', position);
        } catch (error) {
            debug('Failed to persist button position', error?.message || 'unknown');
        }
    }

    function clearPendingDragHold() {
        if (sendButtonDragState?.holdTimer) {
            clearTimeout(sendButtonDragState.holdTimer);
            sendButtonDragState.holdTimer = null;
        }
    }

    function beginSendButtonDrag() {
        if (!sendButton || !sendButtonDragState || sendButtonBusy) return;

        const rect = sendButton.getBoundingClientRect();
        sendButtonDragState.dragging = true;
        sendButtonDragState.startLeft = rect.left;
        sendButtonDragState.startTop = rect.top;
        suppressNextSendButtonClick = true;

        sendButton.style.transition = 'none';
        sendButton.style.transform = 'translateY(0)';
        sendButton.style.cursor = 'grabbing';
        sendButton.style.left = `${Math.round(rect.left)}px`;
        sendButton.style.top = `${Math.round(rect.top)}px`;
        sendButton.style.right = 'auto';
        sendButton.style.bottom = 'auto';
        document.documentElement.style.userSelect = 'none';
        debug('Button drag started', {
            left: rect.left,
            top: rect.top
        });
    }

    function finishSendButtonDrag({ persist = true } = {}) {
        if (!sendButtonDragState) return;
        clearPendingDragHold();

        if (sendButton && sendButtonDragState.dragging) {
            const finalPosition = clampButtonPosition({
                left: sendButtonDragState.currentLeft,
                top: sendButtonDragState.currentTop
            }, sendButton);
            if (finalPosition) {
                sendButtonPosition = finalPosition;
                applySendButtonPosition(sendButton);
                if (persist) {
                    void persistSendButtonPosition(finalPosition);
                }
            }
            sendButton.style.transition = BUTTON_DEFAULT_TRANSITION;
            sendButton.style.cursor = sendButtonBusy ? 'default' : 'pointer';
        }

        document.documentElement.style.userSelect = '';
        sendButtonDragState = null;
    }

    function handleSendButtonPointerDown(event) {
        if (!sendButton || sendButtonBusy) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        const rect = sendButton.getBoundingClientRect();
        sendButtonDragState = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
            currentLeft: rect.left,
            currentTop: rect.top,
            dragging: false,
            holdTimer: null
        };

        sendButtonDragState.holdTimer = setTimeout(() => {
            beginSendButtonDrag();
        }, BUTTON_HOLD_TO_DRAG_MS);

        try {
            sendButton.setPointerCapture(event.pointerId);
        } catch {
            // Ignore browsers that reject pointer capture for this element.
        }
    }

    function handleSendButtonPointerMove(event) {
        if (!sendButton || !sendButtonDragState || sendButtonDragState.pointerId !== event.pointerId) {
            return;
        }

        const deltaX = event.clientX - sendButtonDragState.startClientX;
        const deltaY = event.clientY - sendButtonDragState.startClientY;
        if (!sendButtonDragState.dragging) {
            if (Math.hypot(deltaX, deltaY) > BUTTON_DRAG_CANCEL_DISTANCE_PX) {
                clearPendingDragHold();
            }
            return;
        }

        event.preventDefault();
        const nextPosition = clampButtonPosition({
            left: sendButtonDragState.startLeft + deltaX,
            top: sendButtonDragState.startTop + deltaY
        }, sendButton);
        if (!nextPosition) return;
        sendButtonDragState.currentLeft = nextPosition.left;
        sendButtonDragState.currentTop = nextPosition.top;
        sendButton.style.left = `${nextPosition.left}px`;
        sendButton.style.top = `${nextPosition.top}px`;
    }

    function handleSendButtonPointerEnd(event) {
        if (!sendButtonDragState || sendButtonDragState.pointerId !== event.pointerId) {
            return;
        }

        if (sendButtonDragState.dragging) {
            event.preventDefault();
        }

        try {
            sendButton?.releasePointerCapture?.(event.pointerId);
        } catch {
            // Ignore pointer-capture cleanup failures.
        }

        finishSendButtonDrag({ persist: true });
    }

    function ensureSendButton() {
        if (sendButton && sendButton.isConnected) {
            return sendButton;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'lectra-send-to-lectra-btn';
        button.innerHTML = `
            <span class="cs-lectra-reticle" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                    <circle cx="8" cy="8" r="4.2" stroke="currentColor" stroke-width="1.4"/>
                    <line x1="8" y1="1.5" x2="8" y2="3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                    <line x1="8" y1="12.5" x2="8" y2="14.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                    <line x1="1.5" y1="8" x2="3.5" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                    <line x1="12.5" y1="8" x2="14.5" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                    <circle cx="8" cy="8" r="1" fill="currentColor"/>
                </svg>
            </span>
            <span class="cs-lectra-label">Send to Lectra</span>
        `;
        button.style.cssText = `
            position: fixed;
            right: 20px;
            bottom: 96px;
            z-index: 2147483000;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 9px 14px 9px 12px;
            border-radius: 999px;
            border: 1px solid rgba(239, 68, 68, 0.55);
            background: #ef4444;
            color: #fff;
            font: 600 13px/1 'SF Pro Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
            letter-spacing: 0.01em;
            box-shadow:
                0 0 0 1px rgba(255, 255, 255, 0.06) inset,
                0 8px 28px rgba(220, 38, 38, 0.42),
                0 0 0 4px rgba(239, 68, 68, 0.14);
            cursor: pointer;
            transition: ${BUTTON_DEFAULT_TRANSITION};
            touch-action: none;
            -webkit-font-smoothing: antialiased;
        `;
        button.title = 'Send to Lectra. Press and hold to move.';
        button.addEventListener('mouseenter', () => {
            if (!sendButtonBusy && !sendButtonDragState?.dragging) {
                button.style.transform = 'translateY(-1px)';
            }
        });
        button.addEventListener('mouseleave', () => {
            if (!sendButtonDragState?.dragging) {
                button.style.transform = 'translateY(0)';
            }
        });
        button.addEventListener('pointerdown', handleSendButtonPointerDown);
        button.addEventListener('pointermove', handleSendButtonPointerMove);
        button.addEventListener('pointerup', handleSendButtonPointerEnd);
        button.addEventListener('pointercancel', handleSendButtonPointerEnd);
        button.addEventListener('click', handleSendButtonClick);

        (document.body || document.documentElement).appendChild(button);
        sendButton = button;
        applySendButtonPosition(button);
        debug('Created floating Send to Lectra button');
        return button;
    }

    function removeSendButton() {
        if (sendButton && sendButton.parentNode) {
            sendButton.parentNode.removeChild(sendButton);
            debug('Removed floating Send to Lectra button');
        }
        clearPendingDragHold();
        document.documentElement.style.userSelect = '';
        sendButton = null;
        sendButtonBusy = false;
        sendButtonDragState = null;
    }

    function setSendButtonState(text, state = 'idle') {
        const button = ensureSendButton();
        const label = button.querySelector('.cs-lectra-label');
        if (label) {
            label.textContent = text;
        } else {
            button.textContent = text;
        }

        if (state === 'sending') {
            sendButtonBusy = true;
            button.disabled = true;
            button.style.opacity = '0.85';
            button.style.cursor = 'default';
            return;
        }

        sendButtonBusy = false;
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';

        if (state === 'success') {
            // Lock-acquired green — matches in-popup signal-go
            button.style.background = '#10b981';
            button.style.borderColor = 'rgba(52, 211, 153, 0.6)';
            button.style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.08) inset, 0 8px 28px rgba(16, 185, 129, 0.42), 0 0 0 4px rgba(52, 211, 153, 0.14)';
            return;
        }

        if (state === 'error') {
            button.style.background = '#b91c1c';
            button.style.borderColor = 'rgba(248, 113, 113, 0.7)';
            button.style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.08) inset, 0 8px 28px rgba(185, 28, 28, 0.5), 0 0 0 4px rgba(248, 113, 113, 0.16)';
            return;
        }

        button.style.background = '#ef4444';
        button.style.borderColor = 'rgba(239, 68, 68, 0.55)';
        button.style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.06) inset, 0 8px 28px rgba(220, 38, 38, 0.42), 0 0 0 4px rgba(239, 68, 68, 0.14)';
    }

    function collectPdfCandidates() {
        const candidates = [];
        const seen = new Set();
        const addCandidate = (rawUrl, source, hintConfidence = 'weak') => {
            const normalized = normalizePdfCandidateUrl(rawUrl, window.location.href);
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            candidates.push({ url: normalized, source, hintConfidence });
        };

        const viewerSrc = getViewerSrcFromLocation();
        if (viewerSrc) {
            addCandidate(viewerSrc, 'viewer_src', 'strong');
        }

        document.querySelectorAll('embed[src], object[data], iframe[src]').forEach((element) => {
            const rawUrl = element.getAttribute('src') || element.getAttribute('data');
            const typeAttr = String(element.getAttribute('type') || '').toLowerCase();
            const looksLikeFileRoute = String(rawUrl || '').includes('/files/') || String(rawUrl || '').includes('/download');
            const hintConfidence = typeAttr.includes('pdf') ? 'definitive' : (looksLikeFileRoute ? 'strong' : 'weak');
            addCandidate(rawUrl, `${element.tagName.toLowerCase()}_embed`, hintConfidence);
        });

        document.querySelectorAll('a[href]').forEach((link) => {
            const rawHref = link.getAttribute('href');
            if (!rawHref) return;
            const linkText = `${link.textContent || ''} ${link.getAttribute('title') || ''}`.toLowerCase();
            const classText = String(link.className || '').toLowerCase();
            const hasPdfHint = linkText.includes('pdf') || classText.includes('pdf');
            if (hasPdfHint || rawHref.includes('/files/') || rawHref.includes('/download')) {
                addCandidate(rawHref, 'file_link', hasPdfHint ? 'strong' : 'weak');
            }
        });

        if (String(document.contentType || '').toLowerCase().includes('application/pdf')) {
            addCandidate(window.location.href, 'document_content_type', 'strong');
        }

        return {
            success: true,
            pageUrl: window.location.href,
            titleHint: resolvePdfTitleHint(),
            candidates
        };
    }

    function resolveStrongLocalPdfContext() {
        const candidatePayload = collectPdfCandidates();
        const strongCandidate = candidatePayload.candidates.find((candidate) => {
            const confidence = String(candidate?.hintConfidence || '').toLowerCase();
            if (confidence === 'strong' || confidence === 'definitive') return true;
            return /\.pdf(?:$|[?#])/i.test(candidate?.url || '');
        });
        if (!strongCandidate) return null;
        return {
            success: true,
            showButton: true,
            candidateUrl: strongCandidate.url,
            sourcePageUrl: candidatePayload.pageUrl || window.location.href,
            titleHint: candidatePayload.titleHint || document.title || '',
            reason: `local_${strongCandidate.source || 'pdf_hint'}`
        };
    }

    function clearOverlayState(reason) {
        overlayContext = null;
        latestOverlayRequestId += 1;
        removeSendButton();
        if (!isSendToLectraEnabled()) {
            uninstallCanvascopeSuppression();
        }
        debug('Cleared overlay state', { reason });
    }

    function scheduleOverlayRefresh(delayMs = 0) {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        debug('Scheduling overlay refresh', { delayMs });
        refreshTimer = setTimeout(refreshOverlayContext, delayMs);
    }

    function handleViewerContextChange(reason, { force = false } = {}) {
        const nextViewerKey = buildViewerKey();
        if (!force && nextViewerKey === latestViewerKey) {
            return false;
        }

        latestViewerKey = nextViewerKey;
        clearOverlayState(`viewer_change:${reason}`);
        scheduleOverlayRefresh(VIEWER_CHANGE_DEBOUNCE_MS);
        debug('Detected viewer context change', {
            reason,
            viewerKey: nextViewerKey
        });
        return true;
    }

    function scheduleViewerChangeCheck(delayMs = VIEWER_CHANGE_DEBOUNCE_MS) {
        if (viewerChangeTimer) {
            clearTimeout(viewerChangeTimer);
        }
        viewerChangeTimer = setTimeout(() => {
            viewerChangeTimer = null;
            handleViewerContextChange('navigation');
        }, delayMs);
    }

    function refreshOverlayContext() {
        const requestId = ++latestOverlayRequestId;
        latestViewerKey = buildViewerKey();
        debug('Refreshing overlay context', {
            enabled: isSendToLectraEnabled(),
            href: window.location.href,
            viewerKey: latestViewerKey,
            requestId
        });
        if (!isSendToLectraEnabled()) {
            overlayContext = null;
            removeSendButton();
            uninstallCanvascopeSuppression();
            debug('Overlay disabled by settings');
            return;
        }

        installCanvascopeSuppression();
        const localContext = resolveStrongLocalPdfContext();
        if (localContext?.candidateUrl) {
            overlayContext = localContext;
            setSendButtonState('Send to Lectra', 'idle');
            debug('Showing button from local strong PDF context', localContext);
        }

        chrome.runtime.sendMessage({ action: 'resolvePdfViewerOverlayContext' }, (response) => {
            if (requestId !== latestOverlayRequestId) {
                debug('Ignoring stale overlay response', {
                    requestId,
                    latestOverlayRequestId
                });
                return;
            }

            if (chrome.runtime.lastError) {
                debug('resolvePdfViewerOverlayContext runtime error', chrome.runtime.lastError.message || 'unknown');
                if (!localContext?.candidateUrl) {
                    overlayContext = null;
                    removeSendButton();
                }
                return;
            }

            overlayContext = response || null;
            debug('resolvePdfViewerOverlayContext response', overlayContext);
            if (!response?.showButton || !response?.candidateUrl) {
                if (!localContext?.candidateUrl) {
                    removeSendButton();
                } else {
                    overlayContext = localContext;
                }
                debug('Not showing button because resolver did not approve this tab');
                return;
            }

            setSendButtonState('Send to Lectra', 'idle');
            debug('Button should now be visible', {
                candidateUrl: response.candidateUrl,
                sourcePageUrl: response.sourcePageUrl
            });
        });
    }

    function handleSendButtonClick() {
        if (suppressNextSendButtonClick) {
            suppressNextSendButtonClick = false;
            debug('Suppressing click after button drag');
            return;
        }
        debug('Floating button clicked', {
            busy: sendButtonBusy,
            candidateUrl: overlayContext?.candidateUrl || null
        });
        if (sendButtonBusy) return;
        if (!isSendToLectraEnabled()) {
            removeSendButton();
            return;
        }

        if (!overlayContext?.candidateUrl) {
            handleViewerContextChange('send_without_context', { force: true });
            return;
        }

        setSendButtonState('Sending…', 'sending');
        chrome.runtime.sendMessage({
            action: 'sendPdfToLectra',
            trigger: 'pdf_viewer_overlay',
            candidateUrl: overlayContext.candidateUrl,
            sourcePageUrl: overlayContext.sourcePageUrl || window.location.href,
            titleHint: overlayContext.titleHint || document.title || ''
        }, (response) => {
            if (chrome.runtime.lastError) {
                debug('sendPdfToLectra runtime error', chrome.runtime.lastError.message || 'unknown');
                setSendButtonState('Failed', 'error');
                const runtimeMessage = chrome.runtime.lastError.message || 'Send failed.';
                if (runtimeMessage) {
                    window.alert(runtimeMessage);
                }
                setTimeout(() => {
                    if (sendButton) {
                        setSendButtonState('Send to Lectra', 'idle');
                    }
                }, 1800);
                return;
            }

            debug('sendPdfToLectra response', response);
            if (response?.success) {
                setSendButtonState('Sent ✓', 'success');
                setTimeout(() => {
                    if (sendButton) {
                        setSendButtonState('Send to Lectra', 'idle');
                    }
                }, 1800);
                return;
            }

            setSendButtonState('Failed', 'error');
            if (response?.message) {
                window.alert(String(response.message));
            }
            setTimeout(() => {
                if (sendButton) {
                    setSendButtonState('Send to Lectra', 'idle');
                }
            }, 2200);
        });
    }

    function installNavigationHooks() {
        if (navigationHooksInstalled) return;
        navigationHooksInstalled = true;

        const schedule = () => scheduleViewerChangeCheck(VIEWER_CHANGE_DEBOUNCE_MS);
        window.addEventListener('popstate', schedule);
        window.addEventListener('hashchange', schedule);

        ['pushState', 'replaceState'].forEach((method) => {
            const original = history[method];
            if (typeof original !== 'function') return;
            history[method] = function wrappedHistoryState(...args) {
                const result = original.apply(this, args);
                schedule();
                return result;
            };
        });

        const observer = new MutationObserver(() => {
            schedule();
        });
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'data', 'href']
        });
    }

    installNavigationHooks();
    latestViewerKey = buildViewerKey();

    try {
        chrome.storage.local.get(['settings', BUTTON_POSITION_STORAGE_KEY]).then((data) => {
            viewerExtensionSettings = normalizeExtensionSettings(data.settings);
            sendButtonPosition = normalizeStoredButtonPosition(data?.[BUTTON_POSITION_STORAGE_KEY]?.[BUTTON_POSITION_SLOT]);
            debug('Loaded settings from storage', {
                settings: viewerExtensionSettings,
                buttonPosition: sendButtonPosition
            });
            handleViewerContextChange('boot', { force: true });
            setTimeout(() => scheduleOverlayRefresh(0), 160);
            setTimeout(() => scheduleOverlayRefresh(0), 900);
        });
    } catch {
        debug('Storage.get failed during boot, refreshing anyway');
        handleViewerContextChange('boot-storage-failed', { force: true });
    }

    try {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;

            if (changes.settings) {
                viewerExtensionSettings = normalizeExtensionSettings(changes.settings.newValue);
                debug('Observed settings change', viewerExtensionSettings);
                if (!isSendToLectraEnabled()) {
                    overlayContext = null;
                    removeSendButton();
                    return;
                }
                handleViewerContextChange('settings-change', { force: true });
            }

            if (changes[BUTTON_POSITION_STORAGE_KEY]) {
                sendButtonPosition = normalizeStoredButtonPosition(
                    changes[BUTTON_POSITION_STORAGE_KEY]?.newValue?.[BUTTON_POSITION_SLOT]
                );
                debug('Observed button position change', sendButtonPosition);
                if (sendButton && sendButton.isConnected) {
                    applySendButtonPosition(sendButton);
                }
            }
        });
    } catch {
        // Storage access can fail on teardown. Ignore and keep the current button state.
    }

    window.addEventListener('pageshow', () => handleViewerContextChange('pageshow', { force: true }));
    window.addEventListener('resize', () => {
        if (sendButton && sendButton.isConnected && sendButtonPosition) {
            applySendButtonPosition(sendButton);
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            debug('Document became visible again, refreshing');
            handleViewerContextChange('visibilitychange', { force: true });
        }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action === 'collectPdfCandidates') {
            sendResponse(collectPdfCandidates());
            return true;
        }

        if (message?.action !== 'lectraPdfViewerDebugPing') {
            return false;
        }

        const payload = {
            success: true,
            href: window.location.href,
            title: document.title,
            viewerKey: latestViewerKey,
            sendButtonPresent: Boolean(sendButton && sendButton.isConnected),
            overlayContext,
            settings: viewerExtensionSettings
        };
        debug('Received debug ping', payload);
        sendResponse(payload);
        return true;
    });
})();
