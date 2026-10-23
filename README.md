# CHIT - restaurant bill splitting

Phone-first bill splitting with one-phone pass-around and QR diner mode. Paste or type a bill, review parsed quantities/amounts, add diners and assign dishes. Water, tax and service charges split equally by default. An outside collector is separate from diners and does not change their shares.

## Run and deploy for testing

    npm ci
    npm run dev
    npm run typecheck
    npm run build
    npm run preview
    npm test          # unit + phone-sized browser tests (Playwright)

First time only: `npx playwright install chromium`. Tests build the app against a local ntfy-compatible relay (`tests/relay.mjs`), so they never use the public relay's quota. Like ntfy.sh, that relay turns bodies over 4096 bytes into attachments, so a message-size regression fails the tests.

Deploy the Vite output in `dist` as a static HTTPS site. QR collaboration uses the public ntfy.sh relay (set `VITE_RELAY` at build time to use another ntfy server). Join links carry the table encryption key in the `#` fragment, which browsers never send to the web server; share them only with diners. Keep the host online while claiming.

### Live relay limits

- ntfy.sh allows anonymous users 250 messages per IP per 12 hours, and bodies up to 4096 bytes. Phones on the same restaurant wifi share one IP.
- CHIT compresses each signed, encrypted update and splits it only if needed; a finalized 60-item, 30-diner table still fits in one message.
- The host re-announces a quiet table every 75 seconds and groups bursts of picks into one update. Diners show "Lost the host" after 3 minutes without an update.

## How a table works

Host (live mode):
1. Add the bill (photo, text or by hand), then enter your name and UPI ID and open the table.
2. Everyone scans the one table QR and ticks what they ate on their own phone. A card at the top always says the next step: invite, wait for picks (with "Assign them on my phone" or "Split the rest equally"), then "Review and freeze".
3. Check the amounts, fix anything on your phone, and tap **Freeze & send payment links**. Amounts are locked from here.
4. Each person's phone shows "Pay ₹X in Google Pay"; the app tries to open Google Pay once automatically (browsers may block that until a tap). Tick people off as money arrives.

Picking dishes: one plate is shared by whoever taps "I had this". Several plates of a gravy are shared the same way (2 gravies, 7 people: 7 equal parts). Naans, rotis, drinks and desserts are counted instead (6 naans: 2, 1 and 3). Either mode can be switched per dish while nobody else has picked it.

One phone: pass the phone round, then freeze and send one group message with each person's payment link (or send links one by one). Each link opens a pay screen on the payer's phone with Google Pay first.

Payment links: Android gets Google Pay directly (Android intent), plus PhonePe, Paytm and "Other UPI app" (Android's chooser). iPhone gets Google Pay (`gpay://`), PhonePe (`phonepe://`), Paytm (`paytmmp://`) and Other UPI app (`upi://`). Copy UPI ID / amount are always there. Check payee and amount again in the UPI app. Opening an app is not payment confirmation; the collector marks received manually.

Corrections require a new table. Old UPI links already opened in another app cannot be revoked. Tell diners about corrections before asking anyone to pay again. Web Locks and persistent browser storage are required; unsupported or failed storage blocks finalization/payment instead of guessing.

## Status: tested preview, not production ready

- Photo OCR preview: Read photo uses a same-origin Tesseract7 worker and English model. Photo pixels stay in browser. JPEG/PNG/WebP under 15 MB and 24 MP only, scaled to 2200px; HEIC unsupported. Text must be checked before explicit parsing. Timeout 60s, cancellation supported. Synthetic desktop test passed, not real receipt/iPhone quality proof. Build copies worker/model assets to dist/ocr (~54MB); do not omit those files when deploying. iPhone Live Text remains an alternative.
- Pay links and QR codes are tested for exact payee, name and amount. Every generated QR was decoded back with an independent reader. Opening real UPI apps on real phones, bank/payee resolution, iOS share sheets and real payments are untested. CHIT never verifies a bank payment.
- `npm test` covers the split maths, parser, settlement tampering, payment pin conflicts, relay envelope (size, forgery, replay, host reload), UPI links, and phone-sized browser journeys: one-phone mode end to end (QR, pay link opened on a second phone, mark received, WhatsApp text, PDF, reload, new bill), live mode with an Android and an iPhone diner (join, remove, diner and host reloads, freeze, approve, per-platform pay buttons), collector not dining, join by pasted link, closing a table, on-device photo reading, and 320px layouts. Tests fail on any page or console error.
- A full live run against the real ntfy.sh relay passed (host, two diners, host reload, freeze, approve, pay buttons). This is not an uptime, latency or outage guarantee.
- Blocked relay requests show a reconnecting warning; offline use is not supported. The public relay is best-effort. Reload recovery requires the same browser storage.
- OCR/text can misread prices and item layout. Existing-item replacement asks before clearing claims/shares. Scanning asks before replacing nonempty text. Try sample is an explicit text replacement and may replace text with no items without another prompt.
- Parser ambiguities show CHECK warnings; always compare the edited bill with the original, including discounts and printed total.
- PDF uses built-in Latin fonts. Unsupported names are explicitly blocked, not silently replaced. Real iPhone PDF sharing is untested.

No real money was moved during testing. Use synthetic bills for controlled testing before relying on it at a restaurant.

Parser safeguards: negative foreign-currency/decimal-comma receipts blocked; receipt qty/rate and rate/qty columns verified by arithmetic. Header before recognizable Qty/Rate table excluded, payment/identity footer lines excluded, implausibly large numbers skipped. Photo-derived text requires a detected printed total and exact parsed sum before any import. This intentionally rejects receipts with implicit rounding, illegible text or missing total; it does not guess a correction. One real INR photo parsed3items/1,1,2qty/taxes correctly but implicit40paise rounding prevented auto-import. One blurry INR photo failed closed. This is bounded repair evidence, not broad receipt accuracy.
