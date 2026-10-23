# CHIT - split the restaurant bill

Phone-first restaurant bill splitting. Add or paste bill lines, check quantities and amounts, name the diners, then pass one phone around or let diners claim through a QR join link. Water, tax and service charges are split equally by default. One diner collects the money.

## Run

    npm ci
    npm run dev
    npm run build
    npx tsc --noEmit

Deploy the Vite build output in `dist` as a static site. No backend setup is required, but QR collaboration depends on the public ntfy.sh relay and internet access. Join links contain the table encryption key; share only with the diners.

## v5 safety candidate, not production ready

- QR diner payment links and payment-copy buttons are intentionally DISABLED. An editable host table cannot guarantee that a diner has the latest collector or amount. QR diners must confirm the final amount and collector's UPI ID directly with the host and enter them in their payment app.
- One-phone UPI links remain available with a valid collector ID; check the payee and amount in the payment app. Opening a payment app does not mark a payment received. The collector ticks received manually.
- Any settlement change clears received ticks, including an amount changing back to its old value. Old saved boolean ticks are not accepted.
- Export is blocked until dishes are claimed, or the host explicitly selects equal split in one-phone mode. A mismatch with the printed total also blocks final export.
- The collector must be one of the diners. An external collector is not supported.
- OCR and actual iPhone payment-app behavior are not verified. Pasting iPhone Live Text into the bill box is an alternative to built-in image scanning. Always check parsed quantities, amounts, discounts and printed total.
- The relay is best-effort, with no uptime promise. Keep the host page open and online while diners claim.
- Not verified on a real iPhone, offline, or at 320px. A fast-tap lost-claim report has not been reproduced.
- No payments are processed or verified by CHIT.

## Verification

This candidate builds with Vite and passes strict TypeScript checking. Focused source regression checks cover explicit equal split, unclaimed zero-price items, printed-total mismatch, parser variants and failed relay sends. Independent browser regression is pending for this version. These checks do not establish production readiness.
