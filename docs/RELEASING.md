# Releasing SpecForge

This document is the **operator runbook** for cutting signed, notarized,
cross-platform releases of SpecForge and publishing them (with auto-update
metadata) to GitHub Releases.

The pipeline is already scaffolded:

- `.github/workflows/release.yml` — builds Windows, macOS, and Linux in parallel
  on a version-tag push and publishes every installer to one GitHub Release.
- `package.json` → `build` — electron-builder config (signing + publish).
- `electron/main.ts` — `electron-updater` wired to check GitHub Releases on launch.

You do **not** need to touch those files again once the placeholders below are
filled in. What remains is **account/credential setup**, which only you can do.

---

## 0. The shape of a release

```
git tag v0.3.0 && git push origin v0.3.0
        │
        └─ GitHub Actions: 3 runners build in parallel
              ├─ ubuntu-latest  → SpecForge-0.3.0.AppImage, .deb
              ├─ windows-latest → SpecForge Setup 0.3.0.exe   (Azure-signed)
              └─ macos-latest   → SpecForge-0.3.0.dmg + .zip  (signed + notarized)
        │
        └─ all artifacts + latest*.yml uploaded to a single DRAFT GitHub Release
```

The Release is created as a **draft** by electron-builder. You review it, then
click **Publish** in the GitHub UI. Once published, installed apps auto-update
from it (Windows/NSIS + macOS + Linux/AppImage).

> The app version comes from `package.json` `"version"`. Keep your git tag in
> sync with it (tag `v0.3.0` ⇄ version `0.3.0`). Bump `version` before tagging.

---

## 1. Create the GitHub repository

1. Create a repo on GitHub (e.g. `craigsalajan/specforge`). Public is free for
   unlimited Actions minutes (including macOS runners).
2. Point your local repo at it and push `main`:
   ```powershell
   git remote add origin https://github.com/<owner>/<repo>.git
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git push -u origin main
   ```
3. Fill the two `publish` placeholders in `package.json` → `build.publish[0]`:
   - `<GITHUB_OWNER>` → your GitHub username/org (e.g. `craigsalajan`)
   - `<GITHUB_REPO>`  → the repo name (e.g. `specforge`)

`GITHUB_TOKEN` is injected automatically into the workflow — **no secret needed**
for publishing. The workflow already grants it `contents: write`.

---

## 2. Windows — Azure Trusted Signing

You already have a Trusted Signing **account** and a completed **identity
validation**. To actually sign from CI you still need to create **two** more
things, then collect the config values + secrets below:

