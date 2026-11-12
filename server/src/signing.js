// Signed releases: only code signed by a trusted key is installed from GitHub releases, whatever
// happens on GitHub (a compromised account, an edited release). The trusted public keys live in
// server/trusted-keys.json, which ships with the app and changes only through a reviewed pull request.
//   release side: scripts/release-key.mjs signs bundle.tgz → bundle.sig (ed25519)
//   app side:     transfer.js checks bundle.sig before applying a release (verifyBundle)
// The signature covers the release tag and the bundle's SHA-256, so an old signed bundle can't be
// republished under a new tag.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TRUSTED_KEYS } from "./trusted-keys.default.js";

export const SIG_NAME = "bundle.sig";
const message = (tag, sha) => `pocket-agent release\n${tag}\n${sha}\n`;
export const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
export const publicKeyB64 = key => crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
export const keyFingerprint = b64 => sha256(Buffer.from(b64, "base64")).slice(0, 12);

/** Public keys whose releases this app accepts: [{ id, owner, publicKey (base64 SPKI) }]. */
export function trustedKeys(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "server/trusted-keys.json"), "utf8")).keys || []; }
  catch { return DEFAULT_TRUSTED_KEYS.keys; }   // the file went missing (see trusted-keys.default.js)
}
/** Puts server/trusted-keys.json back if it's missing, exactly as released (so the code's hash matches again). */
export function ensureTrustedKeys(root) {
  const f = path.join(root, "server/trusted-keys.json");
  if (fs.existsSync(f)) return false;
  fs.writeFileSync(f, JSON.stringify(DEFAULT_TRUSTED_KEYS, null, 2) + "\n");
  return true;
}

export function signBundle(tgz, tag, privateKey, keyId) {
  const sha = sha256(tgz);
  return { format: 1, tag, sha256: sha, keyId, sig: crypto.sign(null, Buffer.from(message(tag, sha)), privateKey).toString("base64") };
}

/** Throws (with a message for the person) unless sig is a valid signature of tgz, for tag, by a trusted key. */
export function verifyBundle(tgz, tag, sig, keys) {
  if (!sig?.sig) throw new Error(`${tag} isn't signed, so it wasn't installed.`);
  if (sig.tag !== tag) throw new Error(`${tag} carries the signature of ${sig.tag}, so it wasn't installed.`);
  const sha = sha256(tgz);
  if (sha !== sig.sha256) throw new Error(`${tag}'s code doesn't match its signature (changed after signing?), so it wasn't installed.`);
  const k = keys.find(x => x.id === sig.keyId);
  if (!k) throw new Error(`${tag} is signed by a key this app doesn't trust (${sig.keyId}), so it wasn't installed.`);
  const pub = crypto.createPublicKey({ key: Buffer.from(k.publicKey, "base64"), format: "der", type: "spki" });
  if (!crypto.verify(null, Buffer.from(message(tag, sha)), pub, Buffer.from(sig.sig, "base64"))) throw new Error(`${tag}'s signature is invalid, so it wasn't installed.`);
  return k;
}
