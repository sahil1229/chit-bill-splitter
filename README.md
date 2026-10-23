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

- Automatic photo OCR is NOT implemented. Photo upload and manually pasting iPhone Live Text are available; CHIT does not extract text from photos itself.
- Actual iPhone UPI app launch, bank/payee resolution, iOS share sheets and real payments are untested. CHIT never verifies a bank payment.
- Local Chrome tests cover two diners, allocation, external collector, explicit finalization, reload, review gating, wrong/conflicting pin data, storage failures and concurrent tables. Independent source/browser checks were bounded, not every possible workflow.
- One bounded synthetic test against the real ntfy.sh relay passed: two diners claimed, shares matched, host finalized, correct per-diner review links appeared, and host reload retained identity/settlement. This is not an uptime, latency or outage guarantee.
- Latest payment candidate's complete screens at 320px and all device/browser combinations are not verified. Earlier one-phone layout checks passed at320/420px; do not generalize that to every screen.
- Offline use is not supported. The public relay is best-effort. Reload recovery requires the same browser storage.
- Parser ambiguities show CHECK warnings; always compare the edited bill with the original, including discounts and printed total.
- PDF uses built-in Latin fonts. Unsupported names are explicitly blocked, not silently replaced. Real iPhone PDF sharing is untested.

No real money was moved during testing. Use synthetic bills for controlled testing before relying on it at a restaurant.
