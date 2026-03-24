/**
 * Sony Camera Remote API v1.x helpers
 *
 * The FX6 (and most Sony Alpha / Cinema Line cameras with network remote enabled)
 * exposes a JSON-RPC endpoint at:
 *   http://{ip}:{port}/sony/camera
 *
 * Enable on camera: MENU → Network → Remote Shooting → PC Remote Function → On
 * Default port: 10000
 *
 * All requests are POST with:
 *   { "method": string, "params": any[], "id": 1, "version": "1.0" }
 * Successful response:
 *   { "id": 1, "result": any[] }
 * Error response:
 *   { "id": 1, "error": [code: number, message: string] }
 */

export interface SonyRpcResponse {
  id:      number;
  result?: unknown[];
  error?:  [number, string];
}

export interface CameraStatus {
  cameraStatus:     string;        // "IDLE" | "MovieRecording" | "MovieWaitRecStart" | "MovieWaitRecStop"
  recording:        boolean;
  batteryPercent:   number | null;
  remainingSeconds: number | null;
  whiteBalance:     string | null;
  isoSpeedRate:     string | null;
}

export interface WbMode {
  whiteBalanceMode:          string;
  colorTemperatureRange?:    number[];
}

// ── Core RPC ──────────────────────────────────────────────────────────────────

