// Built-in copy of server/trusted-keys.json (kept identical by scripts/release-key.mjs, checked by tests).
// Used when that file is missing: an app that updated from 1.0.0 got 1.1.0's code without it, because
// 1.0.0 only copied the files it knew about. signing.js restores the file from this on start-up.
export const DEFAULT_TRUSTED_KEYS = {
  "keys": [
    {
      "id": "yashmehta93-819654c1f480",
      "owner": "YashMehta93",
      "publicKey": "MCowBQYDK2VwAyEA22gnqMiAL10McIoitVK+ZaT6JuYLZsT1bEuAflp1tAI=",
      "added": "2026-11-12"
    }
  ]
};
