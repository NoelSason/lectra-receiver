/**
 * ============================================
 * Lectra Receiver — Background Service Worker
 * ============================================
 *
 * Standalone extension for the Lectra iPad workflow:
 *  - Send a PDF from any browser tab to your Lectra iPad
 *  - Receive files pushed back from the iPad (DropBridge V2 realtime receiver)
 *  - "Select from Lectra" picker on Gradescope upload forms
 *
 * Talks to the same Lectra backend (Supabase project + DropBridge V2 edge
 * functions + storage bucket) as the Lectra iPad app, so files sync with the
 * user's existing account. All Supabase auth lives in this service worker.
 *
 * Some internal protocol values (clientKind, senderKind, sourceKind,
 * storage-path prefix) intentionally keep their original identifiers so the
 * backend and iPad app recognize items produced by this extension.
 * ============================================
 */

// --- SUPABASE INITIALIZATION ---
const supabaseUrl = 'https://vcadcdgnwxjlgaoqktkd.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYWRjZGdud3hqbGdhb3FrdGtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MzU4NDQsImV4cCI6MjA4NzIxMTg0NH0.71j6kwkwwSeG9Jppu4IUyHORM033NFyXKemOd5kuDWk';
const LECTRA_DOCUMENTS_BUCKET = 'lectra_documents';
const supabaseLib = typeof window !== 'undefined' && window.supabase
    ? window.supabase
    : typeof supabase !== 'undefined' ? supabase : null;

const supabaseAuthStorage = {
    async getItem(key) {
        const data = await chrome.storage.local.get([key]);
        return data?.[key] ?? null;
    },
    async setItem(key, value) {
        await chrome.storage.local.set({ [key]: value });
    },
    async removeItem(key) {
        await chrome.storage.local.remove([key]);
    }
};

const supabaseClient = supabaseLib
    ? supabaseLib.createClient(supabaseUrl, supabaseKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            storage: supabaseAuthStorage
        }
    })
    : null;

if (!supabaseClient) {
    console.error('[Lectra] Supabase client failed to initialize (ensure lib/supabase.js is loaded)');
}

const AUTH_STATUS_SNAPSHOT_KEY = 'lectraAuthStatusSnapshot';

function buildAuthStatusUser(session) {
    if (!session?.user) return null;
    return {
        email: session.user.email,
        name: session.user.user_metadata?.full_name || session.user.user_metadata?.name || 'User',
        avatar_url: session.user.user_metadata?.avatar_url
    };
}

async function persistAuthStatusSnapshot(session) {
    const payload = session?.user
        ? {
            signedIn: true,
            user: buildAuthStatusUser(session),
            userId: session.user.id,
            updatedAt: Date.now()
        }
        : {
            signedIn: false,
            user: null,
            userId: null,
            updatedAt: Date.now()
        };

    try {
        await chrome.storage.local.set({ [AUTH_STATUS_SNAPSHOT_KEY]: payload });
    } catch (error) {
        console.warn('[Lectra Auth] Failed to persist auth snapshot:', parseErrorMessage(error));
    }
}

async function readAuthStatusSnapshot() {
    try {
        const data = await chrome.storage.local.get([AUTH_STATUS_SNAPSHOT_KEY]);
        const snapshot = data?.[AUTH_STATUS_SNAPSHOT_KEY];
        if (!snapshot || typeof snapshot !== 'object') return null;
        return snapshot;
    } catch (error) {
        console.warn('[Lectra Auth] Failed to read auth snapshot:', parseErrorMessage(error));
        return null;
    }
}

async function resolveAuthStatus() {
    if (!supabaseClient) {
        const snapshot = await readAuthStatusSnapshot();
        return snapshot?.signedIn
            ? { signedIn: true, user: snapshot.user || null, source: 'snapshot' }
            : { signedIn: false, source: 'none' };
    }

    try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error) {
            console.error('[Lectra Auth] Error checking session:', error);
        }

        if (session?.user) {
            await persistAuthStatusSnapshot(session);
            return {
                signedIn: true,
                user: buildAuthStatusUser(session),
                source: 'session'
            };
        }
    } catch (error) {
        console.error('[Lectra Auth] Unhandled session lookup error:', error);
    }

    const snapshot = await readAuthStatusSnapshot();
    if (snapshot?.signedIn && snapshot.user) {
        return {
            signedIn: true,
            user: snapshot.user,
            source: 'snapshot'
        };
    }

    await persistAuthStatusSnapshot(null);
    return { signedIn: false, source: 'none' };
}

if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((event, session) => {
        dropBridgeDebug('auth state change', {
            event,
            userId: session?.user?.id || null
        });

        persistAuthStatusSnapshot(session).catch((error) => {
            console.warn('[Lectra Auth] Failed to sync auth snapshot after state change:', parseErrorMessage(error));
        });

        if (event === 'SIGNED_OUT') {
            clearDropBridgeV2SessionCache();
            stopDropBridgeV2Loop();
            return;
        }

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            rememberDropBridgeV2Session(session);
            startDropBridgeV2Loop(`auth-${event.toLowerCase()}`).catch((error) => {
                console.error(`[DropBridge v2] Auth bootstrap failure (${event}):`, parseErrorMessage(error));
            });
        }
    });
}

// --- DROPBRIDGE V2 (ACCOUNT-LINKED, ZERO-PAIRING) ---
const DROPBRIDGE_V2_ENABLED = true;
const DROPBRIDGE_V2_DOWNLOAD_WATCHDOG_INTERVAL_MS = 15 * 1000;
const DROPBRIDGE_V2_DOWNLOAD_MAX_OBSERVE_MS = 30 * 60 * 1000;
const DROPBRIDGE_V2_STORAGE_DEVICE_ID = 'dropBridgeV2DeviceId';
const DROPBRIDGE_MODE_STORAGE_KEY = 'dropBridgeMode';
const DROPBRIDGE_V2_MODE = 'v2';
const DROPBRIDGE_V2_POLL_LIMIT = 5;
const DROPBRIDGE_V2_WAKE_EVENT = 'upload_queued';
const DROPBRIDGE_V2_WAKE_POLL_DEBOUNCE_MS = 1000;
const DROPBRIDGE_V2_RECEIVER_WARMUP_THROTTLE_MS = 15 * 1000;
const DROPBRIDGE_V2_RECEIVER_RESTART_THROTTLE_MS = 5 * 1000;
const DROPBRIDGE_V2_INTENTIONAL_CLOSE_GRACE_MS = 10 * 1000;
const DROPBRIDGE_V2_FALLBACK_ALARM_NAME = 'dropBridgeV2FallbackPoll';
const DROPBRIDGE_V2_HEARTBEAT_ALARM_NAME = 'dropBridgeV2Heartbeat';
const DROPBRIDGE_V2_HEARTBEAT_ALARM_MINUTES = 4;
const DROPBRIDGE_V2_FALLBACK_ALARM_MINUTES_MODERN = 2;
const DROPBRIDGE_V2_FALLBACK_ALARM_MINUTES_LEGACY = 2;
const DROPBRIDGE_V2_FALLBACK_ALARM_MIN_CHROME_MAJOR = 120;
const DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_PATH);
const DROPBRIDGE_V2_OFFSCREEN_JUSTIFICATION = 'Keep a hidden worker-backed receiver alive for the Lectra file delivery flow so queued files can trigger a browser download without opening a visible tab.';
const DROPBRIDGE_V2_DIAGNOSTICS_STORAGE_KEY = 'dropBridgeV2Diagnostics';
const DROPBRIDGE_V2_DIAGNOSTIC_EVENT_LIMIT = 25;
const DROPBRIDGE_V2_DEBUG = false; // enable only for local debugging
const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
    enableSendToLectra: false
});
const PDF_VIEWER_OVERLAY_CONTENT_SCRIPT_ID = 'lectraPdfViewerOverlay';
const PDF_VIEWER_OVERLAY_WEBSITE_ORIGINS = ['https://*/*', 'http://*/*'];
const PDF_VIEWER_OVERLAY_FILE_MATCH = 'file:///*';
const PDF_VIEWER_DEBUG = false; // enable only for local debugging
// The Gradescope picker owns Gradescope pages, so the "any PDF" send overlay
// excludes them (avoids two Lectra buttons on the same page).
const STATIC_LMS_CONTENT_SCRIPT_MATCHES = ['*://*.gradescope.com/*'];

let dropBridgeV2PollInFlight = false;
let dropBridgeV2QueuedPollReason = null;
let dropBridgeV2QueuedPollTimer = null;
let dropBridgeV2LastPollStartedAt = 0;
let dropBridgeV2EnsureOffscreenPromise = null;
let dropBridgeV2WarmupPromise = null;
let dropBridgeV2LastWarmupAt = 0;
let dropBridgeV2LastRestartAt = 0;
let dropBridgeV2IntentionalOffscreenCloseUntil = 0;
let dropBridgeV2DiagnosticsState = null;
let dropBridgeV2DiagnosticsWritePromise = Promise.resolve();
let dropBridgeV2CachedAccessToken = null;
let dropBridgeV2CachedAccessTokenExpiresAtMs = 0;
let dropBridgeV2CachedUserId = null;
let dropBridgeV2CachedDeviceId = null;
const dropBridgeV2ActiveUploads = new Set();
const dropBridgeV2TargetedClaimsInFlight = new Set();
const pdfSendInFlightKeys = new Set();

function normalizeExtensionSettings(rawSettings) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    return {
        ...DEFAULT_EXTENSION_SETTINGS,
        ...source,
        enableSendToLectra: Boolean(source.enableSendToLectra)
    };
}

async function getExtensionSettings() {
    const stored = await chrome.storage.local.get(['settings']);
    return normalizeExtensionSettings(stored.settings);
}

async function isSendToLectraFeatureEnabled() {
    const settings = await getExtensionSettings();
    return Boolean(settings.enableSendToLectra);
}

function getAllowedFileSchemeAccess() {
    return new Promise((resolve) => {
        chrome.extension.isAllowedFileSchemeAccess((isAllowed) => {
            resolve(Boolean(isAllowed));
        });
    });
}

function isGradescopeHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'gradescope.com' || host.endsWith('.gradescope.com');
}

function isTabUrlEligibleForPdfViewerOverlay(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'file:') return true;
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        return !isGradescopeHost(parsed.hostname);
    } catch {
        return false;
    }
}