export async function sonyRpc(
  ip:     string,
  port:   number,
  method: string,
  params: unknown[] = [],
): Promise<SonyRpcResponse> {
  const url = `http://${ip}:${port}/sony/camera`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ method, params, id: 1, version: '1.0' }),
    // Short timeout — camera is on local LAN, should respond within 3s
    signal:  AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Sony API HTTP ${res.status}`);
  return res.json() as Promise<SonyRpcResponse>;
}

// ── API list ──────────────────────────────────────────────────────────────────

export async function getAvailableApiList(ip: string, port: number): Promise<string[]> {
  const res = await sonyRpc(ip, port, 'getAvailableApiList');
  return (res.result?.[0] as string[] | undefined) ?? [];
}

// ── Recording ─────────────────────────────────────────────────────────────────

export async function startMovieRec(ip: string, port: number): Promise<void> {
  const res = await sonyRpc(ip, port, 'startMovieRec');
  if (res.error) throw new Error(res.error[1]);
}

export async function stopMovieRec(ip: string, port: number): Promise<void> {
  const res = await sonyRpc(ip, port, 'stopMovieRec');
  if (res.error) throw new Error(res.error[1]);
}

// ── Status polling ────────────────────────────────────────────────────────────

/**
 * getEvent polls the camera for state changes.
 * longPolling=true blocks until something changes (up to ~20s).
 * longPolling=false returns immediately with current state.
 *
 * The response is an indexed array; positions vary by model/firmware.
 * We scan for known shapes rather than rely on fixed positions.
 */
export async function getCameraEvent(
  ip:          string,
  port:        number,
  longPolling  = false,
): Promise<CameraStatus> {
  const res = await sonyRpc(ip, port, 'getEvent', [longPolling]);
  if (res.error) throw new Error(res.error[1]);

  const items = (res.result ?? []) as unknown[];
  let cameraStatus     = 'IDLE';
  let recording        = false;
  let batteryPercent: number | null = null;
  let remainingSeconds: number | null = null;
  let whiteBalance: string | null = null;
  let isoSpeedRate: string | null = null;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;

    // Camera status
    if (typeof obj['cameraStatus'] === 'string') {
      cameraStatus = obj['cameraStatus'];
      recording    = cameraStatus === 'MovieRecording';
    }

    // Battery info — array of battery objects
    if (Array.isArray(obj['batteryInfo'])) {
      const batt = obj['batteryInfo'][0] as Record<string, unknown> | undefined;
      if (batt && typeof batt['levelNumer'] === 'number' && typeof batt['levelDenom'] === 'number') {
        batteryPercent = Math.round((batt['levelNumer'] as number) / (batt['levelDenom'] as number) * 100);
      }
    }

    // Remaining recording time (seconds)
    if (typeof obj['remainMovTime'] === 'number') {
      remainingSeconds = obj['remainMovTime'] as number;
    }

    // White balance
    if (typeof obj['currentWhiteBalanceMode'] === 'string') {
      whiteBalance = obj['currentWhiteBalanceMode'] as string;
    }

    // ISO
    if (typeof obj['currentIsoSpeedRate'] === 'string') {
      isoSpeedRate = obj['currentIsoSpeedRate'] as string;
    }
  }

  return { cameraStatus, recording, batteryPercent, remainingSeconds, whiteBalance, isoSpeedRate };
}

// ── White balance ─────────────────────────────────────────────────────────────

export async function getAvailableWhiteBalance(ip: string, port: number): Promise<string[]> {
  const res = await sonyRpc(ip, port, 'getAvailableWhiteBalance');
  if (res.error) return [];
  // result[0] is the current value; result[1] is an array of {whiteBalanceMode, colorTemperatureRange}
  const modes = res.result?.[1] as WbMode[] | undefined;
  return (modes ?? []).map((m) => m.whiteBalanceMode);
}

export async function setWhiteBalance(ip: string, port: number, mode: string): Promise<void> {
  const res = await sonyRpc(ip, port, 'setWhiteBalance', [mode, false, -1]);
  if (res.error) throw new Error(res.error[1]);
}

// ── ISO ───────────────────────────────────────────────────────────────────────

export async function getAvailableIsoSpeedRate(ip: string, port: number): Promise<string[]> {
  const res = await sonyRpc(ip, port, 'getAvailableIsoSpeedRate');
  if (res.error) return [];
  // result[0] = current, result[1] = available array
  return (res.result?.[1] as string[] | undefined) ?? [];
}

export async function setIsoSpeedRate(ip: string, port: number, iso: string): Promise<void> {
  const res = await sonyRpc(ip, port, 'setIsoSpeedRate', [iso]);
  if (res.error) throw new Error(res.error[1]);
}

// ── Liveview ──────────────────────────────────────────────────────────────────

export async function startLiveview(ip: string, port: number): Promise<string> {
  const res = await sonyRpc(ip, port, 'startLiveview');
  if (res.error) throw new Error(res.error[1]);
  const url = res.result?.[0] as string | undefined;
  if (!url) throw new Error('startLiveview returned no URL');
  return url;
}

export async function stopLiveview(ip: string, port: number): Promise<void> {
  await sonyRpc(ip, port, 'stopLiveview').catch(() => { /* best-effort */ });
}

// ── Sony liveview binary parser → MJPEG ──────────────────────────────────────
//
// Sony's liveview stream is NOT standard MJPEG. Each frame is a binary packet:
//
//  Common header (8 bytes):
//    [0]    0xFF  — start marker
//    [1]    payload type (0x01 = liveview JPEG frame, 0x02 = frame info)
//    [2-3]  sequence number (uint16 BE)
//    [4-7]  timestamp ms  (uint32 BE)
//
//  Payload header (128 bytes, for type 0x01):
//    [0-3]  data size    (uint32 BE) — JPEG byte count
//    [4-7]  padding size (uint32 BE)
//    [8-127] reserved
//
//  Payload: [data size bytes of JPEG] [padding size bytes of 0x00]
//
// This function converts that stream into standard MJPEG
// (multipart/x-mixed-replace) that browsers can display natively via <img>.

const MJPEG_BOUNDARY = 'lposframe';

export function sonyBinaryToMjpeg(sonyStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const enc    = new TextEncoder();
  let   buffer = new Uint8Array(0);

  function grow(chunk: Uint8Array) {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = sonyStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) grow(value);

          // Process all complete packets in buffer
          while (buffer.length >= 8) {
            if (buffer[0] !== 0xFF) {
              // Hunt for next start marker
              const next = buffer.indexOf(0xFF, 1);
              buffer = next === -1 ? new Uint8Array(0) : buffer.slice(next);
              continue;
            }

            const payloadType = buffer[1];

            if (payloadType === 0x01) {
              // Liveview JPEG frame
              if (buffer.length < 8 + 128) break;

              const dv          = new DataView(buffer.buffer, buffer.byteOffset + 8);
              const dataSize    = dv.getUint32(0, false);
              const paddingSize = dv.getUint32(4, false);
              const totalSize   = 8 + 128 + dataSize + paddingSize;

              if (buffer.length < totalSize) break;

              const jpeg   = buffer.slice(8 + 128, 8 + 128 + dataSize);
              const header = enc.encode(
                `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${dataSize}\r\n\r\n`,
              );

              controller.enqueue(header);
              controller.enqueue(jpeg);
              controller.enqueue(enc.encode('\r\n'));

              buffer = buffer.slice(totalSize);

            } else if (payloadType === 0x02) {
              // Frame info packet — parse but don't emit
              if (buffer.length < 8 + 128) break;
              const dv          = new DataView(buffer.buffer, buffer.byteOffset + 8);
              const dataSize    = dv.getUint32(0, false);
              const paddingSize = dv.getUint32(4, false);
              buffer = buffer.slice(8 + 128 + dataSize + paddingSize);

            } else {
              // Unknown type — skip one byte and re-scan
              buffer = buffer.slice(1);
            }
          }
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

export { MJPEG_BOUNDARY };
