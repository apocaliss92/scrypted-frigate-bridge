# Scrypted frigate bridge

This Scrypted plugin allows to ingest Frigate's detections on Scrypted.

Install the plugin and configure the settings:
- Frigate server API URL (i.e. http://192.168.1.100:5000/api)
- Base go2rtc RTSP URL (i.e. rtsp://192.168.1.100:8554)
- MQTT: configure all the fields or use the already configured MQTT plugin, it will listen to the default Frigate topic

A seamingless adoption of cameras declared on Frigate will be possible. On the plugin page will be available a list of the available cameras, click on any and confirm the adoption. The device will be available right away with all the extensions enabled and ready to go. In the "Detected streams" section you'll be able to decide which stream source to utilize, if the go2Rtc restream of the input done by the user.

Currently the following extensions are possible:

### Frigate Motion Detection
Starts motion on scrypted when detected on Frigate

### Frigate Videoclips
Shows videoclips from frigate on the NVR app, if not extending NVR already

### Frigate Object Detector
Object detection will be forwarded to Scrypted, NVR will be able to use it as well and show events on the app. All the zones declared on frigate will be shown, with the possibility to include/exclude some of those from the events dispatched to scrypted

### Frigate Audio Detector
Will ingest audio levels from Frigate, audio events (scream, yelling, barking, crying etc) will also be forwarded, it's currently useful for the audio detection rules on Advanced notifier

### Frigate Events Recorder
Will allow to show on the scrypted NVR app the detections coming from Frigate. Needs to be used in combination with Frigate Object Detector

Advanced notifier is fully compatible with this plugin, any frigate detection can be used to configure AN (https://github.com/apocaliss92/scrypted-advanced-notifier)

Furthermore the plugin will allow to export default configuration for each scrypted camera to use the rebroacast urls on frigate

Feel free to catch me on discord (@apocaliss92) or open an issue on Github to request new functionalities

☕️ If this extension works well for you, consider buying me a coffee. Thanks!
[Buy me a coffee!](https://buymeacoffee.com/apocaliss92)

[For requests and bugs](https://github.com/apocaliss92/scrypted-frigate-bridge)

---

## Changelog

### v0.1.22 — Frigate 0.15+ / 0.17.0 compatibility fixes

#### Bug fixes

**Authentication support for Frigate 0.15+ (external port / auth-enabled installs)**

Frigate 0.15 introduced optional authentication (required when accessing Frigate on the external port 8971 or when `auth.enabled: true` is set in the config). All HTTP requests made by the plugin were previously unauthenticated, causing them to fail with HTTP 401 on protected instances.

A new **Frigate API token** setting (`password` type) has been added to the plugin. Set it to the Bearer token generated in the Frigate UI under *Settings → Users*. When a token is configured, it is forwarded as an `Authorization: Bearer <token>` header on every outgoing request:

- `GET /api/config` — Frigate config fetch
- `GET /api/config/raw` — Raw YAML config fetch
- `GET /api/labels` — Available detection labels
- `GET /api/faces` — Registered face names
- `GET /api/events/<id>` — VOD URL resolution
- `GET /api/events/<id>/snapshot.jpg` — Audio & object detection thumbnails
- `GET /api/events` — Videoclip event listing (`videoclipsMixin`)
- Video probe HEAD requests (`videoclipsMixin`)
- Thumbnail fetches (`videoclipsMixin`, `main`)
- go2rtc stream path lookups (`camera`)

The token is optional — if left blank the plugin behaves exactly as before.

---

**Camera config array format in Frigate 0.17.0** (`TypeError` on plugin initialization)

Frigate 0.17.0 changed the `/api/config` response so that `cameras` is returned as an **array** of camera objects (each carrying a `name` field) instead of a plain **object** keyed by camera name. The plugin assumed the old object format everywhere (`Object.keys(config.cameras)`, `config.cameras[cameraName]`), resulting in a `TypeError` on startup that prevented all cameras from being discovered.

A `normalizeFrigateConfigCameras()` helper now converts the new array format into the legacy keyed-object shape immediately after the config is parsed, so all downstream code continues to work without further changes. Both formats (object and array) are handled transparently.

---

**Defensive guards against unexpected API shapes**

Two additional runtime guards were added to prevent crashes when the Frigate API returns an unexpected type:

- `GET /api/labels` — response is now validated to be an array before being used as one; a non-array response (e.g. an error object) is treated as an empty list.
- `GET /api/faces` — response is now validated to be a non-array object before `Object.keys()` is called on it; a missing or unexpected response is treated as an empty map.