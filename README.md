# npm-webauthn-ci

Headless **npm web login from GitHub Actions**, with 2FA passed by a P-256 key
held as a PEM file and served to the login page through a WebAuthn shim — no
hardware token, no human at publish time. **This repo only tests login; it never
publishes.**

Packaged so any **org, team, or repository** can reuse it three ways:

| Reuse level | Use when | How |
| --- | --- | --- |
| **Composite action** | you want step-level control inside your own job | `uses: sokcuri/npm-webauthn-ci@v1` |
| **Reusable workflow** | you want a ready-made job | `uses: sokcuri/npm-webauthn-ci/.github/workflows/reusable-login.yml@v1` |
| **Local script** | you want to check from your laptop | `node login-check.mjs` |

Tooling adapted from [nmpwaifu/gettodaysdate](https://github.com/nmpwaifu/gettodaysdate) (`.release/`).

---

## One-time setup (per npm account)

Each account that will log in this way needs a P-256 credential registered once,
by a human. See [SETUP.md in the upstream repo](https://github.com/nmpwaifu/gettodaysdate/blob/master/SETUP.md) — or, with this repo checked out:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
# Start Chrome with --remote-debugging-port=9222, sign in to npm, open the
# "Add security key" page, then:
node register-credential.mjs --key-dir=. --label="CI login key"
```

Record the printed **credential id**. You now have the four values every caller needs.

### Per-repo configuration

| Where | Name | Value |
| --- | --- | --- |
| Variable | `NPM_USERNAME` | npm account username |
| Variable | `NPM_CREDENTIAL_ID` | credential id from registration |
| Secret | `NPM_PASSWORD` | npm account password |
| Secret | `NPM_P256_PRIVATE_KEY` | full contents of `private.pem` |

```bash
gh variable set NPM_USERNAME      -R <owner>/<repo> -b '<username>'
gh variable set NPM_CREDENTIAL_ID -R <owner>/<repo> -b '<credential-id>'
gh secret   set NPM_PASSWORD          -R <owner>/<repo>
gh secret   set NPM_P256_PRIVATE_KEY  -R <owner>/<repo> < private.pem
```

Nothing is hardcoded: username, credential id, password, and key are all read
from these values at run time.

> **Private action across orgs:** if this repo is private, each consuming org must
> be allowed to use it (Org → Settings → Actions → *Access*, or make this repo
> public). Public callers can reference `@v1` directly.

---

## 1. Composite action

```yaml
jobs:
  verify-login:
    runs-on: ubuntu-latest
    steps:
      - uses: sokcuri/npm-webauthn-ci@v1
        with:
          npm-username:      ${{ vars.NPM_USERNAME }}
          npm-credential-id: ${{ vars.NPM_CREDENTIAL_ID }}
          npm-password:      ${{ secrets.NPM_PASSWORD }}
          npm-private-key:   ${{ secrets.NPM_P256_PRIVATE_KEY }}
```

Inputs: `npm-username`, `npm-credential-id`, `npm-password`, `npm-private-key`
(required); `registry-url`, `node-version`, `chrome-version`, `attempts`,
`artifact-name`, `upload-diagnostics` (optional). The action sets up Node and
Chrome, stages the key to a mode-600 temp file, runs the login, scrubs
diagnostics for leaks, and uploads `run.log` + screenshots.

## 2. Reusable workflow

```yaml
jobs:
  login:
    uses: sokcuri/npm-webauthn-ci/.github/workflows/reusable-login.yml@v1
    with:
      npm-username:      ${{ vars.NPM_USERNAME }}
      npm-credential-id: ${{ vars.NPM_CREDENTIAL_ID }}
      runs: 3                       # try 3 fresh runners in sequence
    secrets:
      npm-password:    ${{ secrets.NPM_PASSWORD }}
      npm-private-key: ${{ secrets.NPM_P256_PRIVATE_KEY }}
```

## 3. Local

```bash
export NPM_USERNAME='you' NPM_CREDENTIAL_ID='<id>' NPM_KEY_DIR="$PWD"
export NPM_PASSWORD='...'            # or read from your password manager
npm ci && node login-check.mjs      # add --headed to watch
```

`~/.npmrc` is never touched; the test token is revoked at the end.

---

## Will it work from a datacenter IP?

GitHub runners egress from Azure (datacenter) IPs, which Cloudflare scores more
aggressively than residential ones. The **probe** measures this without any
secret — it only loads npm's public login page:

```bash
gh workflow run login-check.yml -R <owner>/<repo> -f mode=probe
```

Observed verdict from an Azure runner: headless Chrome with a spoofed (normal)
user-agent is **OK**; the default `HeadlessChrome` UA is **BLOCKED**. `chromium.mjs`
already spoofs the UA. Cold profiles are occasionally challenged, so logins retry
(`attempts`, default 3).

## Files

| File | Role |
| --- | --- |
| `action.yml` | composite action |
| `.github/workflows/reusable-login.yml` | `workflow_call` reusable workflow |
| `.github/workflows/login-check.yml` | this repo's self-test (probe / login) |
| `login-check.mjs` | the login driver (env-configured) |
| `webauthn-shim.mjs` | overrides `navigator.credentials.get`, signs with the PEM key |
| `signcount.mjs` | monotonic signature counter (epoch-based, stateless) |
| `chromium.mjs` | headless Chromium launch + UA spoofing |
| `register-credential.mjs` | one-time: register a PEM key as an npm security key |
| `spike-cloudflare.mjs` | the Cloudflare probe |
