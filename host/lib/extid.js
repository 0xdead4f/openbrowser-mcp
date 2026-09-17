#!/usr/bin/env node

// Derive the pinned extension ID from extension/manifest.json's "key".
// Chromium computes an unpacked extension's ID as the first 128 bits of
// SHA-256 over the SPKI DER public key, hex, with 0-f remapped onto a-p.
// Because the key is committed, the ID is identical in every Chromium
// browser and every profile — which is what lets install.sh take no arguments.
//
// Usage: node host/lib/extid.js [path/to/manifest.json] [--json]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const positional = argv.filter((a) => !a.startsWith("--"));

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    "Usage: node host/lib/extid.js [path/to/manifest.json] [--json]\n" +
      "Prints the Chromium extension ID derived from the manifest's \"key\".\n"
  );
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(
  positional[0] ?? path.join(here, "..", "..", "extension", "manifest.json")
);

function fail(message) {
  process.stderr.write(`extid: ${message}\n`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
} catch (err) {
  fail(`cannot read ${manifestPath}: ${err.message}`);
}

const key = manifest.key;
if (typeof key !== "string" || key.length === 0) {
  fail(
    `${manifestPath} has no "key" field.\n` +
      "  Generate one with:\n" +
      "    openssl genrsa -out key.pem 2048\n" +
      "    openssl rsa -in key.pem -pubout -outform DER | base64 | tr -d '\\n'\n" +
      "  and paste the result as the manifest's \"key\"."
  );
}

const der = Buffer.from(key.replace(/\s+/g, ""), "base64");

// A PKCS#1 key pasted by mistake still base64-decodes and still hashes, so it
// would yield a plausible-looking but wrong ID. Reject it here instead.
try {
  crypto.createPublicKey({ key: der, format: "der", type: "spki" });
} catch (err) {
  fail(`manifest "key" is not a base64 SPKI DER public key: ${err.message}`);
}

const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

if (asJson) {
  process.stdout.write(
    JSON.stringify({ id, manifest: manifestPath, keyBytes: der.length }) + "\n"
  );
} else {
  process.stdout.write(id + "\n");
}
