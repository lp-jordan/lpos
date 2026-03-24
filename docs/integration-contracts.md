# LPOS Integration Contracts

## LPOS Ownership

LPOS owns:

- ingest, upload, asset/version state, reconciliation, and storage contracts
- transcription runtime and queue ownership
- Pass Prep generation logic and workbook assets
- publish flows and operator-facing runtime diagnostics
- ATEM bridge bootstrap and health checks

## EditPanel Contract

`editpanel` remains a Resolve-facing editorial client.

It owns:

- Resolve session attach
- timeline identity and timeline commands
- export initiation and render/write-back
- marker/text operations and editorial tooling

It does not own:

- transcription runtime
- media pipeline storage/reconciliation state
- Whisper runtime provisioning
- publish/distribution state

Any pipeline-owned operation should integrate with LPOS through explicit APIs or queue handoff, not shared folder assumptions.

## LeaderPrompt Contract

`leaderprompt` remains a separate user workflow client.

It uses LPOS as the source of truth for:

- projects
- scripts and script files
- project/script sync state

It does not own:

- pipeline runtime
- Whisper runtime provisioning
- storage or publish state

## Stability Target

These LPOS endpoints are the intended integration surface during consolidation:

- `/api/projects`
- `/api/projects/:projectId/scripts`
- `/api/projects/:projectId/scripts/:scriptId`
- `/api/projects/:projectId/scripts/:scriptId/file`
- `/api/projects/:projectId/passPrep`
- `/api/services`
