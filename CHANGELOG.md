<details>
<summary>Changelog</summary>

### 3.2.0

- Update images for rule in the same asynqueue to make sure an image is always available

### 3.1.23

- Link plugin rule entities on devices and vice-versa, plugin triggers will activate the plugin entity as well

### 3.1.17

- Fix retained button messages not cleaned up

### 3.1.15

- Only update motion in case of non-NVR detections when NVR detections is enabled

### 3.1.10

- Move MQTT enabled setting on camera level, enabled by default
- Move Notifier enabled setting on notifier level, enabled by default

### 3.1.9

- Added option to fetch frames from prebuffer. Unsuggested for use, use it only if snapshot crashes continuously

### 3.0.31

- Automatic cleanup of HA entities when not available anymore

### 3.0.30

- `Minimum MQTT publish delay` setting adding on the camera, allowing to defer detection updates

### 3.0.28

- NVR images will be stored on system as well, with a -NVR suffix, along with the non-cropped ones

### 3.0.27

- Add camera level configuration to enable regular occupancy check

### 3.0.23

- Add rule configuration to delay MQTT image update

### 3.0.21

- Cleanup detection rules discovery not supported per camera

### 3.0.20

- Fix NVR detections parsing

### 3.0.19

- Performance noticeably improved splitting images update on MQTT in batches

### 3.0.17

- MQTT client split per device to reduce overhead for weak brokers
- Utilize images from object detectors when available
- Optimize image usage 

### 3.0.8

Added support to Groq

### 3.0.7

Added support to Anthropic AI

### 3.0.6

Added support to Google AI, thanks @sfn!

### 3.0.0

MQTT rework. Most of the IDs have changed. Remove all the homeassistant devices and let the plugin to recreate them.
This was required to allow me to extend the plugin in an easier and scalable way. Some improvements happened along the way

### 2.2.30

Add MQTT flag for each rule currently running

### 2.2.28

Enable reporting of occupancy data for every camera enabled to MQTT

### 2.2.27

Audio deteciton rules implemented

### 2.2.26

Add PTZ controls to MQTT/HA

### 2.2.25

Add Reboot button to MQTT/HA

</details>