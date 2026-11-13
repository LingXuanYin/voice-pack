# Official releases: official address, file layout, version index

The official base part (the runtime environment accepts only official versions) is published in a directory at the official address. Complete (fetching the official base part back), exporting a full pack from an app that embeds this library, and publishing all follow this one file, and the layout code exists in one place: `lib/releases.mjs`. The signature format, the trust list, and the commands are in `SIGNATURES.md` and not repeated here.

## The official address

The `official_url` in the trust list `trust.json`: an `https` address ending with `/`, the directory where the official base part lives, with no username or password, query string, or fragment. Since protocol 2.0 it is `https://lingxuanyin.github.io/voice-pack/releases/`: the `releases/` directory in the GitHub Pages site of the voice-pack repository, where all published versions (from 1.0.0) are; the signature files are identical, byte for byte, to those published in the 1.x era. When there is no `index.json` at the official address (a request for it gets 404), the reading side treats it as "not published yet" (`official_unpublished`).

What is hard-coded in the 1.x programs is the old address, a directory of public Cohub files (`https://public.cohub.live/p/59c3cf35-a588-40b1-9e64-c5c9caeb417d/voice-pack-base/`). 1.0.0 to 1.0.9 (there is no 1.0.3: it was never published) are left there unchanged, for the 1.x programs already installed out there, and no new versions are published to it any more.

The trust list travels with the protocol core and every part carries it, so having only one part is enough to know where to fetch the official versions. Signature verification does not look at this field (`SIGNATURES.md`「Trust list」).

## What is in the directory

The directory holds four kinds of files, flat, with no subdirectories:

| File | Contents | After publishing |
|---|---|---|
| `<name>-<version>.voicepack.zip` | The base part of this version, as a share file (`FORMAT.md` section 8), matching the default file name of the `pack` command | Immutable |
| `<name>-<version>.voicepack.zip.minisig` | The signature of the zip above | Immutable |
| `index.json` | The version index: which versions have been published | Updated every time a version is published |
| `index.json.minisig` | The signature of the version index | Same as above |

`<name>` follows the protocol major version of this version (`FORMAT.md` sections 13 and 14, and `lib/names.mjs` in code): versions of protocol 2.x and 3.x are called `voice-pack-<version>.voicepack.zip`, and versions of protocol 1.x (1.0.0 to 1.0.9, no 1.0.3) are called `cohub-voice-studio-<version>.voicepack.zip`. Files with the two names coexist in one directory, and version numbers do not repeat, so they do not collide.

`<version>` is the official version number: a semantic version without build metadata (the part after `+` takes no part in version precedence; two versions that differ only in build metadata would get two file names yet count as the same version, so they are not allowed).

**A published version is immutable**: the same version number is always the same bytes; once published, the zip and its signature are not changed again. To change the content, change the version number. Reason: complete packs already out in the world, complete results already fetched, and SHA-256 values others have noted all assume that "this version number is this content".

## Version index (`index.json`)

JSON in UTF-8, two-space indentation, LF line endings, one newline at the end: the same content writes the same bytes, so the signature is stable.

```json
{
  "protocol": "2.0",
  "versions": [
    { "version": "1.0.0", "protocol": "1.0", "size": 361234, "sha256": "<64 位小写十六进制>" },
    { "version": "2.0.0", "protocol": "2.0", "size": 1234567, "sha256": "<64 位小写十六进制>" }
  ]
}
```

(The `sha256` placeholder `<64 位小写十六进制>` means 64 lowercase hex digits.)

| Field | Meaning |
|---|---|
| `protocol` | Which version of the index notation this index is written in ("major.minor"). If the major version is not understood, do not read it; if the minor version is newer than your own, ignore the fields you do not recognize. The index notation has not changed since 2.0, and programs of protocol 3.0 still write `"2.0"` (`INDEX_PROTOCOL` in `lib/releases.mjs`; why it is not 3.0 and which major versions can be read are in its file header) |
| `versions[]` | Every published version, sorted from low to high by semantic version precedence, with no repeated version numbers |
| `versions[].version` | The official version number |
| `versions[].protocol` | The protocol version in the manifest of this version's base part. With it, complete can pick a version whose protocol major version matches without downloading; what the zip of this entry is called is also decided by its protocol major version (see "What is in the directory" above) |
| `versions[].size`, `versions[].sha256` | The byte size and SHA-256 of this version's zip, computed over the raw bytes of the zip file |

