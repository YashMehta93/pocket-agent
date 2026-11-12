#!/usr/bin/env node
// The release-signing key (see server/src/signing.js).
//   node scripts/release-key.mjs new <owner>        make ./release-key.pem and add its public key to
//                                                   server/trusted-keys.json (commit that, via a PR)
//   node scripts/release-key.mjs sign <tgz> <tag>   print bundle.sig for a release (release.sh does this)
// The key is $PA_RELEASE_KEY or ./release-key.pem. Keep it private and backed up, like pocket-agent.keystore;
// it's ignored by git and left out of the app's phone-storage backups. Losing it means apps refuse new
// releases until an APK update brings a new trusted key.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { signBundle, publicKeyB64, keyFingerprint, trustedKeys } from "../server/src/signing.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const KEY = process.env.PA_RELEASE_KEY || path.join(ROOT, "release-key.pem");
const KEYS = path.join(ROOT, "server/trusted-keys.json");
const [cmd, a, b] = process.argv.slice(2);

if (cmd === "new") {
  if (!a) { console.error("usage: release-key.mjs new <owner>"); process.exit(2); }
  if (fs.existsSync(KEY)) { console.error(`${KEY} exists already; not replacing it.`); process.exit(1); }
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(KEY, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const pub = publicKeyB64(privateKey);
  const id = `${a.toLowerCase()}-${keyFingerprint(pub)}`;
  const doc = fs.existsSync(KEYS) ? JSON.parse(fs.readFileSync(KEYS, "utf8")) : { keys: [] };
  doc.keys.push({ id, owner: a, publicKey: pub, added: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(KEYS, JSON.stringify(doc, null, 2) + "\n");
  const def = path.join(ROOT, "server/src/trusted-keys.default.js"), src = fs.readFileSync(def, "utf8");
  fs.writeFileSync(def, src.replace(/export const DEFAULT_TRUSTED_KEYS = [\s\S]*;\n$/, `export const DEFAULT_TRUSTED_KEYS = ${JSON.stringify(doc, null, 2)};\n`));
  console.log(`New key ${id} in ${KEY}. Its public key is now in server/trusted-keys.json: commit that through a PR.`);
} else if (cmd === "sign") {
  if (!a || !b) { console.error("usage: release-key.mjs sign <bundle.tgz> <tag>"); process.exit(2); }
  if (!fs.existsSync(KEY)) { console.error(`No signing key at ${KEY}. Make one: node scripts/release-key.mjs new <your-github-name>`); process.exit(1); }
  const priv = crypto.createPrivateKey(fs.readFileSync(KEY));
  const pub = publicKeyB64(priv);
  const k = trustedKeys(ROOT).find(x => x.publicKey === pub);
  if (!k) { console.error("This key isn't in server/trusted-keys.json, so apps would refuse the release. Add it through a PR first."); process.exit(1); }
  console.log(JSON.stringify(signBundle(fs.readFileSync(a), b, priv, k.id)));
} else {
  console.error(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 8).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}
