#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Minimal realtime server (FT sensor 6-axis):
NI-DAQ (6 ch) -> correction -> Fx, Fy, Fz, Tx, Ty, Tz.

Notes:
- Guards empty READ_ALL_AVAILABLE returns (size==0).
- 1 s baseline offset calibration for ALL 6 axes (Fx..Tz).
- WebSocket push with rate limiting to avoid browser overload.
"""

import time
import asyncio
import json
from typing import Optional, List

import nidaqmx           # pip install nidaqmx
import numpy as np
import websockets        # pip install websockets


# ===================== Config =====================
DAQ_DEVICE = "Dev1"
DAQ_CHANNELS = ["ai0", "ai1", "ai2", "ai3", "ai4", "ai5"]  # 6 channels
DAQ_RATE = 4000  # Hz

# Send rate limit to avoid browser overload
MAX_SEND_HZ = 1200
_MIN_DT = 1.0 / MAX_SEND_HZ
_last_send = 0.0

# 6x6 correction matrix: raw(6,) @ CORRECTION_MATRIX -> [Fx,Fy,Fz,Tx,Ty,Tz]
CORRECTION_MATRIX = np.array([
    [0.00472,  -0.00593,  0.12215, -1.66618, -0.05784,  1.65676],
    [-0.11714,  2.04801,  0.05549, -0.95218,  0.02378, -0.96562],
    [1.92708,   0.05857,  1.89322,  0.04327,  1.83111,  0.06284],
    [-1.08412, 12.44250, 10.63652, -5.53966, -10.56779, -6.23466],
    [-12.11476,-0.24313,  5.58161, 10.23056,  6.32958, -9.92033],
    [-0.53455,  7.83584, -0.48279,  7.23151, -0.21834,  7.49266],
]).T  # shape (6,6)


# ===================== Globals =====================
daq_task: Optional[nidaqmx.Task] = None
clients = set()

daq_offset6 = np.zeros(6, dtype=float)  # Fx,Fy,Fz,Tx,Ty,Tz offset

_last_info = time.perf_counter()
_send_counter = 0


# ===================== Setup =====================
def setup_daq() -> nidaqmx.Task:
    print("Initializing DAQ…")
    task = nidaqmx.Task()
    for ch in DAQ_CHANNELS:
        task.ai_channels.add_ai_voltage_chan(f"{DAQ_DEVICE}/{ch}")
    task.timing.cfg_samp_clk_timing(
        rate=DAQ_RATE,
        sample_mode=nidaqmx.constants.AcquisitionType.CONTINUOUS,
    )
    # Large buffer to survive UI hiccups
    task.in_stream.input_buf_size = 200_000
    task.start()
    return task


def calibrate_offset_1s(task: nidaqmx.Task) -> np.ndarray:
    """1 s mean offset for Fx..Tz. Robust to empty reads/timeouts."""
    print("⌛ Calibrating DAQ offset (1 s)…")
    samples: List[np.ndarray] = []
    t0 = time.perf_counter()

    while time.perf_counter() - t0 < 1.0:
        try:
            raw = task.read(number_of_samples_per_channel=1, timeout=0.05)
            arr = np.array(raw).flatten()
            if arr.size != 6:
                continue
            corrected6 = arr @ CORRECTION_MATRIX  # (6,)
            samples.append(corrected6)
        except nidaqmx.errors.DaqError:
            pass

    if not samples:
        raise RuntimeError("DAQ calibration failed: no samples read.")

    offset6 = np.mean(np.vstack(samples), axis=0)
    print(f"✅ Offset (Fx..Tz): {offset6}")
    return offset6


# ===================== WebSocket =====================
async def ws_handler(websocket):
    clients.add(websocket)
    print(f"[WS] client connected (total={len(clients)})")
    try:
        await websocket.wait_closed()
    finally:
        clients.discard(websocket)
        print("[WS] client disconnected")


# ===================== Producer =====================
async def producer():
    global _last_send, _last_info, _send_counter

    while True:
        try:
            raw = daq_task.read(
                number_of_samples_per_channel=nidaqmx.constants.READ_ALL_AVAILABLE,
                timeout=0.0
            )
            arr = np.array(raw)

            # Normalize shape to (6, N)
            if arr.ndim == 1:
                if arr.size == 6:
                    arr = arr.reshape(-1, 1)
                else:
                    await asyncio.sleep(0)
                    continue

            # Guard empty (6,0)
            if arr.shape[1] == 0:
                await asyncio.sleep(0)
                continue

            last_raw = arr[:, -1]  # (6,)
            t_now = time.perf_counter()

            corrected6 = last_raw @ CORRECTION_MATRIX  # (6,)
            corrected6 = corrected6 - daq_offset6      # remove baseline for all 6

            msg = {
                "t": float(t_now),
                "Fx": float(corrected6[0]),
                "Fy": float(corrected6[1]),
                "Fz": float(corrected6[2]),
                "Tx": float(corrected6[3]),
                "Ty": float(corrected6[4]),
                "Tz": float(corrected6[5]),
            }

            if clients:
                now_send = time.perf_counter()
                if now_send - _last_send >= _MIN_DT:
                    data = json.dumps(msg)
                    dead = []
                    for ws in list(clients):
                        try:
                            await ws.send(data)
                        except Exception:
                            dead.append(ws)
                    for ws in dead:
                        clients.discard(ws)

                    _last_send = now_send
                    _send_counter += 1

        except nidaqmx.errors.DaqError:
            pass
        except Exception as e:
            print(f"[DAQ] warn: {e}")

        # Print stats every second
        now = time.perf_counter()
        if now - _last_info >= 1.0:
            print(f"[INFO] sent={_send_counter} msgs/s, clients={len(clients)}")
            _send_counter = 0
            _last_info = now

        await asyncio.sleep(0)


# ===================== Main =====================
async def main():
    global daq_task, daq_offset6

    daq_task = setup_daq()
    daq_offset6 = calibrate_offset_1s(daq_task)

    print("[WS] Server at ws://127.0.0.1:8765")
    async with websockets.serve(ws_handler, "127.0.0.1", 8765, max_queue=None):
        await producer()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 Stopping…")
    finally:
        try:
            if daq_task is not None:
                daq_task.close()
        except Exception:
            pass
        print("✅ Clean exit.")