1. **A Certificate Profile** (if you don't have one yet) — this is the object
   that issues the signing certificate from your validated identity. Azure
   portal → your Trusted Signing account → **Certificate profiles** → **Create**
   → type **Public Trust** → select your completed identity validation. Its name
   becomes `<AZURE_CERT_PROFILE_NAME>`, and the certificate subject (your
   validated name) becomes `<AZURE_PUBLISHER_NAME>`.
2. **A service principal** with signing rights (step 2b below) — this is how the
   GitHub Actions runner authenticates to Azure. The identity validation proves
   *who you are*; the service principal is *the CI robot allowed to sign on your
   behalf*. These are separate — having the identity is not enough on its own.

You do **not** need a Key Vault, nor any `.pfx`/`.p12`/cert file for Windows —
Trusted Signing keeps the private key in Azure's HSM and signs over the network.
electron-builder downloads the signing client automatically on the runner.

### 2a. Config values → `package.json` → `build.win.azureSignOptions`

Replace these four placeholders with values from your Azure **Trusted Signing**
account and **Certificate Profile**:

| Placeholder | Where to find it |
|---|---|
| `<AZURE_PUBLISHER_NAME>` | The **subject / identity validation name** on your Certificate Profile (your verified legal or individual name — must match exactly). |
| `<AZURE_ENDPOINT>` | The regional endpoint for your Trusted Signing account, e.g. `https://eus.codesigning.azure.net/` (East US), `https://wus.codesigning.azure.net/` (West US), `https://neu.codesigning.azure.net/` (North Europe). Azure portal → your Trusted Signing account → **Account URI**. |
| `<AZURE_CODE_SIGNING_ACCOUNT_NAME>` | The name of your Trusted Signing **account** resource. |
| `<AZURE_CERT_PROFILE_NAME>` | The name of the **Certificate Profile** under that account. |

### 2b. Create a service principal (for CI authentication)

electron-builder authenticates to Trusted Signing with an Azure AD **service
principal** via three env vars. Create one:

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → **New
   registration**. Name it e.g. `specforge-signing`. Register.
2. On the new app: **Certificates & secrets** → **New client secret**. Copy the
   secret **Value** immediately (shown once).
3. Note from the app's **Overview** page:
   - **Application (client) ID**
   - **Directory (tenant) ID**
4. Grant it permission to sign: Azure Portal → your **Trusted Signing account**
   (or the specific Certificate Profile) → **Access control (IAM)** → **Add role
   assignment** → role **“Trusted Signing Certificate Profile Signer”** → assign
   to the `specforge-signing` app.

### 2c. GitHub secrets (Settings → Secrets and variables → Actions)

| Secret name | Value |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | The client secret **Value** from step 2b.2 |

> **Gotchas.** Trusted Signing public-trust certs require Microsoft’s identity
> validation to be **completed** (orgs generally need 3+ years of verifiable
> history; individual validation is also available). Even with a valid signature,
> Windows SmartScreen reputation accrues over time — early downloaders may still
> see a warning until your publisher builds reputation.

---

## 3. macOS — Developer ID signing + notarization

This is the part that requires a paid Apple Developer account ($99/yr). Without
it, macOS Gatekeeper blocks the app and auto-update cannot verify signatures.

### 3a. Apple Developer account + certificate

1. Enroll at <https://developer.apple.com/programs/> ($99/yr).
2. Find your **Team ID**: <https://developer.apple.com/account> → Membership
   details → **Team ID** (10 chars, e.g. `AB12CD34EF`).
3. Create a **Developer ID Application** certificate:
   - Easiest path: on a Mac, open **Xcode → Settings → Accounts**, add your Apple
     ID, select the team → **Manage Certificates** → **+** → **Developer ID
     Application**. This creates the cert and private key in your login keychain.
   - Or manually at <https://developer.apple.com/account/resources/certificates>
     → **+** → **Developer ID Application** (requires a CSR from Keychain Access).

### 3b. Export the certificate as a base64 `.p12` (for CI)

On the Mac that holds the cert + private key:

1. **Keychain Access** → **My Certificates** → right-click your *Developer ID
   Application* cert → **Export…** → save as `cert.p12` → set an export password
   (you'll need it as `CSC_KEY_PASSWORD`).
2. Base64-encode it for the GitHub secret:
   ```bash
   base64 -i cert.p12 | pbcopy   # macOS: now in your clipboard
   ```
   (On Windows: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.p12")) | Set-Clipboard`)

### 3c. App-specific password (for notarization)

1. Sign in at <https://appleid.apple.com> → **Sign-In and Security** →
   **App-Specific Passwords** → **+** → name it `specforge-notarize`.
2. Copy the generated password (format `abcd-efgh-ijkl-mnop`). This is **not**
   your Apple ID login password.

### 3d. GitHub secrets

| Secret name | Value |
|---|---|
| `CSC_LINK` | The base64 string from step 3b.2 |
| `CSC_KEY_PASSWORD` | The `.p12` export password from step 3b.1 |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from step 3c |
| `APPLE_TEAM_ID` | Your 10-char Team ID from step 3a.2 |

electron-builder v26 uses these automatically: `CSC_LINK`/`CSC_KEY_PASSWORD` to
sign with hardened runtime, then `APPLE_*` to notarize via **notarytool** (the
config already sets `mac.notarize: true`, `hardenedRuntime: true`, and points at
`build/entitlements.mac.plist`).

> **Why both `dmg` and `zip`?** The `.dmg` is what users download; the `.zip` is
> what the macOS auto-updater (Squirrel.Mac) consumes via `latest-mac.yml`. The
> config ships both — do not remove `zip` or auto-update breaks.

---

## 4. Secrets checklist

All under **GitHub repo → Settings → Secrets and variables → Actions →
Repository secrets**:

- [ ] `AZURE_TENANT_ID`
- [ ] `AZURE_CLIENT_ID`
- [ ] `AZURE_CLIENT_SECRET`
- [ ] `CSC_LINK`
- [ ] `CSC_KEY_PASSWORD`
- [ ] `APPLE_ID`
- [ ] `APPLE_APP_SPECIFIC_PASSWORD`
- [ ] `APPLE_TEAM_ID`

And in `package.json` → `build`, the six placeholders filled:

- [ ] `<GITHUB_OWNER>`, `<GITHUB_REPO>` (in `publish`)
- [ ] `<AZURE_PUBLISHER_NAME>`, `<AZURE_ENDPOINT>`, `<AZURE_CODE_SIGNING_ACCOUNT_NAME>`, `<AZURE_CERT_PROFILE_NAME>` (in `win.azureSignOptions`)

---

## 5. Cut a release

```powershell
# 1. Bump the version in package.json (e.g. 0.2.0 -> 0.3.0), commit it.
# 2. Tag and push:
git tag v0.3.0
git push origin v0.3.0
```

> A CI guard (the `verify-version` job) fails the run **before** any build if the
> tag doesn't match `package.json` `version` — so tag `v0.3.0` requires
> `"version": "0.3.0"`. Bump the version and commit it before tagging.

Watch the run under the repo's **Actions** tab. On success a **draft** Release
appears under **Releases** with all installers + `latest.yml` /
`latest-mac.yml` / `latest-linux.yml` attached. Review, then **Publish**.

---

## 6. Local test builds (unsigned)

To produce an installer locally without any signing/notarization:

```powershell
npm run package:win     # or package:mac / package:linux
```

These use `--publish never`. Note: on macOS, `mac.notarize: true` will try to
notarize even locally — to skip it for a quick local build, override:

```powershell
npx electron-builder --mac -c.mac.notarize=false -c.mac.identity=null --publish never
```

---

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Actions: *“Resource not accessible by integration”* | Missing `permissions: contents: write` (already in the workflow) or the repo disallows Actions writing — check **Settings → Actions → General → Workflow permissions**. |
| Windows: *Azure signing fails / 401/403* | Service principal not assigned the **Trusted Signing Certificate Profile Signer** role, or wrong `AZURE_*` secrets, or wrong `endpoint` region. |
| macOS: *“The application is damaged / can’t be opened”* on a downloaded build | App wasn’t notarized — verify all 5 `APPLE_*`/`CSC_*` secrets are set and the cert is **Developer ID Application** (not “Apple Development”). |
| macOS: notarization fails with auth error | `APPLE_APP_SPECIFIC_PASSWORD` is the login password, not an app-specific one; regenerate at appleid.apple.com. |
| Auto-update never triggers | Release is still a **draft** (publish it), or the installed version ≥ release version, or app run in dev (`SPECFORGE_DEV=1` disables the updater). |
| Native module (better-sqlite3) crashes on signed mac build | Ensure `com.apple.security.cs.disable-library-validation` is present in `build/entitlements.mac.plist` (it is). |

---

## References

- electron-builder code signing (Windows / Azure Trusted Signing): <https://www.electron.build/code-signing-win>
- electron-builder macOS config & notarization: <https://www.electron.build/code-signing-mac>
- Auto-update (electron-updater): <https://www.electron.build/auto-update>
- GitHub Actions for electron-builder: <https://www.electron.build/github-actions>
