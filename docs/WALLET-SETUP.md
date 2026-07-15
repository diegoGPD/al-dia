# Wallet setup — what only you can do

The loyalty system works out of the box with the web card. The Apple/Google
Wallet buttons appear automatically once the credentials below exist. Nothing
else needs code changes.

## Apple Wallet (~1 hour, US$99/year)

1. **Join the Apple Developer Program** at developer.apple.com ($99/year, renews — if it lapses, passes stop updating).
2. **Create a Pass Type ID**: Certificates, Identifiers & Profiles → Identifiers → + → Pass Type IDs → e.g. `pass.com.aldia.loyalty`.
3. **Create its certificate**: select the Pass Type ID → Create Certificate. You'll make a CSR on your Mac (Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority → save to disk), upload it, download the `.cer`.
4. **Export as PEM**: double-click the .cer (imports to Keychain) → export the certificate+key as `.p12` (set a password), then on a terminal:
   ```
   openssl pkcs12 -in pass.p12 -clcerts -nokeys -legacy -out pass_cert.pem
   openssl pkcs12 -in pass.p12 -nocerts -nodes  -legacy -out pass_key.pem
   ```
5. **Download Apple's WWDR G4 certificate** from https://www.apple.com/certificateauthority/ (AppleWWDRCAG4.cer) and convert:
   ```
   openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem
   ```
6. **Put the three PEM files on the server volume** at `/data/wallet/`:
   `pass_cert.pem`, `pass_key.pem`, `wwdr.pem`. With Railway CLI:
   ```
   railway ssh -- mkdir -p /data/wallet
   railway volume files upload pass_cert.pem /wallet/pass_cert.pem   (etc.)
   ```
7. **Set variables** in Railway: `PASS_TYPE_ID` = your pass id, `APPLE_TEAM_ID` = your 10-character team id (visible in the developer account membership page). Redeploy.

Check: Settings → Loyalty program shows **Apple Wallet: Active**, and the card page shows the Add to Apple Wallet button. Cards update automatically after each scan (lock-screen notice included). **Renew the certificate before it expires (~1 year)** — repeat steps 3–6.

## Google Wallet (free, approval takes days)

1. **Google Pay & Wallet Console** (pay.google.com/business/console) → sign up as an issuer → request Google Wallet API access (they review; typically a few days). Note your **Issuer ID**.
2. **Google Cloud**: create a project → enable the *Google Wallet API* → create a **service account** → create a JSON key → in the Wallet Console, grant that service account access (Users → invite the service-account email).
3. Upload the JSON key to the server volume as `/data/wallet/google-service-account.json`.
4. Set `GOOGLE_WALLET_ISSUER_ID` in Railway. Redeploy.

Check: Settings → Loyalty shows **Google Wallet: Active**; card pages show the Google button. Note: new loyalty classes start in “under review” demo mode (visible to test users) until Google approves the issuer for production.

## Custom card artwork (optional)

Drop PNGs into `/data/wallet/images/`: `icon.png` (29×29), `icon@2x.png` (58×58), `icon@3x.png` (87×87), `logo.png` (160×50), `logo@2x.png` (320×100). Until then, generated brand-green placeholders are used.

## Marketing pushes — the honest limits

- **Apple**: cards only notify when their content changes (stamp added, reward earned). No arbitrary marketing pushes through Wallet.
- **Google**: short text messages can be pushed to the card (the app does this on stamps/rewards).
- For campaigns ("double points this week"): use WhatsApp/SMS to the phone numbers customers gave at signup — that's a separate feature we can add; don't try to run marketing through wallet passes.

## Customer data & privacy

Stored: name + phone/email + visit dates. Nothing else. Customers can delete
everything themselves from their card page ("Borrar mi tarjeta y mis datos"),
and you can delete any customer in Settings → Loyalty → Customers. Deleting
also removes wallet registrations, so passes stop updating.
