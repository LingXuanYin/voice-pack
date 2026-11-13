# Official signatures

The manifest of the base part, the manifest of the protocol core, the published base part zip, and the version index at the official address are all signed by the official side with Ed25519; the runtime environment accepts only official versions. This file describes the format of the signature files, the trust list, the commands, and the grounds for deciding it this way. A third party can verify the official signature by following it, with minisign installed.

How a piece of content counts as an "official version" and how the two parts verify each other are in the sections "Wiring into the check" and "Mutual verification of the pack" of this file; the rules of the format itself (manifest, files, hashes) are in `FORMAT.md`, and the order of the check is in its section "Check".

## What is signed

| What is signed | Signature file | Who verifies |
|---|---|---|
| Manifest of the base part | Next to the manifest, `<manifest file name>.minisig` | The protocol core that every part carries; the app uses its own trust list |
| Manifest of the protocol core | Next to the manifest of the protocol core, same as above | Same as above |
| The published base part zip (one per version, downloaded by complete and when the app exports a full pack) | Next to the zip, `<zip file name>.minisig` | In complete, verified with the trust list in the protocol core; the app uses its own |
| The version index `index.json` at the official address (re-signed by the key of the time with every published version) | `index.json.minisig` next to it | In complete and when the app exports a full pack, the index is read only after its signature is verified with the trust list (complete uses the one in the protocol core, the app its own; `RELEASES.md`「Official releases: official address, file layout, version index」) |

A signature covers only the **original bytes** of the signed file: no newline conversion, no decoding and re-encoding.

## Signature file format

It is exactly a minisign signature file: four lines, with one newline at the end:

```
untrusted comment: <a line of description, not part of the signature>
<base64, 74 bytes: algorithm id `Ed` 2 bytes + key id 8 bytes + signature 64 bytes>
trusted comment: <a line of description, part of the signature>
<base64, 64 bytes: global signature>
```

- Signature: Ed25519 applied directly to the original bytes of the signed file.
- Global signature: Ed25519 over "the 64 signature bytes above + the UTF-8 bytes of the trusted comment". So a changed trusted comment is also detected; we use it to write `file:<file name>`, so a person can see at a glance whom this signature was made for.
- Key id: 8 bytes. For a key we generate, it is the first 8 bytes of the SHA-256 of the public key; for a key someone else generated with minisign, the key id is random, and the trust list accepts it just the same. When displayed, as in minisign, the 8 bytes are read as one little-endian integer and written as 16 upper-case hexadecimal digits.
- The same content, the same private key and the same trusted comment signed twice give exactly the same bytes (Ed25519 is deterministic, and the trusted comment carries no timestamp by default). When publishing, you can compare it byte for byte with the file already published.
- When reading a signature file, both `\n` and `\r\n` newlines are accepted, and extra blank lines at the end do not count.

A public key is written as the base64 string on the second line of a minisign `.pub` file, 42 bytes: `Ed` + key id 8 bytes + public key 32 bytes.

## Why minisign's legacy mode and not a format of our own

The earlier conclusion was "WebCrypto has no BLAKE2b, so we cannot verify each other with minisign". That holds only for minisign's **prehashed mode** (algorithm id `ED`, the default signing mode): it first computes BLAKE2b-512 of the file and then signs the hash. minisign also has a **legacy mode** (algorithm id `Ed`, produced by `minisign -S -l`): it applies Ed25519 directly to the file bytes, and the global signature of the trusted comment is also just Ed25519; neither needs BLAKE2b, and WebCrypto can do it.

The grounds, written by source:

- **Reading the source** (`src/minisign.c` of `jedisct1/minisign`, default branch `b6de4fe`, 2026-10-11; release 0.12, 2025-01-15; the verification logic of the two is the same):
  - `sig_load` accepts two algorithm ids: `Ed` has `hashed = 0`, `ED` has `hashed = 1`;
  - `verify` refuses only when `-H` is given and `hashed == 0` (it prints `Legacy (non-prehashed) signature found`), and by default `allow_legacy = 1`, so **by default, with no extra parameters, an `Ed` signature is accepted**;
  - `message_load(…, hashed)` with `hashed == 0` reads the whole file as the message as it is, with no hash;
  - a public key accepts only `Ed` (`pubkey_load_string` rejects anything else with `memcmp(pubkey_struct->sig_alg, SIGALG, …) != 0`), so our way of writing a public key is minisign's way of writing a public key.
