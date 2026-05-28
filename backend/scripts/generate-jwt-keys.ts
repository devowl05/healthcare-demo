/**
 * Generate a fresh Ed25519 keypair and print base64-of-PEM strings ready to
 * paste into `.env` for the JWT signing keys.
 *
 *   bun run scripts/generate-jwt-keys.ts
 *
 * Output two lines you can append to .env:
 *
 *   JWT_SIGNING_KEY_PRIVATE=<base64>
 *   JWT_SIGNING_KEY_PUBLIC=<base64>
 *
 * The `auth.ts` middleware accepts both raw PEM and single-line base64-of-PEM;
 * base64 avoids the multi-line-quoting trap that breaks most dotenv parsers.
 */

import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true,
});

const privPem = await exportPKCS8(privateKey);
const pubPem = await exportSPKI(publicKey);

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

process.stdout.write(`JWT_SIGNING_KEY_PRIVATE=${b64(privPem)}\n`);
process.stdout.write(`JWT_SIGNING_KEY_PUBLIC=${b64(pubPem)}\n`);
