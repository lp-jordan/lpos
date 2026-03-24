# LPOS Runtime Dependencies

LPOS is the deployment and recovery owner for production pipeline runtime.

## LPOS-Owned Runtime Directories

- `runtime/whisper-runtime`
  - Whisper executable and required shared libraries
  - Override with `LPOS_WHISPER_BINARY` or `LPOS_WHISPER_RUNTIME_DIR`
- `runtime/whisper-models`
  - Whisper model files such as `ggml-base.bin`
  - Override with `LPOS_WHISPER_MODEL_DIR`
- `runtime/atem-bridge`
  - `atem-bridge.js` or `atem-bridge.exe`
  - Override with `ATEM_BRIDGE_DIR`

## External But Explicit

- Frame.io credentials
  - configure through environment variables before publish flows
- Cloudflare Stream credentials
  - configure through environment variables before stream publish flows
- Storage roots and mounts
  - default root is `data/`
  - override with `LPOS_STORAGE_ROOT`

## Staging External Assets Into LPOS

LPOS can stage externally provisioned assets into its own runtime tree:

```bash
LPOS_STAGE_WHISPER_RUNTIME_FROM=/path/to/whisper-runtime \
LPOS_STAGE_WHISPER_MODELS_FROM=/path/to/whisper-models \
LPOS_STAGE_ATEM_BRIDGE_FROM=/path/to/atem-bridge \
npm run prepare:runtime
```

Supported staging environment variables:

- `LPOS_STAGE_WHISPER_RUNTIME_FROM`
- `LPOS_STAGE_WHISPER_MODELS_FROM`
- `LPOS_STAGE_ATEM_BRIDGE_FROM`

## Validation

- `GET /api/services` now returns both service registry state and a runtime dependency report.
- Required runtime dependencies are warned during LPOS startup if they are not available.
