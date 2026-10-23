# CHIT - split the restaurant bill

A phone-first web app for splitting a restaurant bill. Read or type the bill, add the people, tick who had what (by quantity, or shared), and get each person's final amount. Tax, service charge and water are split equally by default. One person collects, everyone else pays them.

Two modes:
- One phone: pass it around the table.
- Everyone's phones: scan a QR, pick your name, tick your dishes. Picks travel end-to-end encrypted through the public ntfy.sh relay. The join link holds the key.

Payments are manual. The app can open Google Pay or another UPI app with the amount filled in, but opening an app never marks anyone paid. The collector ticks "received" by hand.

## Run

    npm install
    npm run dev
    npm run build

## Known limits

- Bill scanning relies on iPhone Live Text (Scan Text) pasted into the text box. There is no built-in OCR.
- Not tested on a real iPhone. UPI deep links (gpay://, upi://) are untested on devices.
- The relay is best-effort with no uptime promise. If the host page closes, diners see "Lost the host".

## Status: work in progress, not production ready

An independent review found payment-handling defects that are NOT all fixed in this source. Do not use it to collect real money yet. Open items:
- "Received" ticks are not yet bound to the amount they were ticked at.
- Live mode has no collector chooser for the report; payment link freshness is not tied to the host's latest confirmed state.
- The PDF does not paginate very long per-person lists or 30+ people.
- "New bill" does not yet close an open live table.
- The bill parser reads the first number column as quantity, so rate / qty / total layouts need a manual check.
