# Examples

Small, runnable starting points for building on the Aliran SDK. They resolve
`@aliran/player-sdk` through the repo's npm workspace, so run `npm install` at
the repo root first.

## headless-player.mjs

The [`@aliran/player-sdk`](../sdk/README.md) quickstart as a working program: it
connects over the DHT, logs in with OPRF, prints the entitled lineup, and serves
one channel on localhost for any HLS player (`ffplay`, VLC, hls.js, ExoPlayer…).

```sh
node examples/headless-player.mjs --panel-key <hex> --user demo --pass '…' [--channel ch1]
```

The `panel` process prints the panel public key at init (operators: see the
[operator guide](https://abuelosimpson.github.io/aliran/operator-guide/)). The
store directory this example creates is a disposable replica cache — you can
safely delete it.

For React Native apps, skip the manual wiring and use
[`@aliran/react-native`](../sdk/react-native/README.md)'s `<AliranVideo>`.
