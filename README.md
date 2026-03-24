# LPOS Dashboard

LPOS is the primary product and deployment unit for the operational pipeline.

## LPOS Owns

- pipeline services and operator workflows
- asset/version state and canonical storage
- transcription runtime and runtime dependency validation
- Pass Prep core generation flow
- publish flows, storage contracts, and runtime diagnostics
- ATEM bridge bootstrap and health checks

Sibling apps still exist, but LPOS is the operational center of gravity.

## Runtime Contracts

LPOS-owned runtime directories:

- `runtime/whisper-runtime`
- `runtime/whisper-models`
- `runtime/atem-bridge`

Helpful commands:

```bash
npm install
npm run prepare:runtime
npm run dev
```

Runtime/service health:

- `GET /api/services` returns service registry state plus runtime dependency status.

See also:

- `docs/runtime-dependencies.md`
- `docs/integration-contracts.md`