function isUuid(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function generateUuidV4() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function detectBrowserName() {
    const ua = (navigator?.userAgent || '').toLowerCase();
    if (ua.includes('edg/')) return 'Edge';
    if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
    if (ua.includes('brave')) return 'Brave';
    if (ua.includes('arc/')) return 'Arc';
    if (ua.includes('chrome/')) return 'Chrome';
    if (ua.includes('firefox/')) return 'Firefox';
    if (ua.includes('safari/')) return 'Safari';
    return 'Browser';
}

function detectOsName() {
    const ua = (navigator?.userAgent || '').toLowerCase();
    if (ua.includes('mac os x')) return 'macOS';
    if (ua.includes('windows nt')) return 'Windows';
    if (ua.includes('android')) return 'Android';
    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS';
    if (ua.includes('cros')) return 'ChromeOS';
    if (ua.includes('linux')) return 'Linux';
    return 'UnknownOS';
}

function getDropBridgeV2DeviceName() {
    return `${detectBrowserName()} + ${detectOsName()}`.slice(0, 64);
}

function buildPdfStoragePath(userId, rowId, date = new Date()) {
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${userId}/lectra_documents/imported_from_canvascope/${year}/${month}/${rowId}.pdf`;
}

function sanitizeFilename(name) {
    const raw = String(name || 'lectra-file');
    const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').trim();
    return cleaned || `lectra-file-${Date.now()}`;
}

function isDropBridgeUserCanceled(reason) {
    const msg = String(reason || '').toUpperCase();
    return msg.includes('USER_CANCELED') || msg.includes('USER_CANCELLED') || msg.includes('CANCELED') || msg.includes('CANCELLED');
}

function parseErrorMessage(error) {
    if (!error) return 'Unknown error';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message) return error.message;
    return String(error);
}

function pdfViewerDebug(message, details = undefined) {
    if (!PDF_VIEWER_DEBUG) return;
    const prefix = '[Lectra PDF Viewer][BG]';
    if (details === undefined) {
        console.log(prefix, message);
        return;
    }
    console.log(prefix, message, details);
}

function summarizeDownloadUrl(downloadUrl) {
    if (!downloadUrl) return null;
    try {
        const url = new URL(downloadUrl);
        return {
            origin: url.origin,
            pathname: url.pathname
        };
    } catch (_) {
        return { raw: String(downloadUrl).slice(0, 200) };
    }
}

function sanitizeDropBridgePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    const copy = { ...payload };
    if (Array.isArray(copy.uploads)) {
        copy.uploads = copy.uploads.map((upload) => ({
            id: upload?.id || null,
            uploadId: upload?.uploadId || null,
            fileName: upload?.fileName || null,
            mimeType: upload?.mimeType || null,
            sizeBytes: upload?.sizeBytes ?? null,
            createdAt: upload?.createdAt || null,
            expiresAt: upload?.expiresAt || null,
            downloadUrl: summarizeDownloadUrl(upload?.downloadUrl)
        }));
    }

    return copy;
}

function dropBridgeDebug(message, details = undefined) {
    if (!DROPBRIDGE_V2_DEBUG) return;
    const timestamp = new Date().toISOString();
    if (details === undefined) {
        console.log(`[DropBridge v2][debug][${timestamp}] ${message}`);
        return;
    }
    console.log(`[DropBridge v2][debug][${timestamp}] ${message}`, details);
}

function clearDropBridgeV2SessionCache() {
    dropBridgeV2CachedAccessToken = null;
    dropBridgeV2CachedAccessTokenExpiresAtMs = 0;
    dropBridgeV2CachedUserId = null;
}

function rememberDropBridgeV2Session(session) {
    if (!session?.access_token) {
        clearDropBridgeV2SessionCache();
        return;
    }

    dropBridgeV2CachedAccessToken = session.access_token;
    dropBridgeV2CachedUserId = session?.user?.id || null;
    const expiresAtSeconds = Number(session.expires_at || 0);
    dropBridgeV2CachedAccessTokenExpiresAtMs = Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0
        ? expiresAtSeconds * 1000
        : Date.now() + (5 * 60 * 1000);
}

function getDropBridgeV2CachedAccessToken() {
    if (!dropBridgeV2CachedAccessToken) return null;
    if (dropBridgeV2CachedAccessTokenExpiresAtMs <= Date.now() + 30 * 1000) {
        return null;
    }
    return dropBridgeV2CachedAccessToken;
}

function getChromeMajorVersion(userAgent = navigator?.userAgent || '') {
    const match = String(userAgent).match(/Chrome\/(\d+)/i) || String(userAgent).match(/Chromium\/(\d+)/i);
    const major = Number(match?.[1] || 0);
    return Number.isFinite(major) ? major : 0;
}

function getDropBridgeV2FallbackAlarmPeriodMinutes() {
    const chromeMajor = getChromeMajorVersion();
    return chromeMajor >= DROPBRIDGE_V2_FALLBACK_ALARM_MIN_CHROME_MAJOR
        ? DROPBRIDGE_V2_FALLBACK_ALARM_MINUTES_MODERN
        : DROPBRIDGE_V2_FALLBACK_ALARM_MINUTES_LEGACY;
}

function normalizeDropBridgeV2Diagnostics(rawDiagnostics) {
    const source = rawDiagnostics && typeof rawDiagnostics === 'object' ? rawDiagnostics : {};
    return {
        ...source,
        recentEvents: Array.isArray(source.recentEvents)
            ? source.recentEvents.slice(-DROPBRIDGE_V2_DIAGNOSTIC_EVENT_LIMIT)
            : []
    };
}

async function getDropBridgeV2DiagnosticsState() {
    if (dropBridgeV2DiagnosticsState) {
        return dropBridgeV2DiagnosticsState;
    }

    const stored = await chrome.storage.local.get([DROPBRIDGE_V2_DIAGNOSTICS_STORAGE_KEY]);
    dropBridgeV2DiagnosticsState = normalizeDropBridgeV2Diagnostics(stored?.[DROPBRIDGE_V2_DIAGNOSTICS_STORAGE_KEY]);
    return dropBridgeV2DiagnosticsState;
}

function updateDropBridgeV2Diagnostics(patch = {}, event = null) {
    dropBridgeV2DiagnosticsWritePromise = dropBridgeV2DiagnosticsWritePromise.then(async () => {
        const current = await getDropBridgeV2DiagnosticsState();
        const nowIso = new Date().toISOString();
        const next = {
            ...current,
            ...patch,
            updatedAt: nowIso,
            recentEvents: event
                ? [...current.recentEvents, { at: nowIso, ...event }].slice(-DROPBRIDGE_V2_DIAGNOSTIC_EVENT_LIMIT)
                : current.recentEvents
        };
        dropBridgeV2DiagnosticsState = next;
        await chrome.storage.local.set({
            [DROPBRIDGE_V2_DIAGNOSTICS_STORAGE_KEY]: next
        });
        return next;
    }).catch((error) => {
        console.warn('[DropBridge v2] Failed to update diagnostics:', parseErrorMessage(error));
        return dropBridgeV2DiagnosticsState;
    });

    return dropBridgeV2DiagnosticsWritePromise;
}

function isSupabaseSessionExpired(session, skewSeconds = 30) {
    const expiresAt = Number(session?.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
    const now = Math.floor(Date.now() / 1000);
    return expiresAt <= (now + skewSeconds);
}

async function hydrateDropBridgeV2SessionFromStorage() {
    if (!supabaseClient) return null;
    dropBridgeDebug('hydrate session from storage: begin');

    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) {
        console.error('[DropBridge v2] Failed to load session from storage:', parseErrorMessage(error));
        return null;
    }

    if (!session) {
        console.log('[DropBridge v2] No stored Supabase session found at worker start');
        return null;
    }

    if (isSupabaseSessionExpired(session) && session.refresh_token) {
        console.log('[DropBridge v2] Stored session expired, attempting refresh');
        const { data, error: refreshError } = await supabaseClient.auth.refreshSession({
            refresh_token: session.refresh_token
        });

        if (refreshError) {
            console.error('[DropBridge v2] Session refresh failed:', parseErrorMessage(refreshError));
            return session;
        }

        console.log('[DropBridge v2] Session refresh succeeded at worker start');
        rememberDropBridgeV2Session(data?.session || null);
        return data?.session || null;
    }

    rememberDropBridgeV2Session(session);
    return session;
}

// --- AUTH SESSION KEEPALIVE (MV3) ---
// MV3 service workers are suspended after ~30s idle, which stops supabase-js's
// internal autoRefreshToken timer. A chrome.alarms tick wakes the worker on a
// fixed cadence so we can refresh well before expiry.
const AUTH_REFRESH_ALARM_NAME = 'authTokenRefresh';
const AUTH_REFRESH_PERIOD_MINUTES = 30;
const AUTH_REFRESH_SKEW_SECONDS = 20 * 60;

function ensureAuthRefreshAlarm() {
    try {
        chrome.alarms.create(AUTH_REFRESH_ALARM_NAME, { periodInMinutes: AUTH_REFRESH_PERIOD_MINUTES });
    } catch (error) {
        console.warn('[Lectra Auth] Failed to create auth refresh alarm:', parseErrorMessage(error));
    }
}

async function ensureFreshAuthSession(reason = 'unknown') {
    if (!supabaseClient) return null;
    try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error) {
            console.warn('[Lectra Auth] getSession failed during keepalive:', parseErrorMessage(error));
            return null;
        }
        if (!session) {
            dropBridgeDebug('auth keepalive: no session', { reason });
            return null;
        }

        if (!isSupabaseSessionExpired(session, AUTH_REFRESH_SKEW_SECONDS)) {
            await persistAuthStatusSnapshot(session);
            return session;
        }

        if (!session.refresh_token) {
            return session;
        }

        const { data, error: refreshError } = await supabaseClient.auth.refreshSession({
            refresh_token: session.refresh_token
        });
        if (refreshError) {
            console.warn('[Lectra Auth] Token refresh failed during keepalive:', parseErrorMessage(refreshError));
            return session;
        }

        const refreshed = data?.session || null;
        rememberDropBridgeV2Session(refreshed);
        await persistAuthStatusSnapshot(refreshed);
        return refreshed;
    } catch (error) {
        console.warn('[Lectra Auth] Keepalive error:', parseErrorMessage(error));
        return null;
    }
}

async function getDropBridgeV2AccessToken() {
    if (!supabaseClient) return null;
    const cached = getDropBridgeV2CachedAccessToken();
    if (cached) {
        return cached;
    }

    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    if (!session) {
        clearDropBridgeV2SessionCache();
        return null;
    }

    if (isSupabaseSessionExpired(session)) {
        if (!session.refresh_token) {
            return null;
        }

        const { data, error: refreshError } = await supabaseClient.auth.refreshSession({
            refresh_token: session.refresh_token
        });

        if (refreshError) {
            console.error('[DropBridge v2] Session refresh failed during token fetch:', parseErrorMessage(refreshError));
            return null;
        }

        rememberDropBridgeV2Session(data?.session || null);
        return data?.session?.access_token || null;
    }

    rememberDropBridgeV2Session(session);
    return session.access_token || null;
}

async function getSupabaseAccessToken() {
    return getDropBridgeV2AccessToken();
}

async function getSignedInUserId() {
    if (!supabaseClient) return null;
    const { data: { session } } = await supabaseClient.auth.getSession();
    return session?.user?.id || null;
}

async function getOrCreateDropBridgeV2DeviceId() {
    if (isUuid(dropBridgeV2CachedDeviceId)) {
        return dropBridgeV2CachedDeviceId;
    }

    const stored = await chrome.storage.local.get([DROPBRIDGE_V2_STORAGE_DEVICE_ID, DROPBRIDGE_MODE_STORAGE_KEY]);
    const existingId = stored[DROPBRIDGE_V2_STORAGE_DEVICE_ID];
    if (isUuid(existingId)) {
        dropBridgeV2CachedDeviceId = existingId;
        if (stored[DROPBRIDGE_MODE_STORAGE_KEY] !== DROPBRIDGE_V2_MODE) {
            await chrome.storage.local.set({ [DROPBRIDGE_MODE_STORAGE_KEY]: DROPBRIDGE_V2_MODE });
        }
        return existingId;
    }

    const nextId = generateUuidV4();
    await chrome.storage.local.set({
        [DROPBRIDGE_V2_STORAGE_DEVICE_ID]: nextId,
        [DROPBRIDGE_MODE_STORAGE_KEY]: DROPBRIDGE_V2_MODE
    });
    dropBridgeV2CachedDeviceId = nextId;
    console.log(`[DropBridge v2] Generated stable deviceId: ${nextId}`);
    return nextId;
}

async function callDropBridgeV2Function(functionName, body, accessToken) {
    const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/${functionName}`;
    const startedAtMs = Date.now();
    dropBridgeDebug(`function call -> ${functionName}: request`, {
        endpoint,
        hasAccessToken: Boolean(accessToken),
        body: sanitizeDropBridgePayload(body)
    });

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    dropBridgeDebug(`function call -> ${functionName}: response`, {
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAtMs,
        payload: sanitizeDropBridgePayload(payload)
    });

    if (!response.ok || payload?.error) {
        throw new Error(payload?.error || `${functionName} failed (${response.status})`);
    }

    return payload;
}

async function updateDropBridgeV2UploadStatus({ accessToken, deviceId, uploadId, status }) {
    try {
        await callDropBridgeV2Function('update-upload-status-v2', {
            deviceId,
            uploadId,
            status,
            clientKind: 'canvascope_extension'
        }, accessToken);
        void updateDropBridgeV2Diagnostics({
            lastAckAt: new Date().toISOString(),
            lastAckUploadId: uploadId,
            lastAckStatus: status,
            lastAckOk: true
        }, {
            type: 'upload_ack',
            uploadId,
            status,
            ok: true
        });
        return true;
    } catch (error) {
        console.error(`[DropBridge v2] Status update failure for ${uploadId} -> ${status}:`, parseErrorMessage(error));
        void updateDropBridgeV2Diagnostics({
            lastAckAt: new Date().toISOString(),
            lastAckUploadId: uploadId,
            lastAckStatus: status,
            lastAckOk: false
        }, {
            type: 'upload_ack',
            uploadId,
            status,
            ok: false,
            error: parseErrorMessage(error)
        });
        return false;
    }
}

function resolveDropBridgeUploadId(upload) {
    return upload?.uploadId || upload?.id || null;
}

async function claimDropBridgeV2UploadById({ accessToken, deviceId, uploadId }) {
    return callDropBridgeV2Function('claim-upload-v2', {
        deviceId,
        uploadId,
        clientKind: 'canvascope_extension'
    }, accessToken);
}

async function tryClaimAndProcessDropBridgeV2UploadById({ uploadId, accessToken = null, deviceId = null, reason = 'targeted-claim' }) {
    const normalizedUploadId = String(uploadId || '').trim();
    if (!isUuid(normalizedUploadId)) {
        return false;
    }

    if (dropBridgeV2ActiveUploads.has(normalizedUploadId) || dropBridgeV2TargetedClaimsInFlight.has(normalizedUploadId)) {
        void updateDropBridgeV2Diagnostics({
            lastTargetedClaimAt: new Date().toISOString(),
            lastTargetedClaimUploadId: normalizedUploadId,
            lastTargetedClaimResult: 'duplicate_active'
        }, {
            type: 'targeted_claim_skipped',
            reason,
            uploadId: normalizedUploadId,
            result: 'duplicate_active'
        });
        return true;
    }

    const resolvedAccessToken = accessToken || await getDropBridgeV2AccessToken();
    if (!resolvedAccessToken) {
        return false;
    }

    const resolvedDeviceId = deviceId || await getOrCreateDropBridgeV2DeviceId();
    const claimStartedAtMs = Date.now();
    dropBridgeV2TargetedClaimsInFlight.add(normalizedUploadId);
    void updateDropBridgeV2Diagnostics({
        lastTargetedClaimStartedAt: new Date(claimStartedAtMs).toISOString(),
        lastTargetedClaimUploadId: normalizedUploadId,
        lastTargetedClaimReason: reason,
        lastTargetedClaimResult: 'started',
        lastTransferStage: 'claiming',
        lastTransferUploadId: normalizedUploadId,
        lastTransferAt: new Date(claimStartedAtMs).toISOString()
    }, {
        type: 'transfer_progress',
        stage: 'claiming',
        reason,
        uploadId: normalizedUploadId
    });
    try {
        const payload = await claimDropBridgeV2UploadById({
            accessToken: resolvedAccessToken,
            deviceId: resolvedDeviceId,
            uploadId: normalizedUploadId
        });
        const claimFinishedAtIso = new Date().toISOString();
        const upload = payload?.upload || null;
        if (!upload) {
            void updateDropBridgeV2Diagnostics({
                lastTargetedClaimFinishedAt: claimFinishedAtIso,
                lastTargetedClaimDurationMs: Date.now() - claimStartedAtMs,
                lastTargetedClaimResult: 'empty'
            }, {
                type: 'targeted_claim_finished',
                reason,
                uploadId: normalizedUploadId,
                ok: false,
                result: 'empty'
            });
            return false;
        }

        void updateDropBridgeV2Diagnostics({
            lastTargetedClaimFinishedAt: claimFinishedAtIso,
            lastTargetedClaimDurationMs: Date.now() - claimStartedAtMs,
            lastTargetedClaimResult: 'claimed',
            lastSignedUrlReceivedAt: upload.downloadUrl ? claimFinishedAtIso : null,
            lastTransferStage: upload.downloadUrl ? 'signed_url_issued' : 'claimed',
            lastTransferUploadId: normalizedUploadId,
            lastTransferFileName: upload.fileName || null,
            lastTransferAt: claimFinishedAtIso
        }, {
            type: 'transfer_progress',
            stage: upload.downloadUrl ? 'signed_url_issued' : 'claimed',
            reason,
            uploadId: normalizedUploadId,
            ok: true,
            result: 'claimed',
            hasDownloadUrl: Boolean(upload.downloadUrl)
        });
        await processDropBridgeV2Upload(upload, resolvedAccessToken, resolvedDeviceId);
        return true;
    } catch (error) {
        const claimFinishedAtIso = new Date().toISOString();
        void updateDropBridgeV2Diagnostics({
            lastTargetedClaimFinishedAt: claimFinishedAtIso,
            lastTargetedClaimDurationMs: Date.now() - claimStartedAtMs,
            lastTargetedClaimResult: 'error',
            lastTargetedClaimError: parseErrorMessage(error)
        }, {
            type: 'targeted_claim_finished',
            reason,
            uploadId: normalizedUploadId,
            ok: false,
            result: 'error',
            error: parseErrorMessage(error)
        });
        return false;
    } finally {
        dropBridgeV2TargetedClaimsInFlight.delete(normalizedUploadId);
    }
}

function shouldRestartDropBridgeReceiverFromStatus(status, reason = null) {
    const normalizedStatus = String(status || '').toLowerCase();
    if (!['error', 'timed_out', 'closed'].includes(normalizedStatus)) {
        return false;
    }

    const normalizedReason = String(reason || '').toLowerCase();
    if (normalizedReason === 'no-context') {
        return false;
    }

    if (Date.now() < dropBridgeV2IntentionalOffscreenCloseUntil) {
        return false;
    }

    return true;
}

async function ensureDropBridgeV2LoopWarm(reason = 'manual', { force = false, restart = false } = {}) {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        return {
            success: false,
            reason: 'disabled'
        };
    }

    if (!await isSendToLectraFeatureEnabled()) {
        stopDropBridgeV2Loop();
        return {
            success: true,
            enabled: false,
            reason: 'feature_disabled'
        };
    }

    const now = Date.now();
    const throttleWindowMs = restart
        ? DROPBRIDGE_V2_RECEIVER_RESTART_THROTTLE_MS
        : DROPBRIDGE_V2_RECEIVER_WARMUP_THROTTLE_MS;
    const lastRunAt = restart ? dropBridgeV2LastRestartAt : dropBridgeV2LastWarmupAt;

    if (!force && lastRunAt > 0 && (now - lastRunAt) < throttleWindowMs) {
        return {
            success: true,
            throttled: true,
            reason
        };
    }

    if (dropBridgeV2WarmupPromise) {
        return dropBridgeV2WarmupPromise;
    }

    if (restart) {
        dropBridgeV2LastRestartAt = now;
    } else {
        dropBridgeV2LastWarmupAt = now;
    }

    dropBridgeV2WarmupPromise = (async () => {
        await startDropBridgeV2Loop(reason);
        return {
            success: true,
            throttled: false,
            reason
        };
    })().finally(() => {
        dropBridgeV2WarmupPromise = null;
    });

    return dropBridgeV2WarmupPromise;
}