- **Actually running it** (2026-10-14, the official release Windows binary of minisign 0.12):
  - a file signed by minisign with `-S -l` is verified by our `signature.mjs`, and the trusted comment is verified too;
  - a file signed by our code is verified by `minisign -V -p <public key file> -m <file>` with default parameters, exit 0, `Signature and comment signature verified`; with the public key not in a file and given inline with `-P <public key>`, it also verifies;
  - with `-H` (requiring prehashing), the same legacy-mode signature is rejected: `Legacy (non-prehashed) signature found`, exit 1. **For a third party to verify with `-H`, we would have to use prehashed mode, which cannot be done; so the commands in the docs for third parties do not use `-H`**;
  - with one byte of the file changed, minisign reports `Signature verification failed`, exit 1;
  - a trusted comment that is Chinese, contains a tab, is as long as 1000 bytes, or has CRLF newlines is verified by minisign in all cases.

Conclusion: **use minisign's public key and signature file format (legacy mode, `Ed`)**. This format has existing third-party implementations, and we do not need to start a separate one. There is only one cost: if some day a new version of minisign no longer accepts legacy mode by default, third parties will have to add a parameter to the command; we are not affected, because verification is our own code.

When we meet a prehashed (`ED`) signature, our verification does not pretend it can verify it; it reports `signature_algorithm_unsupported` clearly and tells the other side to use `minisign -S -l` instead.

### How a third party verifies the official signature

```
minisign -V -P <official public key> -m <signed file>
```

