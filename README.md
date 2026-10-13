# Scrypted frigate bridge

**Documentation:** [https://advanced-notifier-docs.zentik.app/docs/frigate-bridge](https://advanced-notifier-docs.zentik.app/docs/frigate-bridge)

[For requests and bugs](https://github.com/apocaliss92/scrypted-frigate-bridge)

☕️ If this extension works well for you, consider buying me a coffee. Thanks!
[Buy me a coffee!](https://buymeacoffee.com/apocaliss92)

## Building

The shared base comes from npm (`@apocaliss92/scrypted-apocaliss-base`). Two
sources are still imported from sibling checkouts, so clone them next to this
repository:

```
git clone https://github.com/koush/scrypted
git clone https://github.com/apocaliss92/scrypted-advanced-notifier
git clone https://github.com/apocaliss92/scrypted-frigate-bridge
for d in scrypted/sdk scrypted/common scrypted/plugins/rtsp scrypted/plugins/ffmpeg-camera scrypted-advanced-notifier; do (cd $d && npm install); done
cd scrypted-frigate-bridge && npm install && npm run build
```

Without the `npm install` in the sibling checkouts, `tsc` reports dozens of
type errors that look like they come from this repository.