function getDownloadItemById(downloadId) {
    return new Promise((resolve) => {
        chrome.downloads.search({ id: downloadId }, (results) => {
            resolve(Array.isArray(results) && results.length > 0 ? results[0] : null);
        });
    });
}

async function triggerDropBridgeDownload(upload) {
    const uploadId = resolveDropBridgeUploadId(upload) || 'unknown-upload';
    const downloadUrl = upload?.downloadUrl;
    const fileName = sanitizeFilename(upload?.fileName);

    if (!downloadUrl) {
        void updateDropBridgeV2Diagnostics({
            lastDownloadAt: new Date().toISOString(),
            lastDownloadUploadId: uploadId,
            lastDownloadStatus: 'queued',
            lastDownloadReason: 'Missing downloadUrl'
        }, {
            type: 'download_finalized',
            uploadId,
            status: 'queued',
            reason: 'Missing downloadUrl'
        });
        return { status: 'queued', reason: 'Missing downloadUrl' };
    }

    return new Promise((resolve) => {
        let done = false;
        let downloadId = null;
        let timeoutId = null;
        const startedAt = Date.now();

        const finalize = (result) => {
            if (done) return;
            done = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (downloadId !== null) {
                chrome.downloads.onChanged.removeListener(onChanged);
                chrome.downloads.onErased.removeListener(onErased);
            }
            void updateDropBridgeV2Diagnostics({
                lastDownloadAt: new Date().toISOString(),
                lastDownloadUploadId: uploadId,
                lastDownloadStatus: result.status,
                lastDownloadReason: result.reason || null
            }, {
                type: 'download_finalized',
                uploadId,
                status: result.status,
                reason: result.reason || null
            });
            resolve(result);
        };

        const onChanged = (delta) => {
            if (delta.id !== downloadId) return;
            if (delta.state?.current === 'complete') {
                finalize({ status: 'downloaded' });
                return;
            }

            if (delta.state?.current === 'interrupted') {
                const reason = delta.error?.current || 'DOWNLOAD_INTERRUPTED';
                if (isDropBridgeUserCanceled(reason)) {
                    finalize({ status: 'canceled', reason });
                } else {
                    finalize({ status: 'queued', reason });
                }
            }
        };

        const onErased = (erasedId) => {
            if (erasedId === downloadId) {
                finalize({ status: 'canceled', reason: 'USER_CANCELED' });
            }
        };

        const scheduleWatchdogCheck = () => {
            timeoutId = setTimeout(async () => {
                const item = await getDownloadItemById(downloadId);
                if (!item) {
                    finalize({ status: 'queued', reason: 'DOWNLOAD_ITEM_MISSING' });
                    return;
                }

                if (item.state === 'complete') {
                    finalize({ status: 'downloaded' });
                    return;
                }

                if (item.state === 'interrupted') {
                    const reason = item.error || 'DOWNLOAD_INTERRUPTED';
                    if (isDropBridgeUserCanceled(reason)) {
                        finalize({ status: 'canceled', reason });
                    } else {
                        finalize({ status: 'queued', reason });
                    }
                    return;
                }

                const isStillActive = item.state === 'in_progress' || item.paused === true;
                const elapsedMs = Date.now() - startedAt;
                if (isStillActive && elapsedMs < DROPBRIDGE_V2_DOWNLOAD_MAX_OBSERVE_MS) {
                    scheduleWatchdogCheck();
                    return;
                }

                if (isStillActive) {
                    finalize({ status: 'queued', reason: 'DOWNLOAD_TIMEOUT' });
                    return;
                }

                finalize({
                    status: 'queued',
                    reason: `DOWNLOAD_STATE_${String(item.state || 'UNKNOWN').toUpperCase()}`
                });
            }, DROPBRIDGE_V2_DOWNLOAD_WATCHDOG_INTERVAL_MS);
        };

        chrome.downloads.download(
            {
                url: downloadUrl,
                filename: fileName,
                saveAs: false,
                conflictAction: 'uniquify'
            },
            (id) => {
                const startError = chrome.runtime.lastError?.message;
                if (startError || typeof id !== 'number') {
                    if (isDropBridgeUserCanceled(startError)) {
                        finalize({ status: 'canceled', reason: startError || 'USER_CANCELED' });
                    } else {
                        finalize({ status: 'queued', reason: startError || 'DOWNLOAD_START_FAILED' });
                    }
                    return;
                }

                downloadId = id;
                void updateDropBridgeV2Diagnostics({
                    lastChromeDownloadStartedAt: new Date().toISOString(),
                    lastChromeDownloadUploadId: uploadId,
                    lastChromeDownloadId: downloadId
                }, {
                    type: 'chrome_download_started',
                    uploadId,
                    downloadId
                });
                chrome.downloads.onChanged.addListener(onChanged);
                chrome.downloads.onErased.addListener(onErased);
                scheduleWatchdogCheck();
            }
        );
    });
}

async function processDropBridgeV2Upload(upload, accessToken, deviceId) {
    const uploadId = resolveDropBridgeUploadId(upload);
    if (!uploadId) {
        console.warn('[DropBridge v2] Skipping upload with missing uploadId field');
        return;
    }
    if (dropBridgeV2ActiveUploads.has(uploadId)) {
        return;
    }

    const startedAtMs = Date.now();
    dropBridgeV2ActiveUploads.add(uploadId);
    void updateDropBridgeV2Diagnostics({
        lastClaimedAt: new Date().toISOString(),
        lastClaimedUploadId: uploadId,
        lastTransferStage: 'downloading',
        lastTransferUploadId: uploadId,
        lastTransferFileName: upload.fileName || null,
        lastTransferAt: new Date().toISOString()
    }, {
        type: 'transfer_progress',
        stage: 'downloading',
        uploadId,
        deviceId
    });
    try {
        const result = await triggerDropBridgeDownload(upload);
        if (result.status === 'downloaded') {
            console.log(`[DropBridge v2] Download success for ${uploadId}`);
        } else {
            console.warn(`[DropBridge v2] Download ${result.status} for ${uploadId}: ${result.reason || 'no-reason'}`);
        }

        await updateDropBridgeV2UploadStatus({
            accessToken,
            deviceId,
            uploadId,
            status: result.status
        });
        void updateDropBridgeV2Diagnostics({
            lastTransferStage: result.status,
            lastTransferUploadId: uploadId,
            lastTransferAt: new Date().toISOString()
        }, {
            type: 'transfer_progress',
            stage: result.status,
            uploadId,
            status: result.status
        });
    } catch (error) {
        console.error(`[DropBridge v2] Download failure for ${uploadId}:`, parseErrorMessage(error));
        await updateDropBridgeV2UploadStatus({
            accessToken,
            deviceId,
            uploadId,
            status: 'queued'
        });
    } finally {
        dropBridgeV2ActiveUploads.delete(uploadId);
        void startedAtMs;
    }
}

function buildDropBridgeV2WakeTopic(userId, deviceId) {
    return `dropbridge:user:${userId}:device:${deviceId}`;
}

function clearDropBridgeV2QueuedPoll() {
    if (dropBridgeV2QueuedPollTimer) {
        clearTimeout(dropBridgeV2QueuedPollTimer);
        dropBridgeV2QueuedPollTimer = null;
    }
    dropBridgeV2QueuedPollReason = null;
}

async function hasDropBridgeV2OffscreenDocument() {
    if (!chrome.offscreen) {
        return false;
    }

    if (typeof chrome.runtime.getContexts === 'function') {
        try {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_URL]
            });
            return Array.isArray(contexts) && contexts.length > 0;
        } catch (error) {
            dropBridgeDebug('offscreen: getContexts failed', { error: parseErrorMessage(error) });
        }
    }

    if (self.clients && typeof self.clients.matchAll === 'function') {
        const clients = await self.clients.matchAll();
        return clients.some((client) => client.url === DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_URL);
    }

    return false;
}

async function ensureDropBridgeV2OffscreenReceiver(reason = 'startup') {
    if (!DROPBRIDGE_V2_ENABLED) return false;
    if (!chrome.offscreen) {
        console.warn('[DropBridge v2] chrome.offscreen is unavailable; falling back to alarm-only receive mode.');
        void updateDropBridgeV2Diagnostics({
            receiverStatus: 'unsupported',
            receiverStatusAt: new Date().toISOString(),
            receiverError: 'chrome.offscreen unavailable'
        }, {
            type: 'receiver_status',
            status: 'unsupported',
            reason
        });
        return false;
    }

    if (dropBridgeV2EnsureOffscreenPromise) {
        return dropBridgeV2EnsureOffscreenPromise;
    }

    dropBridgeV2EnsureOffscreenPromise = (async () => {
        if (await hasDropBridgeV2OffscreenDocument()) {
            void updateDropBridgeV2Diagnostics({
                receiverStatus: 'existing',
                receiverStatusAt: new Date().toISOString()
            }, {
                type: 'receiver_status',
                status: 'existing',
                reason
            });
            return true;
        }

        void updateDropBridgeV2Diagnostics({
            receiverStatus: 'creating',
            receiverStatusAt: new Date().toISOString(),
            receiverError: null
        }, {
            type: 'receiver_status',
            status: 'creating',
            reason
        });

        try {
            await chrome.offscreen.createDocument({
                url: DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_PATH,
                reasons: [chrome.offscreen.Reason?.WORKERS || 'WORKERS'],
                justification: DROPBRIDGE_V2_OFFSCREEN_JUSTIFICATION
            });
            void updateDropBridgeV2Diagnostics({
                receiverStatus: 'created',
                receiverStatusAt: new Date().toISOString(),
                receiverError: null
            }, {
                type: 'receiver_status',
                status: 'created',
                reason
            });
            return true;
        } catch (error) {
            const message = parseErrorMessage(error);
            const lowered = message.toLowerCase();
            const alreadyExists = lowered.includes('single offscreen document') || lowered.includes('already exists');
            if (alreadyExists) {
                void updateDropBridgeV2Diagnostics({
                    receiverStatus: 'existing',
                    receiverStatusAt: new Date().toISOString(),
                    receiverError: null
                }, {
                    type: 'receiver_status',
                    status: 'existing',
                    reason
                });
                return true;
            }

            void updateDropBridgeV2Diagnostics({
                receiverStatus: 'error',
                receiverStatusAt: new Date().toISOString(),
                receiverError: message
            }, {
                type: 'receiver_status',
                status: 'error',
                reason,
                error: message
            });
            throw error;
        } finally {
            dropBridgeV2EnsureOffscreenPromise = null;
        }
    })();

    return dropBridgeV2EnsureOffscreenPromise;
}

async function closeDropBridgeV2OffscreenReceiver(reason = 'stop') {
    if (!chrome.offscreen) {
        return false;
    }

    const hasDocument = await hasDropBridgeV2OffscreenDocument();
    if (!hasDocument) {
        return false;
    }

    dropBridgeV2IntentionalOffscreenCloseUntil = Date.now() + DROPBRIDGE_V2_INTENTIONAL_CLOSE_GRACE_MS;
    await chrome.offscreen.closeDocument();
    void updateDropBridgeV2Diagnostics({
        receiverStatus: 'closed',
        receiverStatusAt: new Date().toISOString()
    }, {
        type: 'receiver_status',
        status: 'closed',
        reason
    });
    return true;
}

async function ensureDropBridgeV2FallbackAlarm(reason = 'startup') {
    const periodInMinutes = getDropBridgeV2FallbackAlarmPeriodMinutes();
    const existing = await chrome.alarms.get(DROPBRIDGE_V2_FALLBACK_ALARM_NAME);
    const shouldRecreate = !existing || Number(existing.periodInMinutes) !== periodInMinutes;

    if (shouldRecreate) {
        await chrome.alarms.create(DROPBRIDGE_V2_FALLBACK_ALARM_NAME, {
            when: Date.now() + Math.max(1000, Math.round(periodInMinutes * 60 * 1000)),
            periodInMinutes
        });
    }

    void updateDropBridgeV2Diagnostics({
        fallbackAlarmPeriodMinutes: periodInMinutes,
        fallbackAlarmEnsuredAt: new Date().toISOString()
    }, {
        type: 'fallback_alarm',
        reason,
        periodInMinutes
    });
    return periodInMinutes;
}

