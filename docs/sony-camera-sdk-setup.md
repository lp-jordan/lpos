# Sony FX6 / FX3 Camera SDK Setup

LPOS now targets Sony's official Camera Remote SDK flow for Sony FX6 and FX3 cameras.

Official Sony references:

- Camera Remote SDK: https://support.d-imaging.sony.co.jp/app/sdk/en/index.html
- Sony lists `ILME-FX6V/ILME-FX6T` and `ILME-FX3/ILME-FX3A` as supported models on that page.
- Sony's older Camera Remote API beta SDK is discontinued: https://developer.sony.com/file/download/sony-camera-remote-api-beta-sdk-2

## LPOS Architecture

LPOS no longer assumes that the camera exposes the legacy `/sony/camera` JSON-RPC endpoint.

Instead:

1. The LPOS UI talks to `/api/studio/camera/*`.
2. LPOS routes call `CameraControlService`.
3. `CameraControlService` selects a provider:
   - `sony-sdk` (default)
   - `sony-camera-api` (legacy fallback)
4. In `sony-sdk` mode, LPOS talks to a local Sony bridge process over HTTP.

## Expected Bridge

The local bridge is expected to expose these endpoints on the configured base URL
(default: `http://127.0.0.1:6107`):

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
- `POST /camera/rpc`

Request body fields LPOS sends:

- `host`
- `model`
- optional command payload such as `mode`, `iso`, `method`, or `params`

## Default LPOS Config

Stored in `data/studio-config.json`:

```json
{
  "camera": {
    "provider": "sony-sdk",
    "model": "fx6",
    "host": "",
    "ip": "",
    "port": 10000,
    "sdkBridge": {
      "baseUrl": "http://127.0.0.1:6107",
      "executablePath": "C:\\lp-app-ecosystem\\lpos-dashboard\\vendor\\sony-camera-bridge\\win-x64\\sony-camera-bridge.exe",
      "autoStart": true,
      "startupTimeoutMs": 8000,
      "args": []
    }
  }
}
```

Notes:

- `port` remains in the config only for the legacy provider.
- `host` is the FX6/FX3 IP or hostname on the local network.
- LPOS mirrors `host` into the older `ip` field for backward compatibility.

## Workstation Setup

1. Apply for and download Sony's Camera Remote SDK from Sony.
2. Build a local bridge executable against Sony's SDK.
3. Place the bridge at:
   - `vendor/sony-camera-bridge/win-x64/sony-camera-bridge.exe`
   - or update `camera.sdkBridge.executablePath` in `data/studio-config.json`
4. Start LPOS.
5. In the Camera panel:
   - Provider: `Sony SDK`
   - Model: `FX6` or `FX3`
   - Host: camera IP
6. Connect the camera.

If `autoStart` is `true`, LPOS will try to launch the bridge automatically.

## Legacy Fallback

If you need the older experimental path temporarily, switch:

- `camera.provider` to `sony-camera-api`

That restores the old `http://{ip}:{port}/sony/camera` flow and uses the configured port.