The index is signed by the official key, and the signature is in `index.json.minisig`. **Whoever reads the index verifies the signature first and only then trusts it** (`verifyMessage`, with the trust list). If the index has no signature or fails verification, treat it as having no trustworthy content, and do nothing on the basis of it.

## How to fetch a version

The reading side (complete, an app exporting a full pack):

1. Take the official address from the trust list (`officialUrlOf`).
2. Read `index.json` and `index.json.minisig` (each request carries a fresh `cb` parameter, because right after a publish the two files may not match, see "Caching"), verify the signature, then parse (`parseVersionIndex`). When the signature is made by a key outside the trust list (the official key was changed and the list is old) there is a fallback, see "A lost or leaked private key".
3. Pick a version from `versions[]`. Which one is the reading side's own business: complete looks for the highest version "within the same major version, not lower than the minimum version, and with a matching protocol major version" (rules and reasons in `FORMAT.md`「Complete」); an app embedding this library uses one fixed version, and when exporting a full pack it fetches by version number (`fetchOfficialVersion`) and does not ask "which is the latest now", and it publishes the app only after this version has been published.
4. Read this version's zip and the zip's signature. The zip's byte size and SHA-256 must equal those in the index, the zip's own signature must verify (`verifyMessage`), and then check the contents of the zip: `inspectShareFile(zip, { verifySignature: createSignatureVerifier(trust list) })` (the entry point must choose a signature verification policy, and not choosing throws `signature_policy_missing`, see `SIGNATURES.md`「The caller must choose a signature verification policy」; `createSignatureVerifier` is in `lib/official.mjs`, and it verifies the signatures of the two manifests of the base part and the protocol core inside the zip).
5. Use it only if everything passes. If any step fails, report an error that names the step; no fallback and no switching to another version.

To read files use `readPublished(env, address, options)`: it uses only the injected `env.fetch`; `404` means "not published yet" (it returns `{ found: false }`); a network error, timeout, `5xx`, or `429` is retried (3 tries in total by default, with an interval of 1 second that doubles each time); other failures (`401`, `403`, etc.) report `published_unreadable` directly and are not treated as "absent". Reading a response has a byte limit, and it stops when exceeded.

## Caching

**Measurements of the official address (GitHub Pages).** Measured from 04:49 to 04:51 (UTC) on 2026-10-21 by looking at response headers with `curl -D -`. What was measured is another site on the same hosting under the same account, not voice-pack's own address: before the first publish there was nothing at that address to measure.

- A 200 response carries `Cache-Control: max-age=600` and an `Expires` about ten minutes later; 200 and 404 responses both carry `Access-Control-Allow-Origin: *`.
- There is a CDN in front (the response headers have `X-Served-By`, `X-Cache`): the first request is `MISS` with `Age: 0`, later ones are `HIT` and `Age` keeps rising.
- **The query string is not part of the cache key**: a request with `?cb=<A>` was `MISS`; a few seconds later a request with a never-requested `?cb=<B>` was `HIT`, `Age: 5`, same `ETag`; then a request for the same file without a query was `HIT`, `Age: 10`.
- Putting `Cache-Control: no-cache` in the request cannot get around the CDN: `HIT`, `Age: 18`.
- A 404 answer is cached too: for the same nonexistent file, the first request was `MISS` and the second `HIT`, `Age: 4`. No `Cache-Control` was measured in the 404 response, and how long it can be cached has not been measured.
- A request over `http://` gets 301, pointing to `https://`.

**What the reading side does.**

