const http = require('http');
const { Atem } = require('atem-connection');

const PORT = Number(process.env.ATEM_BRIDGE_PORT || 4011);
const HOST = process.env.ATEM_BRIDGE_HOST || '127.0.0.1';

// --- Live state ---
let atem = null;
let isConnected = false;
let switcherIp = '';
let lastError = '';
let lastCommandAt = null;
let recordingFilename = '';

function buildState() {
  let inputs = [];
  let previewInput = null;
  let programInput = null;
  let isRecording = false;
  let recordingStatus = isConnected ? 'idle' : 'disconnected';
  let hasDrive = false;
  let output4Mode = null;

  if (atem && atem.state && isConnected) {
    if (atem.state.inputs) {
      inputs = Object.values(atem.state.inputs)
        .map(inp => ({ id: inp.inputId, label: inp.longName || inp.shortName || `Input ${inp.inputId}` }))
        .sort((a, b) => a.id - b.id);
    }

    const me = atem.state.video && atem.state.video.mixEffects && atem.state.video.mixEffects[0];
    if (me) {
      previewInput = me.previewInput != null ? me.previewInput : null;
      programInput = me.programInput != null ? me.programInput : null;
    }

    const auxSource3 = atem.state.video?.auxilliaries?.[3];
    if (auxSource3 === 10010) output4Mode = 'program';
    else if (auxSource3 === 9001) output4Mode = 'multiview';

    if (atem.state.recording && atem.state.recording.status != null) {
      // RecordingStatus: Idle = 0, Recording = 1, Stopping = 128.
      // atem.state.recording.status is an object { state, error, recordingTimeAvailable };
      // the numeric enum value is in .state.
      // Only treat state === 1 as actively recording — Stopping (128) is a
      // transitional state that must not be reported as recording or it appears
      // to the user as if the recording restarted immediately after stopping.
      const s = atem.state.recording.status.state;
      isRecording = s === 1;
      recordingStatus = s === 1 ? 'recording' : s === 128 ? 'stopping' : 'idle';
    }

    // RecordingDiskStatus: Idle = 1, Unformatted = 2, Active = 4, Recording = 8, Removed = 32.
    // A drive is usable when at least one disk slot is Idle, Active, or Recording.
    if (atem.state.recording && atem.state.recording.disks) {
      hasDrive = Object.values(atem.state.recording.disks).some(
        disk => disk && (disk.status === 1 || disk.status === 4 || disk.status === 8)
      );
    }
  }

  return {
    bridgeAvailable: true,
    bridgeMode: 'real',
    connected: isConnected,
    switcherIp,
    inputs,
    previewInput,
    programInput,
    recording: { isRecording, filename: recordingFilename, status: recordingStatus, hasDrive },
    output4Mode,
    lastError,
    lastCommandAt,
  };
}

function createAtem() {
  const instance = new Atem();

  instance.on('connected', () => {
    isConnected = true;
    lastError = '';
    console.log(`[atem-bridge] Connected to ${switcherIp}`);
  });

  instance.on('disconnected', () => {
    isConnected = false;
    console.log('[atem-bridge] Disconnected');
  });

  instance.on('error', (err) => {
    lastError = err && err.message ? err.message : String(err);
    console.error('[atem-bridge] Error:', lastError);
  });

  instance.on('info', (msg) => {
    console.log('[atem-bridge] [info]', msg);
  });

  let firstState = true;
  instance.on('stateChanged', (state, path) => {
    if (firstState) {
      firstState = false;
      const me = state.video && state.video.mixEffects && state.video.mixEffects[0];
      const inputCount = state.inputs ? Object.keys(state.inputs).length : 0;
      console.log(`[atem-bridge] First state received — ${inputCount} inputs, PGM=${me && me.programInput}, PVW=${me && me.previewInput}`);
    }
  });

  return instance;
}