async function clearDropBridgeV2FallbackAlarm(reason = 'stop') {
    await chrome.alarms.clear(DROPBRIDGE_V2_FALLBACK_ALARM_NAME);
    void updateDropBridgeV2Diagnostics({
        fallbackAlarmClearedAt: new Date().toISOString()
    }, {
        type: 'fallback_alarm_cleared',
        reason
    });
}

async function buildDropBridgeV2ReceiverContext() {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        return {
            success: true,
            enabled: false,
            signedIn: false
        };
    }

    if (!await isSendToLectraFeatureEnabled()) {
        return {
            success: true,
            enabled: false,
            signedIn: false,
            reason: 'feature_disabled'
        };
    }

    const accessToken = await getDropBridgeV2AccessToken();
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) {
        throw error;
    }

    const userId = session?.user?.id || null;
    if (!userId || !accessToken) {
        return {
            success: true,
            enabled: true,
            signedIn: false,
            userId,
            accessToken: null,
            deviceId: null,
            topic: null,
            supabaseUrl,
            supabaseKey,
            wakeEvent: DROPBRIDGE_V2_WAKE_EVENT
        };
    }

    const deviceId = await getOrCreateDropBridgeV2DeviceId();
    return {
        success: true,
        enabled: true,
        signedIn: true,
        userId,
        accessToken,
        deviceId,
        topic: buildDropBridgeV2WakeTopic(userId, deviceId),
        supabaseUrl,
        supabaseKey,
        wakeEvent: DROPBRIDGE_V2_WAKE_EVENT,
        debug: DROPBRIDGE_V2_DEBUG
    };
}

function summarizeDropBridgeV2Event(event) {
    if (!event || typeof event !== 'object') return null;
    const type = String(event.type || 'event');
    const uploadId = event.uploadId ? String(event.uploadId) : null;
    const status = event.status ? String(event.status) : null;
    const reason = event.reason ? String(event.reason) : null;
    const stage = event.stage ? String(event.stage) : null;
    return {
        at: event.at || null,
        type,
        uploadId,
        status,
        reason,
        stage
    };
}

function buildDropBridgeV2TransferSummary({ diagnostics, latestEvent }) {
    const stage = String(diagnostics?.lastTransferStage || '').toLowerCase();
    if (!stage) return null;

    const uploadId = diagnostics?.lastTransferUploadId || latestEvent?.uploadId || null;
    const fileName = diagnostics?.lastTransferFileName || diagnostics?.lastWakeFileName || null;
    const uploadSuffix = uploadId ? ` · ${String(uploadId).slice(0, 8)}` : '';
    const detail = fileName ? `${fileName}${uploadSuffix}` : (uploadId ? `Upload ${String(uploadId).slice(0, 8)}` : null);

    switch (stage) {
        case 'queued':
        case 'wake_broadcasted':
        case 'wake_emitted':
            return {
                health: 'transfer_active',
                label: 'Lectra file queued',
                detail: detail || 'Waiting for download claim'
            };
        case 'claiming':
        case 'claimed':
            return {
                health: 'transfer_active',
                label: 'Claiming Lectra file',
                detail: detail || 'Receiver claimed the upload'
            };
        case 'signed_url_issued':
            return {
                health: 'transfer_active',
                label: 'Download starting',
                detail: detail || 'Signed download URL issued'
            };
        case 'downloading':
            return {
                health: 'transfer_active',
                label: 'Downloading Lectra file',
                detail: detail || 'Browser download in progress'
            };
        case 'downloaded':
            return {
                health: 'realtime_connected',
                label: 'Lectra file downloaded',
                detail: detail || 'Latest transfer completed'
            };
        case 'canceled':
            return {
                health: 'fallback_polling',
                label: 'Lectra download canceled',
                detail: detail || 'Latest transfer was canceled'
            };
        default:
            return null;
    }
}

function buildDropBridgeV2HealthSummary({ diagnostics, signedIn }) {
    if (!DROPBRIDGE_V2_ENABLED) {
        return {
            enabled: false,
            signedIn: false,
            health: 'disabled',
            label: 'Receiver off',
            detail: 'Receiver disabled'
        };
    }

    if (!signedIn) {
        return {
            enabled: true,
            signedIn: false,
            health: 'signed_out',
            label: 'Signed out',
            detail: 'Sign in to receive Lectra files'
        };
    }

    const receiverStatus = String(diagnostics?.receiverStatus || '').toLowerCase();
    const recentEvents = Array.isArray(diagnostics?.recentEvents) ? diagnostics.recentEvents : [];
    const latestEvent = summarizeDropBridgeV2Event(recentEvents.length > 0 ? recentEvents[recentEvents.length - 1] : null);
    const transferSummary = buildDropBridgeV2TransferSummary({ diagnostics, latestEvent });
    if (transferSummary) {
        return {
            enabled: true,
            signedIn: true,
            ...transferSummary,
            latestEvent,
            receiverStatus
        };
    }

    if (receiverStatus === 'subscribed') {
        return {
            enabled: true,
            signedIn: true,
            health: 'realtime_connected',
            label: 'Realtime connected',
            detail: diagnostics?.lastWakeAt ? `Last wake ${diagnostics.lastWakeAt}` : 'Receiver is subscribed',
            latestEvent,
            receiverStatus
        };
    }

    if (receiverStatus === 'connecting' || receiverStatus === 'creating' || receiverStatus === 'created' || receiverStatus === 'existing') {
        return {
            enabled: true,
            signedIn: true,
            health: 'reconnecting',
            label: 'Reconnecting',
            detail: 'Receiver is warming up',
            latestEvent,
            receiverStatus
        };
    }

    return {
        enabled: true,
        signedIn: true,
        health: 'fallback_polling',
        label: 'Fallback polling',
        detail: diagnostics?.receiverError || 'Realtime receiver is not subscribed',
        latestEvent,
        receiverStatus: receiverStatus || null
    };
}

async function buildDropBridgeV2PopupStatus() {
    if (!await isSendToLectraFeatureEnabled()) {
        return {
            enabled: false,
            signedIn: false,
            health: 'disabled',
            label: 'Receiving disabled',
            detail: 'Turn on Lectra to receive files.',
            diagnostics: null
        };
    }

    const diagnostics = await getDropBridgeV2DiagnosticsState();
    const authStatus = await resolveAuthStatus();
    return {
        ...buildDropBridgeV2HealthSummary({
            diagnostics,
            signedIn: Boolean(authStatus?.signedIn)
        }),
        diagnostics: {
            receiverStatus: diagnostics?.receiverStatus || null,
            receiverStatusAt: diagnostics?.receiverStatusAt || null,
            receiverSubscribedAt: diagnostics?.receiverSubscribedAt || null,
            lastWakeAt: diagnostics?.lastWakeAt || null,
            lastWakeUploadId: diagnostics?.lastWakeUploadId || null,
            lastTransferStage: diagnostics?.lastTransferStage || null,
            lastTransferUploadId: diagnostics?.lastTransferUploadId || null,
            lastTransferAt: diagnostics?.lastTransferAt || null,
            lastTargetedClaimResult: diagnostics?.lastTargetedClaimResult || null,
            lastDownloadStatus: diagnostics?.lastDownloadStatus || null,
            lastAckStatus: diagnostics?.lastAckStatus || null,
            lastHeartbeatAt: diagnostics?.lastHeartbeatAt || null,
            fallbackAlarmPeriodMinutes: diagnostics?.fallbackAlarmPeriodMinutes || null
        }
    };
}

async function requestDropBridgeV2Poll(reason = 'manual') {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        return;
    }

    if (!await isSendToLectraFeatureEnabled()) {
        stopDropBridgeV2Loop();
        return;
    }

    if (dropBridgeV2PollInFlight) {
        dropBridgeV2QueuedPollReason = reason;
        return;
    }

    const isWakeDriven = reason !== 'alarm';
    const sinceLastPollStartMs = Date.now() - dropBridgeV2LastPollStartedAt;
    if (isWakeDriven && sinceLastPollStartMs < DROPBRIDGE_V2_WAKE_POLL_DEBOUNCE_MS) {
        dropBridgeV2QueuedPollReason = reason;
        if (!dropBridgeV2QueuedPollTimer) {
            const delayMs = DROPBRIDGE_V2_WAKE_POLL_DEBOUNCE_MS - sinceLastPollStartMs;
            dropBridgeV2QueuedPollTimer = setTimeout(() => {
                const nextReason = dropBridgeV2QueuedPollReason || `${reason}-delayed`;
                dropBridgeV2QueuedPollTimer = null;
                dropBridgeV2QueuedPollReason = null;
                requestDropBridgeV2Poll(nextReason).catch((error) => {
                    console.error('[DropBridge v2] Delayed poll failure:', parseErrorMessage(error));
                });
            }, delayMs);
        }
        return;
    }

    await pollDropBridgeV2Once(reason);
}

