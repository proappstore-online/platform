# @proappstore/cli

The `pas` CLI for building and publishing apps on ProAppStore. Requires Node.js 22 or later.

```sh
npm install -g @proappstore/cli
pas --help
pas check
```

Run `pas check` from an app repository after building its web frontend. The bundle
check totals gzip bytes across unique initial JavaScript files, including static
imports and module preloads, against a 300 KiB startup budget. Bundled lazy
JavaScript, workers, WASM and model assets have a separate 25 MiB raw limit per
file. Unbuilt output warns; malformed manifests or missing referenced assets fail.

Optional public model packages should download on demand using
`@proappstore/sdk/offline`, with pinned sizes and SHA-256 hashes, rather than enter
the initial shell precache. Passing a bundle check does not establish offline
functionality: test cold offline launch, persisted content and interrupted work.

See the [PAS offline guide](https://docs.proappstore.online/offline-apps/) and
[implementation tracking](https://github.com/proappstore-online/platform/issues/520).
