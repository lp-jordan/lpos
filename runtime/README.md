LPOS runtime-owned assets live here.

Expected directories:

- `runtime/whisper-runtime/`: Whisper executable and any required shared libraries
- `runtime/whisper-models/`: Whisper model files such as `ggml-base.bin`
- `runtime/atem-bridge/`: `atem-bridge.js` or `atem-bridge.exe`

These assets can be provisioned externally, but LPOS owns how they are located,
validated, and staged.

To stage external runtime assets into this folder, run:

```bash
npm run prepare:runtime
```

Supported staging env vars:

- `LPOS_STAGE_WHISPER_RUNTIME_FROM`
- `LPOS_STAGE_WHISPER_MODELS_FROM`
- `LPOS_STAGE_ATEM_BRIDGE_FROM`