async function teardownAtem() {
  if (!atem) return;
  const instance = atem;
  atem = null;
  isConnected = false;
  instance.removeAllListeners();
  try { await instance.destroy(); } catch (_) {}
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function requireConnection(res) {
  if (isConnected) return false;
  sendJson(res, 409, { error: 'ATEM is not connected', state: buildState() });
  return true;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, mode: 'real' });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/state') {
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/connect') {
      const body = await parseBody(req);
      if (!body.ipAddress) {
        sendJson(res, 400, { error: 'ipAddress is required' });
        return;
      }

      await teardownAtem();
      switcherIp = body.ipAddress;
      lastError = '';
      atem = createAtem();
      atem.connect(switcherIp);
      lastCommandAt = new Date().toISOString();

      console.log(`[atem-bridge] Attempting connection to ${switcherIp} ...`);

      // Wait up to 30s for the connected event.
      // atem-connection sometimes needs an internal reconnect cycle (especially when
      // the ATEM is holding a stale session from a previous connection), which can
      // take 15-20s. If it doesn't arrive in time, leave the instance running —
      // atem-connection will keep retrying via its built-in reconnect loop and the
      // state poll will pick up the connection once it lands.
      await new Promise((resolve) => {
        if (isConnected) { resolve(); return; }
        const onConnected = () => resolve();
        atem.once('connected', onConnected);
        setTimeout(() => { atem && atem.removeListener('connected', onConnected); resolve(); }, 30000);
      });

      if (!isConnected) {
        lastError = `No response from ${switcherIp} after 30s — auto-reconnect active. If network is reachable, check macOS firewall allows node to receive incoming connections.`;
        console.warn(`[atem-bridge] ${lastError}`);
      }

      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/disconnect') {
      await teardownAtem();
      switcherIp = '';
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/preview') {
      if (requireConnection(res)) return;
      const body = await parseBody(req);
      const inputId = Number(body.inputId);
      await atem.changePreviewInput(inputId, 0);
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/program') {
      if (requireConnection(res)) return;
      const body = await parseBody(req);
      const inputId = Number(body.inputId);
      await atem.changeProgramInput(inputId, 0);
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/cut') {
      if (requireConnection(res)) return;
      await atem.cut(0);
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/auto') {
      if (requireConnection(res)) return;
      await atem.autoTransition(0);
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/record/filename') {
      if (requireConnection(res)) return;
      const body = await parseBody(req);
      if (!body.filename) {
        sendJson(res, 400, { error: 'filename is required', state: buildState() });
        return;
      }
      recordingFilename = body.filename;
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/record/start') {
      if (requireConnection(res)) return;
      if (!recordingFilename) {
        sendJson(res, 409, { error: 'Recording filename must be set before recording', state: buildState() });
        return;
      }
      await atem.startRecording();
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/record/stop') {
      if (requireConnection(res)) return;
      await atem.stopRecording();
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/output4/mode') {
      if (requireConnection(res)) return;
      const body = await parseBody(req);
      const mode = body.mode === 'program' ? 'program' : 'multiview';
      // ATEM protocol source IDs derived from atem-connection tally formula:
      //   ME 1 Program = 10010  (MEOutput formula: (id - id%10 - 10000)/10 - 1 = 0, remainder 0 = pgm)
      //   MultiViewer 1 = 9001
      //   Clean Feed 1  = 7001  (NOT program — do not use)
      // setAuxSource routes the chosen source to aux bus 3 (Output 4, 0-indexed).
      const source = mode === 'program' ? 10010 : 9001;
      await atem.setAuxSource(source, 3);
      lastCommandAt = new Date().toISOString();
      sendJson(res, 200, buildState());
      return;
    }

    // /v1/shutdown endpoint removed — bridge lifecycle is managed via SIGTERM
    // from the parent process, not HTTP. Dropping it prevents any stale or
    // external HTTP request from killing a freshly spawned bridge.

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    lastError = err && err.message ? err.message : String(err);
    console.error('[atem-bridge] Request error:', lastError);
    sendJson(res, 500, { error: lastError, state: buildState() });
  }
});

// Node's HTTP server adds a 'close' listener per active connection; the default
// limit of 10 is too low for the combination of 2s state polling + concurrent
// requests. This is not a leak — raise the limit to silence the false positive.
server.setMaxListeners(50);

// Catch unhandled errors so they appear in the log rather than causing a silent exit.
process.on('uncaughtException', (err) => {
  console.error('[atem-bridge] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[atem-bridge] unhandledRejection:', reason);
});

// Graceful shutdown on SIGTERM — tear down the ATEM connection cleanly before
// exiting so the ATEM releases its session immediately. Without this, the ATEM
// holds the stale session and rejects the next connection attempt for 15-30s.
process.on('SIGTERM', () => {
  console.log('[atem-bridge] SIGTERM — disconnecting from ATEM and exiting');
  teardownAtem().finally(() => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => process.exit(0));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[atem-bridge] Listening on http://${HOST}:${PORT}`);
});
