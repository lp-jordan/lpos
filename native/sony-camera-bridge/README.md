# Sony Camera Bridge

This is the local Windows bridge process that LPOS starts in `sony-sdk` mode.

## In simple terms

We are building a small native `.exe` that sits between LPOS and Sony's Camera Remote SDK.

Flow:

1. LPOS starts.
2. LPOS launches `sony-camera-bridge.exe`.
3. LPOS talks to the bridge over `http://127.0.0.1:6107`.
4. The bridge talks to Sony's Camera Remote SDK.
5. Sony's SDK talks to the FX6 / FX3 cameras.

Why we need it:

- LPOS is a Node/Next app.
- Sony's Camera Remote SDK is a native C++ SDK.
- The bridge is the translator between those two worlds.

## What it does today

- Starts an HTTP server on `127.0.0.1:6107`
- Initializes Sony's Camera Remote SDK on startup
- Connects to FX6 / FX3 cameras over Ethernet by host IP
- Implements:
  - `GET /health`
  - `POST /camera/capabilities`
  - `GET /camera/status`
  - `POST /camera/record/start`
  - `POST /camera/record/stop`
  - `GET /camera/settings/white-balance/options`
  - `POST /camera/settings/white-balance`
  - `GET /camera/settings/iso/options`
  - `POST /camera/settings/iso`
  - `GET /camera/liveview`

The bridge currently focuses on the LPOS feature set we already use: status, record control, white balance, ISO, and liveview.

## Expected runtime output

The binary is written to:

- `vendor/sony-camera-bridge/win-x64/sony-camera-bridge.exe`

The Sony SDK runtime DLLs are copied next to it from:

- `vendor/sony-camera-sdk/RemoteCli/external/crsdk`

## Build

Run the helper script:

- `scripts/build-sony-camera-bridge.cmd`

## Next implementation steps

1. Expand session management from one-on-demand camera session to a first-class multi-camera registry for 4-up monitoring.
2. Add richer status fields from the SDK as we verify the exact FX6 / FX3 property mappings.
3. Replace the temporary `camera/rpc` `501` response with a small compatibility shim only if LPOS still needs it.
