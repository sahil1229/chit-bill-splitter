# CHIT - restaurant bill splitting

Phone-first bill splitting with one-phone pass-around and QR diner mode. Paste or type a bill, review parsed quantities/amounts, add diners and assign dishes. Water, tax and service charges split equally by default. An outside collector is separate from diners and does not change their shares.

## Run and deploy for testing

    npm ci
    npm run dev
    npm run typecheck
    npm run build
    npm run preview

Deploy the Vite output in `dist` as a static HTTPS site. QR collaboration uses the public ntfy.sh relay. Join links contain the table encryption key; share only with diners. Keep the host online while claiming.

## Payment workflow

1. Host checks the printed total, every dish, each person's share and collector name/UPI ID.
2. Host explicitly reviews and freezes the table. Bill, people, claims and collector become immutable for that table.
3. Each diner checks the signed, frozen collector and their own amount. Payment links appear only after review and a durable browser pin. Conflicting finalized details block payment for that table/seat, including after reload.
4. Check payee and amount again in the UPI app. Opening an app is not payment confirmation. The collector marks received manually.

Corrections require a new table. Old UPI links already opened in another app cannot be revoked. Tell diners about corrections before asking anyone to pay again. Web Locks and persistent browser storage are required; unsupported or failed storage blocks finalization/payment instead of guessing.

## Status: tested preview, not production ready

- Photo OCR preview: Read photo uses a same-origin Tesseract7 worker and English model. Photo pixels stay in browser. JPEG/PNG/WebP under 15 MB and 24 MP only, scaled to 2200px; HEIC unsupported. Text must be checked before explicit parsing. Timeout 60s, cancellation supported. Synthetic desktop test passed, not real receipt/iPhone quality proof. Build copies worker/model assets to dist/ocr (~54MB); do not omit those files when deploying. iPhone Live Text remains an alternative.
- Actual iPhone UPI app launch, bank/payee resolution, iOS share sheets and real payments are untested. CHIT never verifies a bank payment.
- Local Chrome tests cover two diners, allocation, external collector, explicit finalization, reload, review gating, wrong/conflicting pin data, storage failures and concurrent tables. Independent source/browser checks were bounded, not every possible workflow.
- One bounded synthetic test against the real ntfy.sh relay passed: two diners claimed, shares matched, host finalized, correct per-diner review links appeared, and host reload retained identity/settlement. This is not an uptime, latency or outage guarantee.
- Representative photo review, finalized external/diner collector and blocked-relay screens were checked at 320px. Not all screens, devices or browsers have been checked.
- Blocked relay requests show a reconnecting warning; offline use is not supported. The public relay is best-effort. Reload recovery requires the same browser storage.
- OCR/text can misread prices and item layout. Existing-item replacement asks before clearing claims/shares. Scanning asks before replacing nonempty text. Try sample is an explicit text replacement and may replace text with no items without another prompt.
- Parser ambiguities show CHECK warnings; always compare the edited bill with the original, including discounts and printed total.
- PDF uses built-in Latin fonts. Unsupported names are explicitly blocked, not silently replaced. Real iPhone PDF sharing is untested.

No real money was moved during testing. Use synthetic bills for controlled testing before relying on it at a restaurant.

Parser safeguards: negative foreign-currency/decimal-comma receipts blocked; receipt qty/rate and rate/qty columns verified by arithmetic. Header before recognizable Qty/Rate table excluded, payment/identity footer lines excluded, implausibly large numbers skipped. Photo-derived text requires a detected printed total and exact parsed sum before any import. This intentionally rejects receipts with implicit rounding, illegible text or missing total; it does not guess a correction. One real INR photo parsed3items/1,1,2qty/taxes correctly but implicit40paise rounding prevented auto-import. One blurry INR photo failed closed. This is bounded repair evidence, not broad receipt accuracy.
