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