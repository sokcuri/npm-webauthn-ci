# npm-webauthn-ci

Headless npm web login from GitHub Actions, with 2FA passed by a P-256 key held
as a PEM file and served to the page through a WebAuthn shim. Never publishes.

Tooling adapted from [nmpwaifu/gettodaysdate](https://github.com/nmpwaifu/gettodaysdate) (`.release/`).

## Setup

- Repository variables: `NPM_USERNAME`, `NPM_CREDENTIAL_ID`
- Repository secrets: `NPM_PASSWORD`, `NPM_P256_PRIVATE_KEY` (full contents of `private.pem`)

## Run

Actions → **npm login check** → Run workflow:

- `probe`: no secrets; checks whether Cloudflare blocks the runner's datacenter IP.
- `login`: full login test on `runs` fresh runners in sequence; artifacts hold `run.log` and screenshots.

Locally: `source ~/webauthn-keys/npm.env && node login-check.mjs [--headed]`