async function registerDropBridgeV2Device(reason = 'startup', accessToken = null) {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) return false;
    const token = accessToken || await getDropBridgeV2AccessToken();
    console.log(`[DropBridge v2] Access token ${token ? 'present' : 'absent'} before register (${reason})`);
    if (!token) return false;

    const deviceId = await getOrCreateDropBridgeV2DeviceId();
    const deviceName = getDropBridgeV2DeviceName();
    const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/register-device-v2`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            deviceId,
            deviceName,
            clientKind: 'canvascope_extension'
        })
    });

    const payload = await response.json().catch(() => ({}));
    const errorPayload = payload?.error || payload?.message || null;
    console.log(`[DropBridge v2] register-device-v2 status=${response.status} error=${errorPayload || 'none'}`);

    if (!response.ok || payload?.error) {
        throw new Error(payload?.error || `register-device-v2 failed (${response.status})`);
    }

    console.log(`[DropBridge v2] Registered device (${reason}) as "${deviceName}"`);
    void updateDropBridgeV2Diagnostics({
        receiverDeviceId: deviceId,
        receiverRegisteredAt: new Date().toISOString()
    }, {
        type: 'device_registered',
        reason,
        deviceId
    });
    return true;
}

async function heartbeatDropBridgeV2Device(reason = 'heartbeat', accessToken = null, deviceId = null) {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) return false;
    if (!await isSendToLectraFeatureEnabled()) {
        stopDropBridgeV2Loop();
        return false;
    }

    const token = accessToken || await getDropBridgeV2AccessToken();
    if (!token) {
        void updateDropBridgeV2Diagnostics({
            lastHeartbeatAt: new Date().toISOString(),
            lastHeartbeatResult: 'no_access_token'
        }, {
            type: 'heartbeat',
            reason,
            ok: false,
            result: 'no_access_token'
        });
        return false;
    }

    const resolvedDeviceId = deviceId || await getOrCreateDropBridgeV2DeviceId();
    try {
        const payload = await callDropBridgeV2Function('heartbeat-device-v2', {
            deviceId: resolvedDeviceId,
            clientKind: 'canvascope_extension'
        }, token);
        void updateDropBridgeV2Diagnostics({
            lastHeartbeatAt: payload?.lastSeenAt || new Date().toISOString(),
            lastHeartbeatResult: 'ok'
        }, {
            type: 'heartbeat',
            reason,
            ok: true,
            deviceId: resolvedDeviceId
        });
        return true;
    } catch (error) {
        void updateDropBridgeV2Diagnostics({
            lastHeartbeatAt: new Date().toISOString(),
            lastHeartbeatResult: 'error',
            lastHeartbeatError: parseErrorMessage(error)
        }, {
            type: 'heartbeat',
            reason,
            ok: false,
            deviceId: resolvedDeviceId,
            error: parseErrorMessage(error)
        });
        console.warn('[DropBridge v2] Heartbeat failed:', parseErrorMessage(error));
        return false;
    }
}

async function ensureDropBridgeV2HeartbeatAlarm(reason = 'startup') {
    const existing = await chrome.alarms.get(DROPBRIDGE_V2_HEARTBEAT_ALARM_NAME);
    const shouldRecreate = !existing || Number(existing.periodInMinutes) !== DROPBRIDGE_V2_HEARTBEAT_ALARM_MINUTES;
    if (shouldRecreate) {
        await chrome.alarms.create(DROPBRIDGE_V2_HEARTBEAT_ALARM_NAME, {
            when: Date.now() + Math.max(1000, Math.round(DROPBRIDGE_V2_HEARTBEAT_ALARM_MINUTES * 60 * 1000)),
            periodInMinutes: DROPBRIDGE_V2_HEARTBEAT_ALARM_MINUTES
        });
    }

    void updateDropBridgeV2Diagnostics({
        heartbeatAlarmPeriodMinutes: DROPBRIDGE_V2_HEARTBEAT_ALARM_MINUTES,
        heartbeatAlarmEnsuredAt: new Date().toISOString()
    }, {
        type: 'heartbeat_alarm',
        reason,
        periodInMinutes: DROPBRIDGE_V2_HEARTBEAT_ALARM_MINUTES
    });
}

async function clearDropBridgeV2HeartbeatAlarm(reason = 'stop') {
    await chrome.alarms.clear(DROPBRIDGE_V2_HEARTBEAT_ALARM_NAME);
    void updateDropBridgeV2Diagnostics({
        heartbeatAlarmClearedAt: new Date().toISOString()
    }, {
        type: 'heartbeat_alarm_cleared',
        reason
    });
}

async function pollDropBridgeV2Once(reason = 'alarm') {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        return;
    }

    if (dropBridgeV2PollInFlight) {
        dropBridgeV2QueuedPollReason = reason;
        return;
    }

    const pollStartedAtMs = Date.now();
    dropBridgeV2LastPollStartedAt = pollStartedAtMs;
    dropBridgeV2PollInFlight = true;
    void updateDropBridgeV2Diagnostics({
        lastPollStartedAt: new Date(pollStartedAtMs).toISOString(),
        lastPollReason: reason
    }, {
        type: 'poll_started',
        reason
    });

    try {
        const accessToken = await getDropBridgeV2AccessToken();
        if (!accessToken) {
            void updateDropBridgeV2Diagnostics({
                lastPollFinishedAt: new Date().toISOString(),
                lastPollResult: 'no_access_token',
                lastPollUploadCount: 0
            }, {
                type: 'poll_finished',
                reason,
                result: 'no_access_token'
            });
            return;
        }

        const deviceId = await getOrCreateDropBridgeV2DeviceId();
        const payload = await callDropBridgeV2Function('list-pending-v2', {
            deviceId,
            limit: DROPBRIDGE_V2_POLL_LIMIT,
            clientKind: 'canvascope_extension'
        }, accessToken);

        const uploads = Array.isArray(payload?.uploads) ? payload.uploads : [];
        console.log(`[DropBridge v2] Poll (${reason}) returned ${uploads.length} upload(s)`);
        void updateDropBridgeV2Diagnostics({
            lastPollUploadCount: uploads.length,
            lastPollResult: 'ok'
        }, {
            type: 'poll_uploads_ready',
            reason,
            uploadCount: uploads.length
        });

        for (let index = 0; index < uploads.length; index += 1) {
            const upload = uploads[index];
            const uploadId = resolveDropBridgeUploadId(upload);
            void updateDropBridgeV2Diagnostics({
                lastClaimedAt: new Date().toISOString(),
                lastClaimedUploadId: uploadId
            }, {
                type: 'upload_claimed',
                reason,
                uploadId
            });
            await processDropBridgeV2Upload(upload, accessToken, deviceId);
        }
    } catch (error) {
        console.error(`[DropBridge v2] Poll failure (${reason}):`, parseErrorMessage(error));
        void updateDropBridgeV2Diagnostics({
            lastPollResult: 'error',
            lastPollError: parseErrorMessage(error)
        }, {
            type: 'poll_error',
            reason,
            error: parseErrorMessage(error)
        });
    } finally {
        dropBridgeV2PollInFlight = false;
        const finishedAtIso = new Date().toISOString();
        void updateDropBridgeV2Diagnostics({
            lastPollFinishedAt: finishedAtIso,
            lastPollDurationMs: Date.now() - pollStartedAtMs
        }, {
            type: 'poll_finished',
            reason,
            durationMs: Date.now() - pollStartedAtMs
        });

        if (dropBridgeV2QueuedPollReason && !dropBridgeV2QueuedPollTimer) {
            const nextReason = dropBridgeV2QueuedPollReason;
            dropBridgeV2QueuedPollReason = null;
            requestDropBridgeV2Poll(`${nextReason}-followup`).catch((error) => {
                console.error('[DropBridge v2] Follow-up poll failure:', parseErrorMessage(error));
            });
        }
    }
}

function stopDropBridgeV2Loop() {
    clearDropBridgeV2QueuedPoll();
    clearDropBridgeV2FallbackAlarm('loop-stop').catch((error) => {
        console.warn('[DropBridge v2] Failed to clear fallback alarm:', parseErrorMessage(error));
    });
    clearDropBridgeV2HeartbeatAlarm('loop-stop').catch((error) => {
        console.warn('[DropBridge v2] Failed to clear heartbeat alarm:', parseErrorMessage(error));
    });
    closeDropBridgeV2OffscreenReceiver('loop-stop').catch((error) => {
        console.warn('[DropBridge v2] Failed to close offscreen receiver:', parseErrorMessage(error));
    });
    dropBridgeV2ActiveUploads.clear();
}

async function startDropBridgeV2Loop(reason = 'startup') {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        return;
    }

    if (!await isSendToLectraFeatureEnabled()) {
        stopDropBridgeV2Loop();
        return;
    }

    try {
        const accessToken = await getDropBridgeV2AccessToken();
        if (!accessToken) {
            stopDropBridgeV2Loop();
            return;
        }

        const registered = await registerDropBridgeV2Device(reason, accessToken);
        if (!registered) {
            return;
        }

        await ensureDropBridgeV2FallbackAlarm(reason);
        await ensureDropBridgeV2HeartbeatAlarm(reason);
        void heartbeatDropBridgeV2Device(`${reason}-heartbeat`, accessToken).catch((error) => {
            console.warn('[DropBridge v2] Startup heartbeat failure:', parseErrorMessage(error));
        });
        await ensureDropBridgeV2OffscreenReceiver(reason);

        await requestDropBridgeV2Poll(`${reason}-immediate`);
    } catch (error) {
        console.error(`[DropBridge v2] Startup failure (${reason}):`, parseErrorMessage(error));
    }
}

async function bootstrapDropBridgeV2FromWorkerStart(reason = 'worker-start') {
    await hydrateDropBridgeV2SessionFromStorage();
    await startDropBridgeV2Loop(reason);
}

// ============================================
// PDF DETECTION + SEND HELPERS
// ============================================

const PDF_HEADER_CHECK_BYTES = 1024;
const PDF_SEND_MAX_BYTES = 25 * 1024 * 1024; // 25MB
const PDF_CONTEXT_TIMEOUT_MS = 1800;

const PDF_CONFIDENCE_RANK = {
    none: 0,
    weak: 1,
    strong: 2,
    definitive: 3
};

function isPdfSupportedFetchProtocol(protocol) {
    return protocol === 'https:' || protocol === 'http:' || protocol === 'file:';
}

function decodePossiblyEncodedUrl(value) {
    if (!value) return null;
    let decoded = String(value);
    for (let i = 0; i < 2; i += 1) {
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

function parsePdfViewerSrcFromTabUrl(tabUrl) {
    if (!tabUrl) return null;
    try {
        const parsed = new URL(tabUrl);
        const src = parsed.searchParams.get('src');
        if (!src) return null;
        const decoded = decodePossiblyEncodedUrl(src);
        if (!decoded) return null;
        return normalizePdfCandidateUrl(decoded);
    } catch {
        return null;
    }
}

function normalizePdfCandidateUrl(url, baseUrl = null) {
    if (!url) return null;
    try {
        const parsed = new URL(String(url), baseUrl || undefined);
        if (!isPdfSupportedFetchProtocol(parsed.protocol)) return null;
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

function isLikelyPdfHint(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const path = parsed.pathname.toLowerCase();
        const query = parsed.search.toLowerCase();
        return path.endsWith('.pdf')
            || query.includes('content_type=application%2fpdf')
            || query.includes('content-type=application%2fpdf')
            || query.includes('mime=application%2fpdf');
    } catch {
        return false;
    }
}

function deriveDownloadUrlVariants(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const match = parsed.pathname.match(/\/(?:courses\/(\d+)\/)?files\/(\d+)\/download/i);
        if (!match?.[2]) return [];

        const courseId = match[1] || null;
        const fileId = match[2];
        const baseCandidates = [];
        if (courseId) {
            baseCandidates.push(`${parsed.origin}/courses/${courseId}/files/${fileId}/download`);
        }
        baseCandidates.push(`${parsed.origin}/files/${fileId}/download`);

        const variants = [];
        const seen = new Set();
        for (const base of baseCandidates) {
            for (const suffix of ['', '?download_frd=1', '?wrap=1']) {
                const variant = `${base}${suffix}`;
                if (seen.has(variant)) continue;
                seen.add(variant);
                variants.push(variant);
            }
        }
        return variants;
    } catch {
        return [];
    }
}

function hasPdfSignature(bytes) {
    if (!bytes || bytes.length < 5) return false;
    const max = Math.min(bytes.length, PDF_HEADER_CHECK_BYTES);
    for (let i = 0; i <= max - 5; i += 1) {
        if (
            bytes[i] === 0x25 &&
            bytes[i + 1] === 0x50 &&
            bytes[i + 2] === 0x44 &&
            bytes[i + 3] === 0x46 &&
            bytes[i + 4] === 0x2d
        ) {
            return true;
        }
    }
    return false;
}

function extractFilenameFromContentDisposition(header) {
    if (!header) return null;
    const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
        return decodePossiblyEncodedUrl(utf8Match[1]).replace(/^["']|["']$/g, '');
    }

    const plainMatch = header.match(/filename\s*=\s*("?)([^";]+)\1/i);
    if (plainMatch?.[2]) {
        return plainMatch[2].trim();
    }

    return null;
}

function filenameFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const name = segments.pop();
        return name ? decodePossiblyEncodedUrl(name) : null;
    } catch {
        return null;
    }
}

function cleanTitle(title) {
    const text = String(title || '').trim();
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

function cleanFilenameHint(name) {
    const raw = cleanTitle(name);
    if (!raw) return '';
    const strippedQuery = raw.split('?')[0].split('#')[0];
    const leaf = strippedQuery.split('/').filter(Boolean).pop() || strippedQuery;
    return cleanTitle(decodePossiblyEncodedUrl(leaf) || leaf);
}

function isGenericPdfFilenameHint(name) {
    const cleaned = cleanFilenameHint(name);
    if (!cleaned) return true;
    const lowered = cleaned.toLowerCase().replace(/\.pdf$/i, '');
    return lowered === 'download'
        || lowered === 'file'
        || lowered === 'files'
        || lowered === 'preview'
        || lowered === 'document'
        || lowered === 'pdf'
        || lowered === 'index';
}

function isGenericPdfTitleHint(title) {
    const cleaned = cleanTitle(title);
    if (!cleaned) return true;

    const lowered = cleaned.toLowerCase().replace(/\s+/g, ' ');
    if (lowered === 'file' || lowered === 'files') return true;
    if (lowered === 'file preview' || lowered === 'preview') return true;
    if (lowered === 'document' || lowered === 'pdf') return true;
    if (lowered === 'download' || lowered === 'open file') return true;
    return false;
}

function extractFilenameHintFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const queryKeys = ['filename', 'file_name', 'file', 'name', 'title'];
        for (const key of queryKeys) {
            const value = parsed.searchParams.get(key);
            if (!value) continue;
            const cleaned = cleanFilenameHint(value);
            if (!isGenericPdfFilenameHint(cleaned)) return cleaned;
        }

        const fromPath = cleanFilenameHint(filenameFromUrl(parsed.toString()));
        if (!isGenericPdfFilenameHint(fromPath)) return fromPath;
        return '';
    } catch {
        return '';
    }
}

function prioritizePdfCandidates(candidates, pageUrl = null) {
    let pageHost = '';
    try {
        pageHost = pageUrl ? new URL(pageUrl).hostname.toLowerCase() : '';
    } catch {
        pageHost = '';
    }

    return [...candidates].sort((a, b) => {
        const score = (candidate) => {
            let s = 0;
            const confidence = String(candidate?.hintConfidence || 'weak').toLowerCase();
            if (confidence === 'definitive') s += 300;
            else if (confidence === 'strong') s += 200;
            else s += 100;

            try {
                const host = new URL(candidate.url).hostname.toLowerCase();
                if (host === pageHost) s += 70;
            } catch {
                // no-op
            }

            if (isLikelyPdfHint(candidate.url)) s += 15;
            if (candidate?.source === 'viewer_src') s += 10;
            return s;
        };

        return score(b) - score(a);
    });
}

function withTimeout(promise, timeoutMs, fallbackValue) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(fallbackValue);
        }, timeoutMs);

        promise.then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        }).catch(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(fallbackValue);
        });
    });
}

function sendMessageToTab(tabId, message) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            const err = chrome.runtime.lastError;
            if (err) {
                resolve({ success: false, error: err.message || 'No receiver' });
                return;
            }
            resolve(response || { success: false, error: 'No response' });
        });
    });
}

async function collectPdfCandidatesFromTab(tabId) {
    if (typeof tabId !== 'number') {
        return { success: false, candidates: [], reason: 'invalid_tab' };
    }

    const fallback = { success: false, candidates: [], reason: 'timeout' };
    const response = await withTimeout(
        sendMessageToTab(tabId, { action: 'collectPdfCandidates' }),
        PDF_CONTEXT_TIMEOUT_MS,
        fallback
    );

    if (!response || response.success !== true || !Array.isArray(response.candidates)) {
        return {
            success: false,
            candidates: [],
            pageUrl: response?.pageUrl || null,
            titleHint: response?.titleHint || null,
            reason: response?.error || response?.reason || 'no_candidates'
        };
    }

    return {
        success: true,
        candidates: response.candidates,
        pageUrl: response.pageUrl || null,
        titleHint: response.titleHint || null
    };
}

async function resolveTargetTabForPdfMode(mode, sender) {
    if (mode === 'sender_tab' && sender?.tab) {
        return sender.tab;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null;
}

async function probePdfCandidate(candidateUrl) {
    const normalized = normalizePdfCandidateUrl(candidateUrl);
    if (!normalized) {
        return {
            ok: false,
            confidence: 'none',
            reason: 'invalid_url',
            contentType: null
        };
    }

    let contentType = null;
    let candidateProtocol = '';
    try {
        candidateProtocol = new URL(normalized).protocol;
    } catch {
        candidateProtocol = '';
    }
    const isFileCandidate = candidateProtocol === 'file:';

    if (!isFileCandidate) {
        try {
            const headResp = await fetch(normalized, {
                method: 'HEAD',
                credentials: 'include',
                redirect: 'follow'
            });
            if (headResp?.headers) {
                contentType = headResp.headers.get('content-type') || null;
            }
        } catch {
            // HEAD often fails on file routes; GET range remains authoritative.
        }
    }

    const sniffWithHeaders = async (headers = {}) => {
        const options = {
            method: 'GET',
            redirect: 'follow',
            headers
        };
        if (!isFileCandidate) {
            options.credentials = 'include';
        }
        return fetch(normalized, options);
    };

    try {
        let sniffResp;
        try {
            sniffResp = await sniffWithHeaders({
                Range: `bytes=0-${PDF_HEADER_CHECK_BYTES - 1}`
            });
            if (sniffResp.status === 416) {
                sniffResp = await sniffWithHeaders();
            }
        } catch {
            sniffResp = await sniffWithHeaders();
        }

        if (!sniffResp.ok) {
            if (sniffResp.status === 401 || sniffResp.status === 403) {
                return {
                    ok: false,
                    confidence: 'none',
                    reason: 'unauthorized',
                    statusCode: sniffResp.status,
                    contentType
                };
            }
            return {
                ok: false,
                confidence: 'none',
                reason: `http_${sniffResp.status}`,
                statusCode: sniffResp.status,
                contentType
            };
        }

        const sniffContentType = sniffResp.headers.get('content-type');
        if (!contentType && sniffContentType) {
            contentType = sniffContentType;
        }

        const raw = new Uint8Array(await sniffResp.arrayBuffer());
        const sniff = raw.subarray(0, Math.min(raw.length, PDF_HEADER_CHECK_BYTES));
        const signatureMatch = hasPdfSignature(sniff);
        const contentTypePdf = String(contentType || '').toLowerCase().includes('application/pdf');

        if (signatureMatch) {
            return {
                ok: true,
                confidence: 'definitive',
                reason: 'pdf_header',
                contentType
            };
        }

        if (contentTypePdf) {
            return {
                ok: true,
                confidence: 'strong',
                reason: 'content_type_pdf',
                contentType
            };
        }

        if (isLikelyPdfHint(normalized)) {
            return {
                ok: true,
                confidence: 'weak',
                reason: 'url_hint_only',
                contentType
            };
        }

        return {
            ok: false,
            confidence: 'none',
            reason: 'not_pdf',
            contentType
        };
    } catch (error) {
        return {
            ok: false,
            confidence: 'none',
            reason: `network_error:${parseErrorMessage(error)}`,
            contentType
        };
    }
}

function normalizePdfViewerTitleHint(rawTitle) {
    const cleaned = cleanTitle(rawTitle);
    if (!cleaned) return '';

    const explicitPdf = cleaned.match(/([^|]+?\.pdf)\b/i);
    if (explicitPdf?.[1]) {
        return cleanTitle(explicitPdf[1]);
    }

    return cleanTitle(cleaned.replace(/\s*:\s*\d+\s*$/i, ''));
}

function derivePdfViewerOverlayTitleHint(tabTitle, candidateUrl) {
    const tabHint = normalizePdfViewerTitleHint(tabTitle);
    if (!isGenericPdfTitleHint(tabHint)) {
        return tabHint;
    }

    const urlHint = cleanTitle(extractFilenameHintFromUrl(candidateUrl));
    if (urlHint && !isGenericPdfFilenameHint(urlHint)) {
        return urlHint;
    }

    return tabHint || urlHint || '';
}

async function resolvePdfViewerOverlayContextForTab(tab) {
    if (!tab?.url) {
        return {
            success: true,
            showButton: false,
            candidateUrl: null,
            sourcePageUrl: null,
            titleHint: null,
            reason: 'no_tab_url'
        };
    }

    const viewerSrcUrl = parsePdfViewerSrcFromTabUrl(tab.url);
    const normalizedTabUrl = normalizePdfCandidateUrl(tab.url, tab.url);
    const attempts = [];
    const seen = new Set();
    const tabCandidates = await collectPdfCandidatesFromTab(tab.id);
    const queueAttempt = (url, sourcePageUrl, reason) => {
        const normalized = normalizePdfCandidateUrl(url, tab.url);
        const normalizedSource = normalizePdfCandidateUrl(sourcePageUrl || normalized, tab.url);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        attempts.push({
            url: normalized,
            sourcePageUrl: normalizedSource || normalized,
            reason
        });
    };

    if (viewerSrcUrl) {
        queueAttempt(viewerSrcUrl, viewerSrcUrl, 'viewer_src');
    }

    if (normalizedTabUrl) {
        queueAttempt(normalizedTabUrl, normalizedTabUrl, 'tab_url');
    }

    if (tabCandidates.success) {
        for (const candidate of tabCandidates.candidates) {
            queueAttempt(
                candidate?.url,
                tabCandidates.pageUrl || candidate?.url || normalizedTabUrl || tab.url,
                candidate?.source || 'content_script'
            );
        }
    }

    if (attempts.length === 0) {
        return {
            success: true,
            showButton: false,
            candidateUrl: null,
            sourcePageUrl: null,
            titleHint: null,
            reason: 'unsupported_tab_scheme'
        };
    }

    for (const attempt of attempts) {
        const probe = await probePdfCandidate(attempt.url);
        if (probe.ok && PDF_CONFIDENCE_RANK[probe.confidence] >= PDF_CONFIDENCE_RANK.strong) {
            return {
                success: true,
                showButton: true,
                candidateUrl: attempt.url,
                sourcePageUrl: attempt.sourcePageUrl,
                titleHint: tabCandidates.titleHint || derivePdfViewerOverlayTitleHint(tab.title || '', attempt.url) || null,
                reason: probe.reason || attempt.reason
            };
        }
    }

    const fallback = attempts[0];
    return {
        success: true,
        showButton: false,
        candidateUrl: fallback?.url || null,
        sourcePageUrl: fallback?.sourcePageUrl || null,
        titleHint: fallback ? (tabCandidates.titleHint || derivePdfViewerOverlayTitleHint(tab.title || '', fallback.url) || null) : null,
        reason: 'top_level_not_pdf'
    };
}

async function buildPdfContextForTab(tab) {
    if (!tab?.url) {
        return {
            hasPdf: false,
            confidence: 'none',
            candidateUrl: null,
            sourcePageUrl: null,
            titleHint: null,
            reason: 'no_tab_url'
        };
    }

    const viewerSrcUrl = parsePdfViewerSrcFromTabUrl(tab.url);
    const candidates = [];
    const seen = new Set();

    const addCandidate = (url, source, hintConfidence = 'weak') => {
        const normalized = normalizePdfCandidateUrl(url, tab.url);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push({
            url: normalized,
            source,
            hintConfidence
        });
    };

    if (viewerSrcUrl) {
        addCandidate(viewerSrcUrl, 'viewer_src', 'strong');
    }

    const tabCandidates = await collectPdfCandidatesFromTab(tab.id);
    if (tabCandidates.success) {
        for (const candidate of tabCandidates.candidates) {
            addCandidate(candidate?.url, candidate?.source || 'content_script', candidate?.hintConfidence || 'weak');
        }
    }

    const normalizedTabUrl = normalizePdfCandidateUrl(tab.url, tab.url);
    if (normalizedTabUrl) {
        const hasDirectPdfHint = isLikelyPdfHint(tab.url);
        addCandidate(normalizedTabUrl, 'active_tab_url', hasDirectPdfHint ? 'strong' : 'weak');
    }

    if (candidates.length === 0) {
        return {
            hasPdf: false,
            confidence: 'none',
            candidateUrl: null,
            sourcePageUrl: normalizePdfCandidateUrl(tab.url, tab.url),
            titleHint: tab.title || null,
            reason: 'no_candidate_urls'
        };
    }

    const sourcePageUrl = normalizePdfCandidateUrl(
        tabCandidates.pageUrl || normalizedTabUrl || viewerSrcUrl,
        tab.url
    );

    const prioritized = prioritizePdfCandidates(candidates, sourcePageUrl || tab.url);
    let best = {
        confidence: 'none',
        candidateUrl: prioritized[0]?.url || null,
        reason: 'candidate_not_verified'
    };

    for (const candidate of prioritized.slice(0, 6)) {
        const probe = await probePdfCandidate(candidate.url);
        if (!probe.ok && PDF_CONFIDENCE_RANK[probe.confidence] === 0) {
            continue;
        }

        const probeRank = PDF_CONFIDENCE_RANK[probe.confidence] ?? 0;
        const bestRank = PDF_CONFIDENCE_RANK[best.confidence] ?? 0;
        if (probeRank > bestRank) {
            best = {
                confidence: probe.confidence,
                candidateUrl: candidate.url,
                reason: probe.reason || 'probe_success'
            };
        }

        if (probe.confidence === 'definitive') {
            break;
        }
    }

    if (best.confidence === 'none') {
        const localFileHint = prioritized.find((candidate) => {
            if (!String(candidate?.url || '').startsWith('file:')) return false;
            return isLikelyPdfHint(candidate.url);
        });
        if (localFileHint) {
            best = {
                confidence: 'strong',
                candidateUrl: localFileHint.url,
                reason: 'file_url_hint'
            };
        }
    }

    if (best.confidence === 'none' && prioritized.length > 0) {
        const hintedFallback = prioritized[0];
        const hintedConfidence = String(hintedFallback?.hintConfidence || 'weak').toLowerCase();
        const fallbackConfidence = PDF_CONFIDENCE_RANK[hintedConfidence] > 0 ? hintedConfidence : 'weak';
        best = {
            confidence: fallbackConfidence,
            candidateUrl: hintedFallback.url,
            reason: 'hint_only'
        };
    }

    return {
        hasPdf: PDF_CONFIDENCE_RANK[best.confidence] >= PDF_CONFIDENCE_RANK.strong,
        confidence: best.confidence,
        candidateUrl: best.candidateUrl,
        sourcePageUrl,
        titleHint: tabCandidates.titleHint || tab.title || null,
        reason: best.reason
    };
}

async function downloadAndVerifyPdf(candidateUrl) {
    const normalized = normalizePdfCandidateUrl(candidateUrl);
    if (!normalized) {
        return { ok: false, code: 'invalid_url', message: 'Invalid PDF URL.' };
    }

    let candidateProtocol = '';
    try {
        candidateProtocol = new URL(normalized).protocol;
    } catch {
        candidateProtocol = '';
    }
    const isFileCandidate = candidateProtocol === 'file:';

    try {
        const fetchOptions = {
            method: 'GET',
            redirect: 'follow'
        };
        if (!isFileCandidate) {
            fetchOptions.credentials = 'include';
        }

        const response = await fetch(normalized, fetchOptions);

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return { ok: false, code: 'pdf_access_denied', message: 'Can’t access this PDF from this tab. Open it directly and try again.' };
            }
            if (response.status === 404) {
                return { ok: false, code: 'pdf_not_found', message: 'No PDF detected on this page.' };
            }
            return {
                ok: false,
                code: 'pdf_download_failed',
                message: `PDF download failed (${response.status}).`
            };
        }

        const contentDisposition = response.headers.get('content-disposition') || '';
        const responseUrl = response.url || normalized;
        const filename = extractFilenameFromContentDisposition(contentDisposition)
            || filenameFromUrl(responseUrl)
            || filenameFromUrl(normalized);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0) {
            return { ok: false, code: 'pdf_empty', message: 'Downloaded file is empty.' };
        }
        if (bytes.length > PDF_SEND_MAX_BYTES) {
            return { ok: false, code: 'pdf_too_large', message: 'PDF is too large (25 MB max).' };
        }

        const headerSlice = bytes.subarray(0, Math.min(bytes.length, 2048));
        if (!hasPdfSignature(headerSlice)) {
            return { ok: false, code: 'pdf_invalid_header', message: 'This file is not a valid PDF.' };
        }

        return {
            ok: true,
            bytes,
            filename,
            responseUrl,
            contentType: response.headers.get('content-type') || null
        };
    } catch (error) {
        if (isFileCandidate) {
            return {
                ok: false,
                code: 'file_url_access_required',
                message: 'Enable "Allow access to file URLs" for Lectra Receiver in Extensions settings, then try again.'
            };
        }
        return {
            ok: false,
            code: 'pdf_network_error',
            message: `Network error: ${parseErrorMessage(error)}`
        };
    }
}

function derivePdfTitle({ titleHint, fallbackFilename, sourcePageTitle, candidateUrl, sourceUrl, responseUrl }) {
    const cleanedTitleHint = cleanTitle(titleHint);
    const cleanedFallbackFilename = cleanTitle(fallbackFilename);
    const cleanedSourcePageTitle = cleanTitle(sourcePageTitle);
    const urlFilenameHint = extractFilenameHintFromUrl(responseUrl)
        || extractFilenameHintFromUrl(candidateUrl)
        || extractFilenameHintFromUrl(sourceUrl);

    const preferredFilename = !isGenericPdfFilenameHint(cleanedFallbackFilename)
        ? cleanedFallbackFilename
        : (!isGenericPdfFilenameHint(urlFilenameHint) ? urlFilenameHint : '');

    const preferred = (!isGenericPdfTitleHint(cleanedTitleHint) ? cleanedTitleHint : '')
        || preferredFilename
        || (!isGenericPdfTitleHint(cleanedSourcePageTitle) ? cleanedSourcePageTitle : '');
    if (!preferred) {
        return `Imported PDF ${new Date().toISOString().slice(0, 10)}`;
    }

    return preferred.replace(/\.pdf$/i, '').trim() || preferred;
}

async function wakeLectraForSyncedItem({ syncedItemId, accessToken }) {
    const token = accessToken || await getDropBridgeV2AccessToken();
    if (!token) {
        throw new Error('Missing access token for wake-lectra-v2');
    }

    return callDropBridgeV2Function('wake-lectra-v2', {
        syncedItemId,
        reason: 'synced_item_inserted'
    }, token);
}

async function resolvePdfContextFromMessage({ mode, sender }) {
    const tab = await resolveTargetTabForPdfMode(mode, sender);
    if (!tab) {
        return {
            success: true,
            hasPdf: false,
            confidence: 'none',
            candidateUrl: null,
            sourcePageUrl: null,
            titleHint: null,
            reason: 'no_active_tab'
        };
    }

    const context = await buildPdfContextForTab(tab);
    return {
        success: true,
        hasPdf: context.hasPdf,
        confidence: context.confidence,
        candidateUrl: context.candidateUrl,
        sourcePageUrl: context.sourcePageUrl,
        titleHint: context.titleHint,
        reason: context.reason
    };
}

function hasStrongPdfSendContext(context) {
    const confidence = String(context?.confidence || 'none').toLowerCase();
    return Boolean(context?.hasPdf) && (confidence === 'definitive' || confidence === 'strong');
}

function resolvePdfSendRequestPayload({ liveContext, fallbackCandidateUrl, fallbackSourcePageUrl, fallbackTitleHint }) {
    const liveCandidateUrl = normalizePdfCandidateUrl(
        liveContext?.candidateUrl,
        liveContext?.sourcePageUrl || fallbackSourcePageUrl || undefined
    );
    const liveSourcePageUrl = normalizePdfCandidateUrl(
        liveContext?.sourcePageUrl || liveCandidateUrl,
        liveCandidateUrl || fallbackSourcePageUrl || undefined
    );
    const liveTitleHint = cleanTitle(liveContext?.titleHint || '');

    if (hasStrongPdfSendContext(liveContext) && liveCandidateUrl) {
        return {
            candidateUrl: liveCandidateUrl,
            sourcePageUrl: liveSourcePageUrl || liveCandidateUrl,
            titleHint: liveTitleHint || cleanTitle(fallbackTitleHint || '') || null,
            source: 'live_context'
        };
    }

    const fallbackCandidate = normalizePdfCandidateUrl(
        fallbackCandidateUrl,
        fallbackSourcePageUrl || liveSourcePageUrl || undefined
    );
    const fallbackSource = normalizePdfCandidateUrl(
        fallbackSourcePageUrl || fallbackCandidate,
        fallbackCandidate || liveSourcePageUrl || undefined
    );
    const fallbackTitle = cleanTitle(fallbackTitleHint || '');

    return {
        candidateUrl: fallbackCandidate || liveCandidateUrl || null,
        sourcePageUrl: fallbackSource || liveSourcePageUrl || fallbackCandidate || liveCandidateUrl || null,
        titleHint: fallbackTitle || liveTitleHint || null,
        source: fallbackCandidate ? 'fallback_message' : 'unresolved'
    };
}

async function sendPdfToLectraFromMessage({ trigger, candidateUrl, sourcePageUrl, titleHint, sender }) {
    const extensionSettings = await getExtensionSettings();
    if (!extensionSettings.enableSendToLectra) {
        return {
            success: false,
            code: 'feature_disabled',
            message: 'Turn on Lectra to send PDFs.'
        };
    }

    if (!supabaseClient) {
        return {
            success: false,
            code: 'supabase_unavailable',
            message: 'Sync unavailable right now.'
        };
    }

    const activeMode = sender?.tab ? 'sender_tab' : 'active_tab';
    const context = await resolvePdfContextFromMessage({ mode: activeMode, sender });
    const resolvedRequest = resolvePdfSendRequestPayload({
        liveContext: context,
        fallbackCandidateUrl: candidateUrl,
        fallbackSourcePageUrl: sourcePageUrl,
        fallbackTitleHint: titleHint
    });
    const resolvedCandidateUrl = resolvedRequest.candidateUrl;
    const resolvedSourceUrl = resolvedRequest.sourcePageUrl;

    if (!resolvedCandidateUrl || (resolvedRequest.source === 'unresolved' && !hasStrongPdfSendContext(context))) {
        return {
            success: false,
            code: 'no_pdf_detected',
            message: 'No PDF detected on this page.'
        };
    }

    const inFlightKey = `${sender?.tab?.id || 'active'}:${resolvedCandidateUrl}`;
    if (pdfSendInFlightKeys.has(inFlightKey)) {
        return {
            success: false,
            code: 'send_in_progress',
            message: 'A send is already in progress for this PDF.'
        };
    }
    pdfSendInFlightKeys.add(inFlightKey);

    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError) {
            return {
                success: false,
                code: 'auth_error',
                message: sessionError.message || 'Sign in to send PDFs to Lectra.'
            };
        }

        if (!session?.user?.id) {
            return {
                success: false,
                code: 'not_signed_in',
                message: 'Sign in to send PDFs to Lectra.'
            };
        }

        const attemptUrls = [];
        const seenAttemptUrls = new Set();
        const queueAttempt = (url) => {
            const normalized = normalizePdfCandidateUrl(url, resolvedSourceUrl || resolvedCandidateUrl);
            if (!normalized || seenAttemptUrls.has(normalized)) return;
            seenAttemptUrls.add(normalized);
            attemptUrls.push(normalized);
        };

        queueAttempt(resolvedCandidateUrl);
        for (const variant of deriveDownloadUrlVariants(resolvedCandidateUrl || '')) {
            queueAttempt(variant);
        }

        let downloaded = null;
        let selectedCandidateUrl = resolvedCandidateUrl;
        for (const attemptUrl of attemptUrls) {
            const attempt = await downloadAndVerifyPdf(attemptUrl);
            if (attempt.ok) {
                downloaded = attempt;
                selectedCandidateUrl = attemptUrl;
                break;
            }
            downloaded = attempt;
        }

        if (!downloaded?.ok) {
            return {
                success: false,
                code: downloaded?.code || 'pdf_download_failed',
                message: downloaded?.message || 'Failed to download PDF.'
            };
        }

        const rowId = generateUuidV4();
        const storagePath = buildPdfStoragePath(session.user.id, rowId);
        const uploadData = downloaded.bytes.buffer.slice(
            downloaded.bytes.byteOffset,
            downloaded.bytes.byteOffset + downloaded.bytes.byteLength
        );

        const { error: uploadError } = await supabaseClient.storage
            .from(LECTRA_DOCUMENTS_BUCKET)
            .upload(storagePath, uploadData, {
                contentType: 'application/pdf',
                upsert: false
            });

        if (uploadError) {
            const uploadMessage = String(uploadError.message || '');
            const bucketMissing = /bucket\s+not\s+found/i.test(uploadMessage);
            console.warn('[Lectra Send] Upload failed', {
                candidateUrl: selectedCandidateUrl,
                storagePath,
                error: uploadError
            });
            return {
                success: false,
                code: bucketMissing ? 'storage_bucket_missing' : 'upload_failed',
                message: bucketMissing
                    ? `Upload failed: storage bucket "${LECTRA_DOCUMENTS_BUCKET}" is missing.`
                    : (uploadError.message ? `Upload failed: ${uploadError.message}` : 'Upload failed. Please retry.')
            };
        }

        const sourceForCourse = resolvedSourceUrl || selectedCandidateUrl;
        const resolvedTitle = derivePdfTitle({
            titleHint: resolvedRequest.titleHint || context.titleHint,
            fallbackFilename: downloaded.filename,
            sourcePageTitle: context.titleHint,
            candidateUrl: selectedCandidateUrl,
            sourceUrl: sourceForCourse,
            responseUrl: downloaded.responseUrl
        });

        const rowPayload = {
            id: rowId,
            user_id: session.user.id,
            item_type: 'pdf_document',
            item_data: {
                title: resolvedTitle,
                courseId: null,
                sourceUrl: sourceForCourse || null,
                storagePath,
                annotatedStoragePath: null,
                status: 'pending_annotation',
                sourcePlatform: 'canvascope_extension',
                sourceKind: 'canvas_pdf_import'
            },
            sync_status: 'synced'
        };

        const { error: insertError } = await supabaseClient
            .from('synced_items')
            .insert(rowPayload);

        if (insertError) {
            console.warn('[Lectra Send] Row insert failed', {
                candidateUrl: selectedCandidateUrl,
                storagePath,
                error: insertError
            });
            await supabaseClient.storage
                .from(LECTRA_DOCUMENTS_BUCKET)
                .remove([storagePath])
                .catch(() => {
                    // Best effort cleanup only.
                });

            return {
                success: false,
                code: 'row_insert_failed',
                message: insertError.message ? `Uploaded, but failed to register in Lectra: ${insertError.message}` : 'Uploaded, but failed to register in Lectra. Retry send.'
            };
        }

        void wakeLectraForSyncedItem({
            syncedItemId: rowId,
            accessToken: session.access_token || null
        }).catch((error) => {
            console.warn('[Lectra Send] Wake hint failed', {
                rowId,
                error: parseErrorMessage(error)
            });
        });

        console.log('[Lectra Send] Sent PDF to Lectra', {
            trigger: trigger || 'unknown',
            rowId,
            storagePath,
            bytes: downloaded.bytes.byteLength
        });

        return {
            success: true,
            code: 'ok',
            message: 'Sent to Lectra ✓',
            rowId,
            storagePath,
            bytesUploaded: downloaded.bytes.byteLength,
            itemType: 'pdf_document'
        };
    } finally {
        pdfSendInFlightKeys.delete(inFlightKey);
    }
}

// ============================================
// PDF VIEWER OVERLAY REGISTRATION (send button on any PDF page)
// ============================================

async function getPdfViewerOverlayRegistrationMatches() {
    const matches = [...PDF_VIEWER_OVERLAY_WEBSITE_ORIGINS];
    const fileAccessAllowed = await getAllowedFileSchemeAccess();
    if (fileAccessAllowed) {
        matches.push(PDF_VIEWER_OVERLAY_FILE_MATCH);
    }
    return matches;
}

async function unregisterPdfViewerOverlayContentScript() {
    try {
        await chrome.scripting.unregisterContentScripts({
            ids: [PDF_VIEWER_OVERLAY_CONTENT_SCRIPT_ID]
        });
    } catch (error) {
        const message = parseErrorMessage(error);
        if (!/nonexistent|unknown|not found/i.test(message)) {
            console.warn('[Lectra PDF Viewer] Failed to unregister overlay content script:', message);
        }
    }
}

async function injectPdfViewerOverlayIntoOpenTabs(reason = 'manual', matches = []) {
    const allowFile = matches.includes(PDF_VIEWER_OVERLAY_FILE_MATCH);
    const tabs = await chrome.tabs.query({});
    const injections = tabs
        .map(async (tab) => {
            try {
                if (!Number.isFinite(tab?.id) || !isTabUrlEligibleForPdfViewerOverlay(tab?.url)) {
                    return;
                }

                const protocol = new URL(tab.url).protocol;
                if (protocol === 'file:' && !allowFile) {
                    return;
                }

                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['src/content/pdf-viewer-content.js']
                });
            } catch (error) {
                const message = parseErrorMessage(error);
                if (!/cannot access|missing host permission|cannot be scripted|frame with id 0 was removed/i.test(message.toLowerCase())) {
                    console.warn('[Lectra PDF Viewer] Failed to inject overlay into tab', {
                        reason,
                        tabId: tab.id,
                        error: message
                    });
                }
            }
        });

    await Promise.all(injections);
}

async function syncPdfViewerOverlayRegistration(reason = 'manual') {
    const settings = await getExtensionSettings();
    if (!settings.enableSendToLectra) {
        await unregisterPdfViewerOverlayContentScript();
        return {
            success: true,
            enabled: false,
            matches: [],
            reason: 'feature_disabled'
        };
    }

    const matches = await getPdfViewerOverlayRegistrationMatches();
    if (matches.length === 0) {
        await unregisterPdfViewerOverlayContentScript();
        return {
            success: true,
            enabled: false,
            matches: [],
            reason: 'no_registration_matches'
        };
    }

    await unregisterPdfViewerOverlayContentScript();
    await chrome.scripting.registerContentScripts([{
        id: PDF_VIEWER_OVERLAY_CONTENT_SCRIPT_ID,
        js: ['src/content/pdf-viewer-content.js'],
        matches,
        excludeMatches: STATIC_LMS_CONTENT_SCRIPT_MATCHES,
        runAt: 'document_idle',
        persistAcrossSessions: true
    }]);
    await injectPdfViewerOverlayIntoOpenTabs(reason, matches);

    return {
        success: true,
        enabled: true,
        matches,
        reason
    };
}

// ============================================
// LECTRA LIBRARY (read) — Gradescope "Select from Lectra" picker
// ============================================

/** List the user's Lectra PDF documents for the picker. */
async function listLectraDocumentsForPicker() {
    if (!await isSendToLectraFeatureEnabled()) {
        return { success: false, code: 'feature_disabled', message: 'Turn on Lectra first.' };
    }

    if (!supabaseClient) {
        return { success: false, message: 'Sync unavailable right now.' };
    }
    const userId = await getSignedInUserId();
    if (!userId) {
        return { success: false, message: 'Sign in to use your Lectra library.' };
    }

    const { data, error } = await supabaseClient
        .from('synced_items')
        .select('id,item_data,updated_at,created_at')
        .eq('user_id', userId)
        .eq('item_type', 'pdf_document')
        .order('updated_at', { ascending: false })
        .limit(300);

    if (error) {
        return { success: false, message: error.message || 'Failed to load documents.' };
    }

    const documents = (data || []).map((row) => {
        const d = row.item_data || {};
        return {
            id: row.id,
            title: d.title || 'Untitled PDF',
            course: d.courseName || (d.courseId != null ? `Course ${d.courseId}` : ''),
            folderPath: d.folderPath || '',
            hasAnnotated: Boolean(d.annotatedStoragePath),
            updatedAt: row.updated_at || row.created_at || ''
        };
    });

    // iPad live-presence shortcut (phased). When the Lectra iPad app broadcasts
    // its currently-open document, the relay stores it here; until then null.
    let currentIpadDocId = null;
    try {
        const stored = await chrome.storage.local.get(['lectraIpadPresence']);
        const presence = stored?.lectraIpadPresence;
        if (presence && presence.currentDocId && documents.some((doc) => doc.id === presence.currentDocId)) {
            currentIpadDocId = presence.currentDocId;
        }
    } catch (_) { /* ignore */ }

    return { success: true, documents, currentIpadDocId };
}

/** Resolve a short-lived signed URL for a Lectra doc (annotated-else-original). */
async function resolveLectraDocumentSignedUrl(documentId) {
    if (!await isSendToLectraFeatureEnabled()) {
        return { success: false, code: 'feature_disabled', message: 'Turn on Lectra first.' };
    }

    if (!supabaseClient) {
        return { success: false, message: 'Sync unavailable right now.' };
    }
    const userId = await getSignedInUserId();
    if (!userId) {
        return { success: false, message: 'Sign in to open documents.' };
    }

    const { data: row, error } = await supabaseClient
        .from('synced_items')
        .select('id,item_data')
        .eq('user_id', userId)
        .eq('id', documentId)
        .single();

    if (error || !row) {
        return { success: false, message: error?.message || 'Document not found.' };
    }

    const d = row.item_data || {};
    const path = d.annotatedStoragePath || d.storagePath;
    if (!path) {
        return { success: false, message: 'This document has no stored file.' };
    }

    const { data: signed, error: signError } = await supabaseClient.storage
        .from(LECTRA_DOCUMENTS_BUCKET)
        .createSignedUrl(path, 60);

    if (signError || !signed?.signedUrl) {
        return { success: false, message: signError?.message || 'Could not generate a download link.' };
    }

    const filename = sanitizeFilename(d.title || 'lectra-document');
    return {
        success: true,
        signedUrl: signed.signedUrl,
        filename: /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`
    };
}

