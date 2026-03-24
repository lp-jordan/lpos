const http = require('http');

const PORT = Number(process.env.ATEM_BRIDGE_PORT || 4011);

function createInitialState() {
  return {
    bridgeAvailable: true,
    bridgeMode: process.env.ATEM_BRIDGE_MODE || 'mock',
    connected: false,
    switcherIp: '',
    inputs: Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      label: `Camera ${index + 1}`
    })),
    previewInput: 1,
    programInput: 2,
    recording: {
      isRecording: false,
      filename: '',
      status: 'idle'
    },
    output4: {
      supported: true,
      mode: 'multiview'
    },
    lastError: '',
    lastCommandAt: null
  };
}

const state = createInitialState();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function updateState(patch) {
  Object.assign(state, patch, {
    lastCommandAt: new Date().toISOString()
  });
}

function requireConnection(response) {
  if (state.connected) {
    return false;
  }

  sendJson(response, 409, { error: 'ATEM is not connected', state });
  return true;
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { ok: true, mode: state.bridgeMode });
      return;
    }

    if (request.method === 'GET' && request.url === '/v1/state') {
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/connect') {
      const body = await parseBody(request);
      if (!body.ipAddress) {
        sendJson(response, 400, { error: 'ipAddress is required' });
        return;
      }

      updateState({
        connected: true,
        switcherIp: body.ipAddress,
        lastError: '',
        recording: {
          ...state.recording,
          status: state.recording.isRecording ? 'recording' : 'idle'
        }
      });

      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/disconnect') {
      updateState({
        connected: false,
        lastError: '',
        recording: {
          ...state.recording,
          isRecording: false,
          status: 'disconnected'
        }
      });
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/preview') {
      if (requireConnection(response)) return;
      const body = await parseBody(request);
      const inputId = Number(body.inputId);
      const exists = state.inputs.some(input => input.id === inputId);
      if (!exists) {
        sendJson(response, 404, { error: 'Input not found', state });
        return;
      }

      updateState({
        previewInput: inputId,
        lastError: ''
      });
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/program') {
      if (requireConnection(response)) return;
      const body = await parseBody(request);
      const inputId = Number(body.inputId);
      const exists = state.inputs.some(input => input.id === inputId);
      if (!exists) {
        sendJson(response, 404, { error: 'Input not found', state });
        return;
      }

      updateState({
        programInput: inputId,
        lastError: ''
      });
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/cut') {
      if (requireConnection(response)) return;
      updateState({
        programInput: state.previewInput,
        lastError: ''
      });
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/auto') {
      if (requireConnection(response)) return;
      updateState({
        programInput: state.previewInput,
        lastError: ''
      });
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/record/filename') {
      if (requireConnection(response)) return;
      const body = await parseBody(request);
      if (!body.filename) {
        sendJson(response, 400, { error: 'filename is required', state });
        return;
      }

      updateState({
        recording: {
          ...state.recording,
          filename: body.filename,
          status: state.recording.isRecording ? 'recording' : 'idle'
        },
        lastError: ''
      });
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/record/start') {
      if (requireConnection(response)) return;
      if (!state.recording.filename) {
        sendJson(response, 409, { error: 'Recording filename must be set before recording', state });
        return;
      }

      updateState({
        recording: {
          ...state.recording,
          isRecording: true,
          status: 'recording'
        },
        lastError: ''
      });
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/record/stop') {
      if (requireConnection(response)) return;
      updateState({
        recording: {
          ...state.recording,
          isRecording: false,
          status: 'idle'
        },
        lastError: ''
      });
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/output4/mode') {
      if (requireConnection(response)) return;
      const body = await parseBody(request);
      if (body.mode !== 'program' && body.mode !== 'multiview') {
        sendJson(response, 400, { error: 'mode must be program or multiview', state });
        return;
      }

      updateState({
        output4: {
          ...state.output4,
          mode: body.mode
        },
        lastError: ''
      });
      sendJson(response, 200, state);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    state.lastError = error.message;
    sendJson(response, 500, { error: error.message, state });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ATEM bridge listening on http://127.0.0.1:${PORT}`);
});
