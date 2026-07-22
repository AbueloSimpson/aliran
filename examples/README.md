# Examples

Small, runnable starting points for building on the Aliran SDK. They resolve
`@aliran/player-sdk` through the repo's npm workspace — run `npm install` at the
repo root first.

## headless-player.mjs

The [`@aliran/player-sdk`](../sdk/README.md) quickstart as a working program: DHT
connect → OPRF login → print the entitled lineup → serve one channel on localhost
for any HLS player (`ffplay`, VLC, hls.js, ExoPlayer…).

```sh
node examples/headless-player.mjs --panel-key <hex> --user demo --pass '…' [--channel ch1]
```

The panel public key is printed by `panel` at init (operators: see the
[operator guide](https://abuelosimpson.github.io/aliran/operator-guide/)). The
store directory it creates is a disposable replica cache — safe to delete.

For React Native apps, skip the manual wiring and use
[`@aliran/react-native`](../sdk/react-native/README.md)'s `<AliranVideo>`.
