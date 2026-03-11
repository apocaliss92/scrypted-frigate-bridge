# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Scrypted plugin that bridges Frigate NVR detections into Scrypted. It ingests object/audio/motion events via MQTT, provides videoclips, snapshots, and camera streams from Frigate within the Scrypted ecosystem.

## Build & Development

```bash
npm run build              # Build with scrypted-webpack
npm run scrypted-deploy    # Deploy to a running Scrypted instance
npm run scrypted-debug     # Deploy and attach debugger
```

There are no tests in this project. The plugin is tested by deploying to a Scrypted server.

VS Code launch configurations are available in `.vscode/launch.json` for debug deployment.

## Architecture

### Plugin Entry Point

`src/main.ts` — `FrigateBridgePlugin` extends `RtspProvider` and implements `DeviceProvider`, `HttpRequestHandler`, `DeviceDiscovery`. On startup it:
1. Fetches Frigate config (labels, cameras, zones, faces) via the Frigate HTTP API
2. Registers five sub-devices as MixinProviders (object detector, motion detector, audio detector, videoclips, events recorder)
3. Discovers Frigate cameras and offers them for adoption into Scrypted
4. Handles HTTP webhook requests for videoclip/thumbnail streaming

### Mixin Pattern

Each feature is implemented as a **detector + mixin** pair:
- `objectDetector.ts` / `objectDetectorMixin.ts` — forwards Frigate object detections to Scrypted
- `motionDetector.ts` / `motionDetectorMixin.ts` — forwards motion events
- `audioDetector.ts` / `audioDetectorMixin.ts` — forwards audio events
- `videoclips.ts` / `videoclipsMixin.ts` — serves Frigate videoclips in Scrypted NVR
- `frigateEventsRecorder.ts` / `frigateEventsRecorderMixin.ts` — shows Frigate detections in NVR timeline

The detector files (`*Detector.ts` / `*Recorder.ts`) are `MixinProvider` implementations that create per-camera mixin instances. The mixin files (`*Mixin.ts`) contain the per-camera logic, typically subscribing to MQTT topics and translating Frigate events into Scrypted interfaces.

### Camera Management

`src/camera.ts` — `FrigateBridgeCamera` extends `RtspSmartCamera`. On adoption it:
- Probes streams via Frigate's `/api/ffprobe` endpoint
- Matches go2rtc restream names from Frigate config
- Auto-adds all frigate mixin extensions to the camera

### Key External Dependencies

- **Sibling repos referenced via relative imports**: `../../scrypted-apocaliss-base/src/basePlugin` (shared plugin utilities), `../../scrypted/plugins/rtsp/src/rtsp` (RTSP base classes), `../../scrypted-advanced-notifier/src/detectionClasses` (label classification)
- **MQTT**: Uses the `mqtt` package to subscribe to Frigate's MQTT topics for real-time events
- **Frigate HTTP API**: All config/label/event fetching goes through `baseFrigateApi()` in `utils.ts`

### Utilities

`src/utils.ts` — shared constants (native IDs), `baseFrigateApi()` helper for Frigate REST calls, `convertSettingsToStorageSettings()` for dynamic settings, zone/occupancy helpers, ffprobe utilities.

`src/videoclipUtils.ts` — HLS/MP4 streaming logic for serving videoclips via HTTP webhooks.

## Key Conventions

- Native IDs follow the pattern: `frigateObjectDetector`, `frigateMotionDetector`, `frigateCamera__<cameraName>`
- Camera names from Frigate are snake_case; display names convert underscores to spaces with capitalized first letter
- Settings use Scrypted's `StorageSettings` pattern with typed key unions (e.g., `StorageKey`, `CameraSettingKey`)
- The plugin auto-restarts every 2 hours and re-fetches Frigate config every 10 minutes
