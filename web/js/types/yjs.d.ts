//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Type declarations for bundled Yjs CRDT library
 * Using any types since bundled version doesn't match npm package structure
 */

declare module '/js/vendor/yjs.mjs' {
  export const Doc: any;
  export const Array: any;
  export const Map: any;
  export const Text: any;
  export const encodeStateAsUpdate: any;
  export const encodeStateVector: any;
  export const applyUpdate: any;
  export const decodeUpdate: any;
  export const decodeStateVector: any;
}
