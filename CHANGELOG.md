### v0.1.27 — go2rtc streams that are not ffmpeg inputs

#### Bug fixes

**Cameras offer go2rtc streams that Frigate does not use as inputs** (#22)

Streams were discovered only from `ffmpeg.inputs`, so a go2rtc stream made for another consumer (e.g. a transcode for HomeKit) never showed up. A camera now also gets the go2rtc streams named in its `live.streams`, plus the ones picked in the new **Additional go2rtc streams** setting. Existing cameras pick up `live.streams` entries after **Re-run ffprobe** or after changing the new setting. Input streams keep their ids, so streams already chosen do not move.

---

### v0.1.26 — Motion only for moving objects, labels from config, relative clip urls

#### Bug fixes

**"Report motion only on detection" reports motion only for moving objects that pass the filters** (#25, fixes #18)

Every `frigate/events` message used to arm motion, before the false positive, label and zone checks. Frigate republishes stationary objects at least once a minute, so a parked car kept motion (and HKSV recording sessions) going all day. Motion is now armed only for a `new` event or an `update` with `stationary: false`, after the false positive check, and only if the label and zone filters of the camera's object detector pass. A camera without the object detector extension keeps only the moving check.

**Labels to import include every label Frigate is configured to track** (#23)

`/api/labels` lists only labels that already have events, so a tracked label never seen yet (e.g. `cat`) could not be selected. The list now also includes each camera's `objects.track`, plus `audio.listen` for cameras with audio enabled.

**Clip and thumbnail urls are relative** (#24)

Without the Scrypted Cloud plugin the urls pointed at `https://<server-ip>:10443` with the self-signed certificate, which the browser blocks when Scrypted is opened through another hostname (e.g. a reverse proxy). They are now relative to whatever host the browser used.

#### Other

The shared base now comes from the published `@apocaliss92/scrypted-apocaliss-base` npm package, so the plugin can be built without private checkouts. See the README for the sibling repositories still needed.

---

### v0.1.25 — MQTT credentials fallback + unmapped camera logging

#### Bug fixes

**Use plugin MQTT Host/Username/Password when the Scrypted MQTT plugin is not installed** (#20)

The settings UI already shows Host / Username / Password when the MQTT plugin is missing, but the stored “Use MQTT plugin credentials” toggle (default `true`) still made `getMqttBasicClient` bail out without a client. Motion, object and audio detectors now fall back to the plugin’s own MQTT fields in that case.

**Log once for Frigate cameras with no Scrypted mapping** (#21)

When Frigate publishes events for a camera name that no Scrypted camera has set as “Frigate camera name”, the motion/object detectors now log a single clear line per Frigate camera (only while the extension is enabled on at least one camera), instead of dropping messages silently.

---

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