- **Version zips and their signatures are immutable, so caching does them no harm; read from the original address** (complete, an app embedding this library exporting a full pack).
- **The version index and its signature are overwritten; add the `cb` parameter when reading them**: `readPublished` with `cacheBust: true` carries a fresh random value with each request. What it avoids is the reading side's own cache: the HTTP cache stores by the full address, so a different `cb` is a different entry (derived from the HTTP rules, not measured in a browser). It cannot get through the official address's CDN. This method needs no custom request header, so a cross-origin read in a browser does not cost an extra preflight; the request header `Cache-Control: no-cache` is useless at both addresses, so it is not used.
- **For about ten minutes (`max-age`) after a new version is published, the index and signature you read may predate it or may not match each other**:
  - If you read a pair from before the publish: no problem, they are still officially signed and match each other, they just do not list the version just published. A reader who wants that version cannot get it: a fetch by version number reports `version_unpublished`, and complete, if it cannot pick a version that meets the requirements, reports `base_version_unavailable`.
  - If you read the new index with the old signature, or the old index with the new signature (the two files are each cached on their own): signature verification fails, `signature_invalid`. When the reading side fails verification, it waits 3 seconds, changes to a new `cb` and reads once more (`readVersionIndex`), but changing `cb` does not get through the CDN, and what is read is mostly still the cached pair, so the re-read does not help and the error is reported all the same. After the cache expires the pair matches: if you hit it right after a publish takes effect, try again in about ten minutes.
- **A response saying it does not exist yet is cached too**: a file that someone read before the publish (for example `index.json` before the first publish) may still return 404 for a while after the publish, and the reading side treats it as "not published yet" (`official_unpublished`, `zip_missing`); how long this lasts has not been measured; try again after a while.

**Old address** (1.x programs still read it). Measured on 2026-10-15 on a published static file there, with Cloudflare in front of the hosting:

- The response header is `Cache-Control: public, max-age=14400, stale-while-revalidate=3600`. By the HTTP rules, a browser cache can treat the file as fresh for four hours and not ask the network in that time (derived from the rules, not measured in a browser).
- The copy on the edge node is much shorter-lived: with a `HEAD` every 30 seconds on a brand-new cache entry, `cf-cache-status` was first `MISS`, then `HIT` all the way, with `Age` rising to 272 seconds; at 303 seconds it was `UPDATING` (expired, this time it still returns the old copy while updating from the origin); the next time `Age` went back to 30 and `HIT`. So a copy lives about 5 minutes.
- Adding a query parameter (`?cb=...`) to the address is another cache entry: the first time `MISS`, the second `HIT`, and the origin returns the same file (`ETag` and length unchanged). There `cb` gets through the CDN; at the official address it does not.
- Putting `Cache-Control: no-cache` in the request (adding `Pragma: no-cache` is the same) is useless: the cached copy is returned all the same (`Age` is not reset to zero).

**Cross-origin requests.** An app in a browser can read both addresses directly. The hosting of the official address returns `Access-Control-Allow-Origin: *` in its responses (the measurement above, taken on another site); the old address echoes the request's `Origin`, with `Vary: Origin`, and `Access-Control-Allow-Headers` echoes the headers asked for in the request (measured on 2026-10-15 with `Origin: https://cohub.live`).

## How to publish

Official versions are made by the publisher's release script, not uploaded by hand: package, sign, update the version index, then push the two branches `main` and `gh-pages` and the version tag `v<version>` to `LingXuanYin/voice-pack` with one `git push --atomic`; the official address is the `releases/` directory on the `gh-pages` branch. A prerelease (the version number has a `-`, for example `3.0.0-beta.25`) pushes only the tag and `gh-pages`: `main` (what the two ways of installing install) and the page stay at the previous stable version; its four files go into `releases/` and into the index like a stable version's and are likewise immutable, and they are not fetched automatically when picking a version (`FORMAT.md`「Complete」). Only the points that affect the reading side are recorded here:

- The version number is written in files: the base part's in `manifest-fields.json` at the root, the protocol core's in `protocol/manifest-fields.json`, each for its own. If any file of the base part changes, the version number must go up (if a file in `protocol/` changes, the protocol core's own version number must go up too); one version number is published only once, and an already published version number cannot be published again with different content (`release_conflict`).
- The zip is a share file stored entirely uncompressed, and the signature is deterministic, so the same base part and the same key produce a zip and a signature with exactly the same bytes, the same on Node and Bun (`FORMAT.md` 8.3). At publish time this is used to check against the already published version: only identical bytes count as the same version.
- The four files of a version (its zip, the zip's signature, the updated index, the index's signature) are in the same commit on `gh-pages`, so for a version listed in the index, its zip and signature are published together in the same commit (cache delay aside, see "Caching"). `main`, `gh-pages` and the tag (for a prerelease, `gh-pages` and the tag) either all arrive or none arrive (`--atomic`), and there is never a half-published version.
- A version zip and its signature never overwrite an existing file when published (if it exists, an error should be reported; this is exactly what immutability needs); only the version index and its signature are rewritten at every publish, signed by the key of that time.

## A lost or leaked private key

For how to change the key (the new public key is added to the trust list and the old public key is kept), see `SIGNATURES.md`「A lost or leaked private key」. What matters here is what the reading side does after the key is changed:

- **The version zip and its signature do not change**: the zip and signature of a published version stay at the official address forever, not deleted and not overwritten. After the key is changed, the zip of an old version is still signed by the old key, and so are the two manifests of the base part and the protocol core inside it.
- **The version index changes**: with every version published the index is re-signed by the key of that time, so after the key is changed it is signed by the new key. A pack made before the key change, that has only a role part, carries in its protocol core a trust list with only the old public key, and cannot verify the current index: reading the index throws `signature_untrusted_key`.
- **Fallback**: the side that reads the index (complete, and an app that fetches the base part by version number), on meeting this error, does not trust this index and falls back to the very version it wants.
  1. Which version: complete wants the `requires.baseMin` of the pack itself (not "the highest in the same major version": that one is mostly signed by the new key and the old list cannot verify it; if `baseMin` carries build metadata, that is, the part after `+`, remove it before fetching: build metadata takes no part in version precedence, and official version numbers do not carry it); an app wants the version it corresponds to.
  2. Without going through the index, read `<name>-<version>.voicepack.zip` and its `.minisig` directly (for file names see "What is in the directory" above; `<name>` is decided by the protocol major version the pack requires: `requires.protocolMajor`).
  3. The checks are the same as step 4 of "How to fetch a version": verify the zip's signature with the trust list, then check the contents of the zip (including the official signatures of the two manifests of the base part and the protocol core), and the version number of the base part must equal the one wanted. Only one thing is missing: the zip's byte size and SHA-256 must equal those in the index. There is no trustworthy index to compare against, and the zip's signature already vouches for each of its bytes.
  4. Whether the protocol major version fits cannot be seen beforehand from the index; it is checked when mutual verification is done on the whole pack after it is put into the pack (`protocol_incompatible`).
- **What is not rolled back**: other problems with the index (signature does not match, no signature file, content cannot be understood, cannot be read) are reported all the same, since they are not caused by the key change; after the fallback, problems with the zip (wrong signature, no signature file, cannot be fetched, content not acceptable) are also reported all the same, with no further fallback and no switching to another version.
- **Cost**: the fallback fetches the lowest version the pack requires, not the current latest. An old pack recognizes only the keys in the old list; to use the new version, make the pack again with the base part of the new version.

So packs made with an old version can still be completed. The programs are in `lib/release-fetch.mjs` (`fetchOfficialVersionDirect`, `isUntrustedIndexError`) and `lib/complete.mjs`.

## What this document does not cover

- How complete picks a version: the rules and reasons are in the section `FORMAT.md`「Complete」, and the program is in `lib/complete.mjs`. The steps of reading the index, fetching the zip, and verifying the signature are in `lib/release-fetch.mjs`, and complete and an app exporting a full pack use the same copy.
