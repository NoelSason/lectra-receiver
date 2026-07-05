# Lectra Receiver

Standalone Chrome extension for Lectra browser workflows:

- Send PDFs from any browser PDF page to Lectra.
- Receive files pushed back from the Lectra iPad app through DropBridge V2.
- Attach PDFs from Lectra on Gradescope upload forms.

This repo contains only the Lectra browser send, receive, and attach workflows.

## Load Locally

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click **Load unpacked** and select this folder: `/Users/noelsason/Desktop/lectra-receiver`.
4. In the popup, sign in with Google and turn on Lectra tools.

## Backend Redirect

This unpacked extension uses a fixed manifest key, so its extension ID is:

```text
ahdmecpcieeomjfbbcabadejdegkhcme
```

Add this redirect URL to Supabase Auth Redirect URLs before Google sign-in:

```text
https://ahdmecpcieeomjfbbcabadejdegkhcme.chromiumapp.org/
```

A wildcard such as `https://*.chromiumapp.org/*` also covers it.

## Verification

- Open any PDF page and confirm the floating **Send to Lectra** button appears when the toggle is on.
- Send a PDF and confirm it appears in Lectra.
- Push a file from the Lectra iPad app and confirm Chrome downloads it.
- Open a Gradescope upload modal and confirm **Select from Lectra** attaches a PDF.