`<official public key>` is the base64 string of `public_key` in `protocol/trust.json` (minisign's `-P` takes it directly, with no need to save it to a file first); if you want to use a file, write it in `.pub` format: the first line `untrusted comment: minisign public key <key id>`, the second line that base64 string, and then `-p <public key file>`. The signature file is by default `<signed file>.minisig`, placed next to the signed file; if it is not next to it, add `-x <signature file>`. Do not add `-H`.

## Trust list

`protocol/trust.json`; the protocol core of every part carries one, and verification accepts only the public keys in this list. The app carries its own list of the same shape.

```json
{
  "version": "1.0",
  "keys": [
    { "public_key": "<the base64 string on the second line of minisign's .pub>", "comment": "description, may be omitted" }
  ]
}
```

- `public_key`: the base64 string on the second line of minisign's `.pub` (previous section).
- The public key is looked up in the list by the key id in the signature; if it is not found, the result is "not an official signature", and no other public key is tried. The key id is only a clue for finding the public key: a signature that states the official key id but was actually signed with another key still fails verification, because what is verified against is the public key in the list.
- The list may hold several public keys. After a key change, the new public key is added and **the old public key stays in the list**, so signatures of old versions can still be verified; two public keys in the list must not have the same key id.
- When the list is empty, verification always fails (`trust_list_empty`) and nothing passes: a cleared list does not turn into "no check".
- `version` is the version of the list itself, "major.minor"; other fields (for example the official address, used by complete) are not looked at by verification and are passed through unchanged.

### Official public key

`trust.json` now holds the first official public key.

- **Provenance**: the publisher of voice-pack generated this key; the private key is kept by the publisher and does not enter git or any pack. Only the public key goes into the repository. The official address changed (in the 1.x era it was on Cohub public files; from 2.0 it is on voice-pack's own GitHub Pages), but the public key did not change: signatures of old versions still verify.
- **Fingerprint**: the SHA-256 of the raw 32-byte public key, in lower-case hexadecimal. Use it for handover and for checking: decode the `public_key` in `trust.json`, drop the first 10 bytes (algorithm id 2 bytes + key id 8 bytes), and the remaining 32 bytes are the raw public key.
- **Where the key id comes from**: for our keys, the key id is computed from the public key, taking the first 8 bytes of the SHA-256 of the raw public key and writing them, when displayed, as 16 upper-case hexadecimal digits in little-endian order. For a key generated by minisign itself, the key id is random and not computed this way, and the trust list accepts it just the same; `publicKeyFromRaw` in `signature.mjs` writes a raw public key as an entry of the list, and the same raw public key always gives the same entry, so the content of the list can be recomputed and checked at any time.
- **Confirm that the private key and the public key in the list are a pair** (do it once after generating the key and before the first signing): `node protocol/cli.mjs keygen --key <private key file> --json`, and the `publicKey` in the output must be exactly the same as the `public_key` in `trust.json`; a more direct way is to sign a file with this private key and verify it with the default trust list: `sign <file> --key <private key file>`, `verify <file>`; only if it passes is it a pair.

### A lost or leaked private key

The only way is to release a new version and change the public key: the new key signs the next version, the protocol core of the next version carries the new public key, and the old public key stays in the trust list; old packs that have already gone out contain the old public key, and old versions can still be verified. The zip and signature of old versions stay at the official address, and packs made with an old version can still be completed: the version index is re-signed with the key of the time with every published version, and after a key change the list in an old pack (holding only the old public key) does not recognise it, so complete does not trust the index at that point and falls back to fetching directly the lowest version the pack requires, whose zip and signature verify with the old list (the rule of this fallback is written in `RELEASES.md`「A lost or leaked private key」 and is not repeated here). How the files at the official address are laid out is in `RELEASES.md`.

## Commands

All are in the command line of the protocol core (they work even when only the protocol core is present): `node protocol/cli.mjs <command>`; `node cli.mjs <command>` at the root of the base part works the same.

| Command | What it does |
|---|---|
| `keygen --out <private key file>` | Generates an Ed25519 key. The private key is written as PKCS8 PEM (the same as `openssl genpkey -algorithm ed25519`, readable by each other), with permissions for the owner only (0600). **It refuses if the file already exists** and does not overwrite silently. It prints the public key and the key id, and does not print the private key |
| `keygen --key <private key file>` | Reports the public key and key id from an existing private key: gives the entry to write into the trust list, and is also used to confirm that the private key and the public key in the list are a pair (see "Official public key") |
| `sign <file> --key <private key file> [--sig <signature file>] [--trusted-comment <one line>]` | Signs a file. By default it writes to `<file>.minisig`; the trusted comment is by default `file:<file name>` |
| `verify <file> [--sig <signature file>] [--trust <trust list.json>]` | Verifies a signature. By default it uses the `protocol/trust.json` carried by the protocol core; `--trust` swaps in another list for tests and third parties. On success it prints the key id and the trusted comment; on failure it exits 1 and reports the code |

A private key file may be PEM or DER. With `--json`, both output and errors are one line of JSON.

**The private key value never enters output, logs or error messages**: when reading the private key file fails, only the path and the reason the system gave are stated; if the format is wrong, only "not an Ed25519 PKCS8 private key" is stated, the content is not echoed, and the underlying error is not carried out as `cause`. The caller (the script used for publishing) must likewise not put the private key in command-line arguments or in printed environment variables; the path may be written, the content must not.

## Library interface

`protocol/lib/signature.mjs`, using only the platform's own WebCrypto, so it runs in browsers and in Node. All binary parameters are `Uint8Array` (raw bytes); strings are not accepted: a string would silently pass through one encoding, and then what is signed would not be the raw bytes of the file.

| Function | Description |
|---|---|
| `generateSigningKey()` | Generates a key: `{ privateKey: Uint8Array (PKCS8 DER), publicKey: string (minisign form), keyId: string }` |
| `publicKeyOf(privateKey)` | Derives `{ publicKey, keyId }` from a private key |
| `publicKeyFromRaw(rawPublicKey)` | Writes a raw public key (32 bytes) in the form used in the list, with the key id computed from the public key: `{ publicKey, keyId }` |
| `signMessage(message, privateKey, { trustedComment?, untrustedComment? })` | Returns the text of the signature file |
| `verifyMessage(message, signatureText, trustList)` | On success returns `{ keyId, trustedComment, untrustedComment }`; on failure throws |
| `parseTrustList(trustList)` | Reads and checks a trust list, returns `{ version, keys: [{ keyId, publicKey, comment? }] }` |
| `parsePublicKey(text)` | Reads a minisign public key (the whole text of a `.pub` file, or the base64 string on its second line), returns `{ keyId, publicKey: Uint8Array (32 bytes)}` |
| `SIGNATURE_SUFFIX` | `'.minisig'` |

### Errors (codes of `VoicePackError`)

| code | When |
|---|---|
| `ed25519_unavailable` | The runtime environment has no Ed25519: there is no `crypto.subtle` (in a browser, not a secure context), or `crypto.subtle` does not recognise Ed25519 (before Chrome/Edge 137, Firefox 129, Safari 17, before Node 16.17). **Both signing and verifying report this, and never pass silently** |
| `trust_list_invalid` | The shape of the trust list is wrong (no version number, keys is not an array, a public key cannot be read, a duplicate key id); a trust list file read by the command line that is not valid JSON is also this code |
| `trust_list_empty` | The list has no public key at all |
| `signature_malformed` | The format of the signature file is wrong: number of lines, prefix, base64, length. `details.line` is the line with the problem |
| `signature_algorithm_unsupported` | The algorithm id is not `Ed`. Prehashed (`ED`) is explained separately: it needs BLAKE2b-512, which WebCrypto does not have |
| `signature_untrusted_key` | The key used for the signature is not in the trust list: not an official signature. `details.keyId`, `details.trusted` |
| `signature_invalid` | The signature does not match this content: the content was changed, or the signature was not made for it |
| `signature_comment_invalid` | The trusted comment does not match its signature: the signature file was changed |
| `private_key_invalid` | The private key is not an Ed25519 PKCS8 |
| `public_key_invalid` | The public key cannot be read: length, algorithm id, base64 |
| `key_id_invalid` | The key id is not 16 hexadecimal digits |
| `comment_invalid` | A comment in the signature has a newline, is empty, or is too long (limit 1000 bytes) |
| `file_unreadable`, `file_unwritable`, `file_exists` | A problem when the command line reads or writes a file (private key, trust list, the signed file, signature file) |

## Who uses which public key

- **In an agent environment**: verify with the protocol core that comes with the pack (`protocol/trust.json`). If the whole pack together with its protocol core was changed, this cannot be detected: this is the boundary of this verification. What the command line does: the trust list is taken from the `protocol/trust.json` carried by **the protocol core that is running** (the one running `node protocol/cli.mjs`), and not from the pack being checked: the list in a pack was written by the author of the pack and cannot be used to recognise that pack.
- **Apps that embed this library**: verify with a trust list they carry themselves, not depending on the one in the pack.
- **Servers that receive share files**: use the `protocol/trust.json` carried by the base part they have deployed themselves, and do not read the list inside the uploaded share file (see "Who passes what").
- **Complete**: downloads the base part zip at the official address and its signature, and verifies with the trust list in the protocol core; if it does not verify, it reports an error, with no fallback.

## Wiring into the check

When checking a pack (`check`, `pack`, `unpack`; in the library `checkPart`, `checkShareFile`, `inspectShareFile` plus `lib/official.mjs`), the official signature is used like this:

| Part | Verified? | How |
|---|---|---|
| Manifest of the base part | Yes | `manifest.json.minisig` must be next to the manifest, signed by one of the public keys in the trust list, and what it signs is the bytes of this manifest |
| Manifest of the protocol core (a full pack has two: `protocol/` of the role part, and `voice-pack/protocol/` in the base part) | Yes | Same as above, each verified on its own |
| Manifest of the role part | No | The identity of the author is left to the community account; whether there is a signature file next to the role part and what it says do not affect the check |

**Why verifying the manifest is enough**: the manifest lists the SHA-256 of every file in the part, and the check compares them one by one; the manifest is signed by the official side, which amounts to the official side vouching for the content of every file the manifest lists. Change a file without changing the manifest, and the hash catches it (`file_modified`); change the manifest without changing the signature, and verification catches it (`signature_invalid`); even replace the signature with one made by your own key, and the trust list catches it (`signature_untrusted_key`). Each of the three layers catches one kind, so a "modified protocol core" cannot pass however it is modified, unless the running protocol core and its trust list are replaced together (the boundary of this verification, see above).

A base part or protocol core with no signature file is refused by default (`signature_missing`). `allowUnsigned` (`--allow-unsigned` on the command line) lets through only parts that "have no signature file", and the report says that it was not verified (`skipped: 'unsigned'`); it is for local development and tests: so that things can run while the code of the base part is being changed and the signature has not been published yet. A part that has a signature file is verified as usual, and a wrong signature is still refused; an empty list still lets nothing through. **This is not turning verification off**, but it is an escape hatch: a pack let through with it has not been verified and is not an official version, so the user documentation (`SKILL.md` of the base part, the templates of `SKILL.md` and README of the role part) does not mention it by a single word: whoever edits those documents must hold to this.

Options of `check`, `pack`, `unpack`:

| Option | Effect |
|---|---|
| `--trust <trust list.json>` | Swaps in another trust list, for tests and third parties; the official check does not pass it. If it cannot be read or its shape is wrong, exit 1, with no fallback to the default list |
| `--allow-unsigned` | See above |

`seal` neither verifies signatures nor does the mutual verification: the part being sealed has no signature yet, and the signature comes after `seal` (seal, `sign`, then `pack`). Sealing again deletes the old signature (the manifest changed, so the old signature is void).

### The caller must choose a signature verification policy

The library's entry points that handle things coming from outside do not decide "verify or not" for the caller: the caller must choose explicitly, and gets an error if it does not. This is so that none of the places that embed the library (the app's import), complete, and the server that receives share files can quietly let in a non-official base part or protocol core because someone forgot to pass it.

| Entry | What it handles | Must a policy be chosen? |
|---|---|---|
| `checkShareFile`, `inspectShareFile` (`lib/share.mjs`) | A share file from outside | Yes |
| `checkPart` (`lib/check.mjs`) | The file set of a pack directory from outside (the whole pack after complete, a pack unpacked on the server, ...) | Yes |
| `openShareFile` (`lib/share.mjs`) | A container that only reads the zip, and does not check the manifest, hashes or signatures | No: it draws no conclusion. But the files it hands out have not been verified, so only `share.mjs` itself references it; to get files out of a share file, go through `inspectShareFile`, where `opened.files` is the file set and it may be used only when `report.ok` is `true` |
| `selfCheckPart` (`lib/check.mjs`) | The library's internal self-check: the role part being made when making a pack (`packRolePart`), the part being sealed by `seal` | No: it does not verify signatures, does not do the mutual verification, and does not accept these options. What it checks is what was just made itself; it must not be used for handling outside input |

Options (the combinations of `verifySignature` and `allowUnsigned`):

| `verifySignature` | `allowUnsigned` | What happens |
|---|---|---|
| Given | Not written or `false` | Strict: the base part and the protocol core must each have an official signature, and the verification function has the say |
| Given | `true` | Verifies, but lets through parts that have no signature file (`--allow-unsigned` on the command line) |
| Not given | `true` | There is no way to verify: parts with no signature file are let through, and a part with a signature file cannot be verified and reports `signature_unverifiable`, and is not counted as passed |
| Not given | Not written or `false` | Throws `signature_policy_missing`, before reading any input (not even the shape of the file set or the bytes of the share file have been looked at) |

`mutual` is on by default at these entries, and the caller may write `mutual: false` explicitly. `allowUnsigned` exists only in the options of the entries; `createSignatureVerifier` itself is always strict.

### Who passes what

Where the list comes from: the command line uses the `protocol/trust.json` carried by the protocol core that is running; an app that embeds this library uses the one it carries itself; the server that receives share files uses the one carried by the base part it has deployed itself. In all three places, **no list carried elsewhere inside the thing being checked is used** (it was written by the author of the pack and cannot be used to recognise that pack). The app and the server do not write `allowUnsigned` in a trust decision: the product has no choice of "do not verify"; there is only one case where it may be written on purpose: opening a file that is used only to be read and is not treated as trusted content ("Read-only comparison" below). `--allow-unsigned` on the command line is for local development.

- **App embedding this library (import, export)**: uses the trust list built into the app.
  ```js
  const verifySignature = createSignatureVerifier(appTrustList);       // appTrustList goes with the app's version, and the old public key stays when the key changes
  const report = await checkShareFile(bytes, { verifySignature, env });   // mutual is not written, and is done by default
  ```
  For a pack with only a role part, the `mutual` of the report is `{ checked: false, reason: 'no_base' }`: on import, the app checks against the base part the app itself carries, without completing and without going online. The app does not need to carry the whole base part, only the three things the mutual verification uses: the version of the base part (`manifest-fields.json` at the root), the protocol version (`PROTOCOL_VERSION` of the library), and the capability vocabulary (`vocab/capabilities.json`). When checking, use the library's own rule, and do not write it again in the app:
  ```js
  const problems = mutualProblems(roleManifest, { protocol, version }, capabilityVocabularyBytes, { maxJsonBytes });
  // the shape of the problems is the same as in the check report: protocol_incompatible, base_too_old, capability_unknown, capability_vocabulary_invalid; if there is any, refuse, and upload not a single byte
  ```
  When exporting a full pack, the base part is the version the app uses fixedly, and it is fetched back from the official address with `fetchOfficialVersion` (`protocol/lib/release-fetch.mjs`): the version index is read, and the zip, its signature and the content inside are all verified; after it is put into the pack and the pack is made, the whole file set is checked once more with the app's trust list, and if it does not pass, it is not handed out. To get a file out of a share file (import), use `inspectShareFile`, and use `opened.files` only after the report has passed; do not reference `openShareFile` (see the table above).
- **Complete**: the downloaded base part zip is first verified itself with `verifyMessage(zip bytes, signature text, trust list)` (these steps are in `fetchOfficialEntry` of `lib/release-fetch.mjs`: check the size and SHA-256, verify the signature of the zip, check the content inside with `inspectShareFile`; complete and the export of a full pack share it); after it is put into `voice-pack/` of the role part, **do the mutual verification once more on the whole pack** (`lib/complete.mjs`):
  ```js
  const report = await checkPart(filesWithBase, { verifySignature: createSignatureVerifier(trustList) });
  if (!report.ok || !report.mutual.checked) { /* complete did not succeed: report an error, no fallback */ }
  ```
  `trustList` is the `protocol/trust.json` carried by the protocol core that is running (in an agent environment, it is the protocol core that comes with the pack, which is the boundary of this verification, see the previous section). After complete, `mutual.checked` must be `true`; if it is not, the base part has not landed where it should, and it is treated as a failed complete. When taking files out of the base part zip, likewise do not reference `openShareFile` (see the table above).
- **Servers that receive share files**: use the `protocol/trust.json` **carried by the base part the server itself deployed**, and do not read the list in the uploaded share file.
  ```js
  const trustList = JSON.parse(await readFile(path.join(basePartDir, 'protocol', 'trust.json'), 'utf-8'));
  const report = await checkShareFile(bytes, { verifySignature: createSignatureVerifier(trustList), env: { fetch: serverFetch } });
  ```
  `mutual` is done by default; a pack with only a role part cannot be done (`no_base`), and whether to accept it is decided by the server itself. The `env.fetch` used for external resources is injected by the server, and must carry network policy such as not pointing to the internal network (see `FORMAT.md`「External resources」).
- **Read-only comparison**: when opening a source pack, `allowUnsigned: true` is written and no verification function is given (the same as when the command line hands in a source pack while making a pack). This is deliberate, not a forgotten verification: the source pack is only read to be compared with the new pack (duplicate check), its content does not enter the new pack, is not displayed and not used, and the flow does not go online, does not sign, and does not look at the conclusion of the check report, so this is not a trust decision. Whatever uses things from a share file (import, complete, receiving a release) still goes through the verification in the items above.
- **Command line (`check`, `pack`, `unpack`)**: `cli/checking.mjs` always gives a verification function and turns the mutual verification on; `--allow-unsigned` adds `allowUnsigned: true`, which is the second row of the table above.

The interface of the library (`protocol/lib/official.mjs`, using only the platform's own API, so it runs in browsers and in Node):

```js
import { createSignatureVerifier } from './protocol/lib/official.mjs';
const verifySignature = createSignatureVerifier(trustList);
const report = await checkPart(files, { verifySignature });   // mutual is on by default
```

`createSignatureVerifier` checks the trust list when it is built (a wrong shape throws `trust_list_invalid`), and takes a snapshot of it, so that a caller changing the list object it holds later does not affect it. The signature of each part in the report is `{ part, file, present, verified, skipped?, keyId? }`, and the meaning of the fields is in the header of `lib/check.mjs`.

Besides the codes in the section "Errors (codes of `VoicePackError`)", a verification failure may also be `signature_missing` (the base part or protocol core has no signature file; `details.path` is the file that should be there); the `details.path` of every verification failure is the full path of the signature file within the whole pack. An entry that does not choose a policy throws `signature_policy_missing` (`details.entry` is which entry); when only `allowUnsigned: true` was chosen and a part carries a signature file, the report has `signature_unverifiable`.

## Mutual verification of the pack

A role part is checked against the base part it carries (`checkPart`, `checkShareFile` and `inspectShareFile` do it by default, and write `mutual: false` to not do it; the rules are in `lib/mutual.mjs`; `check`, `pack` and `unpack` on the command line always do it). The four checks (integrity, version, capability, content) land like this:

| Requirement | How it is checked | code |
|---|---|---|
| Integrity: every file agrees with the hash recorded in the manifest | Done by the check for each part on its own (`FORMAT.md`「What the check reports」step 3), not in the mutual verification | `file_modified` etc. |
| Version: the protocol versions of the two parts are compatible | `requires.protocolMajor` of the role part equals the protocol major version of the base part; the minor version does not matter (compatible within one major version) | `protocol_incompatible` |
| Version: the base part is not lower than the minimum version the role part requires | The version of the base part is not lower than `requires.baseMin`, compared in semantic versioning order: a pre-release is lower than the corresponding release, and build metadata does not take part | `base_too_old` |
| Capability: for every feature in the role part, the base part recognises its required capabilities | Every capability is a name in the base part's capability vocabulary (the keys of `capabilities` in `vocab/capabilities.json`); each missing capability is reported once, with all the features that need it listed | `capability_unknown`; if the vocabulary cannot be understood, `capability_vocabulary_invalid` |
| Content: at least one segment of reference audio and its text | Not in the mutual verification: this is the manifest's own rule, judged and reported in the manifest check (`minItems` and `minLength` in the schema plus the semantic rule `text_blank`, `FORMAT.md`「4.5 Semantic rules」rule 10). The same rule is judged in one place and reports an error in one place | `manifest_invalid` |

A pack with only a role part and no base part cannot have the mutual verification done: the `mutual` of the report is `{ checked: false, reason: 'no_base' }`, and the text report of the command line says "not done" and the reason. When such a pack enters an environment and the base part is completed, the mutual verification is done once more against the base part that came with the completion.

The results of the two checks are reported each on its own and do not hide each other: a wrong signature does not make the mutual verification not run, and a failed mutual verification does not make the signature verification not run.

### Errors (new codes after signatures and the mutual check were wired in)

| code | When |
|---|---|
| `signature_missing` | The base part or protocol core has no signature file |
| `signature_unverifiable` | Only `allowUnsigned: true` was chosen, no verification function was given, and this part carries a signature file: it cannot be verified, and is not counted as passed. `details.path` is the signature file |
| `signature_policy_missing` | An entry on the trust boundary (`checkPart`, `checkShareFile`, `inspectShareFile`) did not choose a verification policy: neither `verifySignature` nor `allowUnsigned: true` was given. **It is thrown, not put into the report**, before any input is read. `details.entry` is the name of the entry |
| `protocol_incompatible` | The protocol major version the role part requires differs from that of the base part. `details`: the required, the actual, and the base part's protocol version |
| `base_too_old` | The base part is lower than the minimum version the role part requires. `details`: the required and the actual version |
| `capability_unknown` | A feature of the role part needs a required capability that is not in the base part's vocabulary. `details.capability`, `details.features` |
| `capability_vocabulary_invalid` | The base part's capability vocabulary is missing (and not listed in the manifest either), is not JSON, has the wrong shape, or is too large. `details.reason` |
| `signature_hook_invalid` | The verification hook returned something other than `{ ok }` (a programming error) |

## How to test

When testing code related to signatures: generate keys on the spot, or use fixed data clearly marked "for testing only" (it contains only a public key and no private key), and **never use the official private key**. Use signatures produced by real minisign 0.12 as known answers from an independent source. The bad-pack cases wired into the check (wrong signature, modified protocol core, unsupported protocol major version, base part version too old, missing required capability) are signed with test keys generated on the spot.
