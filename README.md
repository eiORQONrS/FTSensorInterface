# FTSensorInterface

Realtime NI-DAQ 6-axis force/torque (F/T) streaming + browser dashboard.

This project is built for visualizing an **ATI F/T sensor** (e.g., **ATI Nano17 Titanium**) in realtime, including:
- **Forces:** Fx, Fy, Fz (N)
- **Torques:** Tx, Ty, Tz (displayed as **N·mm** in the UI; configurable)

Data is acquired via **NI-DAQ**, converted to 6-axis F/T using a **6×6 calibration / correction matrix**, then streamed to the browser via **WebSocket** for low-latency plotting and recording.

---

## Features

- **Realtime 6-axis plots** (toggle Fx/Fy/Fz/Tx/Ty/Tz individually)
- **Top-bar live numeric readout** for selected channels
- **Config panel** (per-axis Min/Max/Step, supports decimals)
- **Recording to CSV** (browser File System Access API: “Select folder” + Record)
- **Stable UI layout** (right-side status/Hz/Record pinned)
- Uses **WebSocket** (`ws://127.0.0.1:8765`) for streaming

---

## Repository Structure

Core files:
- `FTSensor.py` — NI-DAQ acquisition + correction matrix + WebSocket server
- `start.py` — local HTTP server (serves the web UI)
- `main.html` — dashboard page
- `app_ft.js` — plotting / UI logic (channel toggles, config modal, recording)
- `styles_ft.css` — UI styles
- `README.md` — this document

---

## Requirements

### Hardware
- ATI F/T sensor (tested workflow for **ATI Nano17 Titanium**)
- NI DAQ device connected to the sensor amplifier outputs
- Analog input channels: 6 AI channels (e.g., `ai0`…`ai5`)

### Software
- Python 3.9+ recommended
- Packages:
  - `nidaqmx`
  - `numpy`
  - `websockets`

Install:
```bash
pip install nidaqmx numpy websockets