// ============================================
// MESSAGE ROUTER
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;

    // ---- Auth (message.type) ----
    if (message.type === 'signInWithGoogle') {
        (async () => {
            try {
                const redirectUrl = chrome.identity.getRedirectURL();
                console.log('[Lectra Auth] Starting Google OAuth flow. Redirect URL:', redirectUrl);

                const { data, error } = await supabaseClient.auth.signInWithOAuth({
                    provider: 'google',
                    options: {
                        redirectTo: redirectUrl,
                        queryParams: {
                            access_type: 'offline',
                            prompt: 'consent',
                            scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile'
                        },
                        skipBrowserRedirect: true
                    }
                });

                if (error) {
                    console.error('[Lectra Auth] Supabase OAuth error:', error);
                    sendResponse({ success: false, error: error.message });
                    return;
                }

                if (!data || !data.url) {
                    throw new Error('No OAuth URL returned from Supabase');
                }

                chrome.identity.launchWebAuthFlow(
                    { url: data.url, interactive: true },
                    (callbackUrl) => {
                        if (chrome.runtime.lastError) {
                            console.error('[Lectra Auth] launchWebAuthFlow error:', chrome.runtime.lastError);
                            sendResponse({ success: false, error: chrome.runtime.lastError.message });
                            return;
                        }

                        if (!callbackUrl) {
                            sendResponse({ success: false, error: 'No callback URL received' });
                            return;
                        }

                        try {
                            const url = new URL(callbackUrl);
                            const hashParams = new URLSearchParams(url.hash.substring(1));

                            if (hashParams.has('error_description')) {
                                console.error('[Lectra Auth] OAuth error:', hashParams.get('error_description'));
                                sendResponse({ success: false, error: hashParams.get('error_description') });
                                return;
                            }

                            const accessToken = hashParams.get('access_token');
                            const refreshToken = hashParams.get('refresh_token');

                            if (accessToken && refreshToken) {
                                supabaseClient.auth.setSession({
                                    access_token: accessToken,
                                    refresh_token: refreshToken
                                }).then(async ({ error: sessionError }) => {
                                    if (sessionError) {
                                        console.error('[Lectra Auth] Error setting session:', sessionError);
                                        sendResponse({ success: false, error: sessionError.message });
                                    } else {
                                        console.log('[Lectra Auth] Successfully authenticated!');
                                        const { data: { session } } = await supabaseClient.auth.getSession();
                                        await persistAuthStatusSnapshot(session || null);
                                        startDropBridgeV2Loop('post-login').catch((err) => {
                                            console.error('[DropBridge v2] Post-login bootstrap failure:', parseErrorMessage(err));
                                        });
                                        sendResponse({ success: true });
                                    }
                                });
                            } else {
                                sendResponse({ success: false, error: 'Tokens missing from callback' });
                            }
                        } catch (parseErr) {
                            console.error('[Lectra Auth] Error parsing callback URL:', parseErr);
                            sendResponse({ success: false, error: parseErr.message });
                        }
                    }
                );
            } catch (err) {
                console.error('[Lectra Auth] Unhandled error during sign in:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === 'checkAuthStatus') {
        (async () => {
            const status = await resolveAuthStatus();
            sendResponse({
                signedIn: Boolean(status?.signedIn),
                user: status?.user || null
            });
        })();
        return true;
    }

    if (message.type === 'getSupabaseSession') {
        (async () => {
            try {
                const accessToken = await getSupabaseAccessToken();
                sendResponse({ success: true, accessToken });
            } catch (err) {
                console.error('[Lectra Auth] Error getting Supabase access token:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === 'signOut') {
        (async () => {
            try {
                const { error } = await supabaseClient.auth.signOut();
                if (error) throw error;
                stopDropBridgeV2Loop();
                sendResponse({ success: true });
            } catch (err) {
                console.error('[Lectra Auth] Error signing out:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === 'getLectraStatus') {
        (async () => {
            try {
                const [authStatus, settings, dropBridge] = await Promise.all([
                    resolveAuthStatus(),
                    getExtensionSettings(),
                    buildDropBridgeV2PopupStatus()
                ]);
                sendResponse({
                    success: true,
                    signedIn: Boolean(authStatus?.signedIn),
                    user: authStatus?.user || null,
                    enabled: Boolean(settings.enableSendToLectra),
                    dropBridge
                });
            } catch (error) {
                sendResponse({ success: false, error: parseErrorMessage(error) });
            }
        })();
        return true;
    }

    // ---- Content-script settings fetch ----
    if (message.action === 'getExtensionSettings') {
        getExtensionSettings().then(settings => {
            sendResponse({ settings });
        }).catch(() => {
            sendResponse({ settings: DEFAULT_EXTENSION_SETTINGS });
        });
        return true;
    }

    // ---- Send to Lectra ----
    if (message.action === 'resolvePdfContext') {
        (async () => {
            try {
                const mode = message.mode === 'sender_tab' ? 'sender_tab' : 'active_tab';
                const payload = await resolvePdfContextFromMessage({ mode, sender });
                sendResponse(payload);
            } catch (error) {
                sendResponse({
                    success: false,
                    hasPdf: false,
                    confidence: 'none',
                    candidateUrl: null,
                    sourcePageUrl: null,
                    titleHint: null,
                    reason: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'resolvePdfViewerOverlayContext') {
        (async () => {
            try {
                const tab = sender?.tab
                    ? sender.tab
                    : await resolveTargetTabForPdfMode('active_tab', sender);
                const payload = await resolvePdfViewerOverlayContextForTab(tab);
                sendResponse(payload);
            } catch (error) {
                sendResponse({
                    success: false,
                    showButton: false,
                    candidateUrl: null,
                    sourcePageUrl: null,
                    titleHint: null,
                    reason: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'syncPdfViewerOverlayRegistration') {
        (async () => {
            try {
                const payload = await syncPdfViewerOverlayRegistration(message.reason || 'message');
                sendResponse(payload);
            } catch (error) {
                sendResponse({
                    success: false,
                    enabled: false,
                    matches: [],
                    reason: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'sendPdfToLectra') {
        (async () => {
            try {
                const result = await sendPdfToLectraFromMessage({
                    trigger: message.trigger || 'unknown',
                    candidateUrl: message.candidateUrl || null,
                    sourcePageUrl: message.sourcePageUrl || null,
                    titleHint: message.titleHint || null,
                    sender
                });
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    success: false,
                    code: 'unexpected_error',
                    message: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    // ---- Select from Lectra (Gradescope picker) ----
    if (message.action === 'listLectraDocuments') {
        listLectraDocumentsForPicker()
            .then(sendResponse)
            .catch((error) => sendResponse({ success: false, message: parseErrorMessage(error) }));
        return true;
    }

    if (message.action === 'fetchLectraDocumentBytes') {
        resolveLectraDocumentSignedUrl(message.documentId)
            .then(sendResponse)
            .catch((error) => sendResponse({ success: false, message: parseErrorMessage(error) }));
        return true;
    }

    // ---- Receive from Lectra (DropBridge V2 offscreen receiver) ----
    if (message.action === 'dropbridgeGetReceiverContext') {
        (async () => {
            try {
                const payload = await buildDropBridgeV2ReceiverContext();
                sendResponse(payload);
            } catch (error) {
                sendResponse({
                    success: false,
                    enabled: DROPBRIDGE_V2_ENABLED,
                    signedIn: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'dropbridgeReceiverWake') {
        (async () => {
            try {
                const wakeReason = String(message.reason || 'offscreen');
                const topic = message.topic ? String(message.topic) : null;
                const uploadId = message.uploadId ? String(message.uploadId) : null;
                const realtimeReceivedAt = message.realtimeReceivedAt ? String(message.realtimeReceivedAt) : new Date().toISOString();
                const wakeUpload = message.upload && typeof message.upload === 'object' ? message.upload : {};
                const rawWakeSizeBytes = wakeUpload.sizeBytes;
                const wakeSizeBytes = rawWakeSizeBytes === null || rawWakeSizeBytes === undefined || rawWakeSizeBytes === ''
                    ? null
                    : Number(rawWakeSizeBytes);
                const normalizedWakeSizeBytes = Number.isFinite(wakeSizeBytes) ? wakeSizeBytes : null;
                void updateDropBridgeV2Diagnostics({
                    lastWakeAt: realtimeReceivedAt,
                    lastWakeReason: wakeReason,
                    lastWakeTopic: topic,
                    lastWakeUploadId: uploadId,
                    lastWakeFileName: wakeUpload.fileName ? String(wakeUpload.fileName) : null,
                    lastWakeSizeBytes: normalizedWakeSizeBytes,
                    lastWakeMimeType: wakeUpload.mimeType ? String(wakeUpload.mimeType) : null,
                    lastWakeCreatedAt: wakeUpload.createdAt ? String(wakeUpload.createdAt) : null,
                    lastTransferStage: 'queued',
                    lastTransferUploadId: uploadId,
                    lastTransferFileName: wakeUpload.fileName ? String(wakeUpload.fileName) : null,
                    lastTransferAt: realtimeReceivedAt
                }, {
                    type: 'transfer_progress',
                    stage: 'queued',
                    reason: wakeReason,
                    topic,
                    uploadId,
                    fileName: wakeUpload.fileName ? String(wakeUpload.fileName) : null,
                    sizeBytes: normalizedWakeSizeBytes
                });
                let handledByTargetedClaim = false;
                if (uploadId) {
                    handledByTargetedClaim = await tryClaimAndProcessDropBridgeV2UploadById({
                        uploadId,
                        reason: `offscreen-${wakeReason}`
                    });
                }

                if (!handledByTargetedClaim) {
                    await requestDropBridgeV2Poll(`offscreen-${wakeReason}`);
                }
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'dropbridgeReceiverStatus') {
        (async () => {
            try {
                const status = String(message.status || 'unknown').toLowerCase();
                const reason = message.reason ? String(message.reason) : null;
                const patch = {
                    receiverStatus: status,
                    receiverStatusAt: new Date().toISOString(),
                    receiverTopic: message.topic ? String(message.topic) : null,
                    receiverError: message.error ? String(message.error) : (status === 'subscribed' ? null : undefined)
                };
                if (status === 'subscribed') {
                    patch.receiverSubscribedAt = patch.receiverStatusAt;
                }
                await updateDropBridgeV2Diagnostics(patch, {
                    type: 'receiver_status',
                    status,
                    reason,
                    topic: patch.receiverTopic,
                    error: message.error ? String(message.error) : null
                });

                if (shouldRestartDropBridgeReceiverFromStatus(status, reason)) {
                    void ensureDropBridgeV2LoopWarm(`receiver-status-${status}`, {
                        force: true,
                        restart: true
                    }).catch((error) => {
                        console.warn('[DropBridge v2] Receiver restart after status failed:', parseErrorMessage(error));
                    });
                }
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'ensureDropBridgeReceiver') {
        (async () => {
            try {
                const reason = String(message.reason || 'manual-warmup');
                const result = await ensureDropBridgeV2LoopWarm(reason, {
                    force: Boolean(message.force),
                    restart: Boolean(message.restart)
                });
                sendResponse({
                    success: true,
                    ...result
                });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    return undefined;
});

// ============================================
// LIFECYCLE WIRING
// ============================================

chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Lectra] Extension event:', details.reason);

    if (details.reason === 'install') {
        chrome.storage.local.set({
            settings: {
                ...DEFAULT_EXTENSION_SETTINGS,
                version: chrome.runtime.getManifest().version,
                installedAt: new Date().toISOString()
            }
        });
    }

    ensureAuthRefreshAlarm();

    syncPdfViewerOverlayRegistration(`runtime-installed-${details.reason}`).catch((error) => {
        console.warn('[Lectra PDF Viewer] Failed to sync overlay registration on install:', parseErrorMessage(error));
    });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings) return;
    syncPdfViewerOverlayRegistration('settings-changed').catch((error) => {
        console.warn('[Lectra PDF Viewer] Failed to sync overlay registration after settings change:', parseErrorMessage(error));
    });
    const nextSettings = normalizeExtensionSettings(changes.settings.newValue);
    if (nextSettings.enableSendToLectra) {
        ensureDropBridgeV2LoopWarm('settings-changed').catch((error) => {
            console.warn('[DropBridge v2] Settings-change warmup failed:', parseErrorMessage(error));
        });
    } else {
        stopDropBridgeV2Loop();
    }
});

chrome.permissions.onAdded.addListener(() => {
    syncPdfViewerOverlayRegistration('permissions-added').catch((error) => {
        console.warn('[Lectra PDF Viewer] Failed to sync overlay registration after permission grant:', parseErrorMessage(error));
    });
});

chrome.permissions.onRemoved.addListener(() => {
    syncPdfViewerOverlayRegistration('permissions-removed').catch((error) => {
        console.warn('[Lectra PDF Viewer] Failed to sync overlay registration after permission removal:', parseErrorMessage(error));
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTH_REFRESH_ALARM_NAME) {
        ensureFreshAuthSession('alarm').catch((error) => {
            console.warn('[Lectra Auth] Alarm-triggered refresh failed:', parseErrorMessage(error));
        });
    }
    if (alarm.name === DROPBRIDGE_V2_FALLBACK_ALARM_NAME) {
        requestDropBridgeV2Poll('alarm').catch((error) => {
            console.error('[DropBridge v2] Alarm-triggered poll failure:', parseErrorMessage(error));
        });
    }
    if (alarm.name === DROPBRIDGE_V2_HEARTBEAT_ALARM_NAME) {
        heartbeatDropBridgeV2Device('alarm').catch((error) => {
            console.error('[DropBridge v2] Alarm-triggered heartbeat failure:', parseErrorMessage(error));
        });
    }
});

chrome.runtime.onStartup.addListener(() => {
    ensureAuthRefreshAlarm();
    ensureFreshAuthSession('runtime-startup').catch((error) => {
        console.warn('[Lectra Auth] Runtime startup refresh failed:', parseErrorMessage(error));
    });
    bootstrapDropBridgeV2FromWorkerStart('runtime-startup').catch((error) => {
        console.error('[DropBridge v2] Runtime startup failure:', parseErrorMessage(error));
    });
    syncPdfViewerOverlayRegistration('runtime-startup').catch((error) => {
        console.warn('[Lectra PDF Viewer] Failed to sync overlay registration on startup:', parseErrorMessage(error));
    });
});

// Immediate service-worker bootstrap.
ensureAuthRefreshAlarm();
ensureFreshAuthSession('service-worker-start').catch((error) => {
    console.warn('[Lectra Auth] Service worker start refresh failed:', parseErrorMessage(error));
});
bootstrapDropBridgeV2FromWorkerStart('service-worker-start').catch((error) => {
    console.error('[DropBridge v2] Service worker bootstrap failure:', parseErrorMessage(error));
});
syncPdfViewerOverlayRegistration('service-worker-start').catch((error) => {
    console.warn('[Lectra PDF Viewer] Failed to sync overlay registration on worker start:', parseErrorMessage(error));
});
