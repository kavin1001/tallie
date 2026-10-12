# Local personal payment test

This pilot sends from an already existing Natural owner account. It does not create another Natural account or invitation. It is a single real payment; the user must approve the exact amount and recipient in Tallie. General customer money movement remains disabled. The founder authorized publishing the development branch on October 11; production deployment still requires founder local testing and release approval.

## Run

Use the existing private `.tallie/owner-pilot.env`. Never print, commit or copy its secrets into this document. It contains the dedicated local database URL and identity secrets, Sendblue phone-verification credentials, the dedicated Tallie production agent key/IDs, fixed wallet, keyed owner phone fingerprint and selected recipient handle. These settings were prepared from verified provider reads. They are not browser input.

```sh
npm run build
node scripts/run-owner-pilot.mjs check
node scripts/run-owner-pilot.mjs migrate
node scripts/run-owner-pilot.mjs web
```

In a separate terminal:

```sh
node scripts/run-owner-pilot.mjs worker
```

Open [localhost:3004](http://localhost:3004). The server listens only on loopback. No Cloudflare tunnel is required. Modern browsers support passkeys on localhost. Existing tunnel passkeys have a different relying-party domain; create a Tallie localhost passkey when prompted. This is a fresh isolated Tallie profile, not new Natural onboarding. Identity cookies are separate from the existing local sandbox.

1. Complete Tallie phone proof using the phone already on the Natural account, enter your name and enroll a passkey. Retain recovery codes securely.
2. Find **Your first little send** on Home. It shows the fixed recipient and live available wallet balance when the read succeeds.
3. Select **Review $1.00**, use the Tallie passkey, and check the handle, source and amount. Natural resolves the handle at submission; Tallie does not claim a separately verified recipient name. Expected zero Natural consumer fee follows current public pricing, not an API quote. Tallie adds no fee.
4. Personally select **Send $1.00**. This is the only live financial action. The assistant must not click it during automated verification.
5. Wait for canonical status. Confirm the recipient's actual receipt and sender balance, including any reported provider fee. A pending claim, review or uncertain result is not settlement.

## Failure handling

- **Owner mismatch:** correct the signed-in phone or investigate server configuration. Do not repoint someone else's account to the owner wallet.
- **Passkey required:** use the current origin's registered Tallie passkey. Phone proof or recovery alone cannot authorize this debit.
- **Expired review:** review again; the source/recipient/amount remain fixed.
- **Uncertain response:** select **Check status** or keep the read-only worker running. The saved operation is the only operation; no automatic or manual replacement send is offered.
- **Failed, canceled or returned:** retain the journal. A second payment requires a separately designed and approved follow-up, not deletion of the first row.
- **Status check needs attention:** the displayed result is the last verified observation. Investigate canonical read/binding errors before treating it as current.
- **Stop:** terminate the web process to stop new submissions, and the worker to stop polling. Preserve the database and private settings. General production submission controls remain paused throughout this pilot.

## Evidence boundaries

Implemented tests cover strict account/phone/passkey ownership, expiry, duplicate/concurrent confirmations, crash/unknown outcomes, fixed provider authority, recipient binding, fee nullability and monotonic reconciliation. HTTP tests cover same-origin JSON and reject client-supplied payment fields. Launcher tests verify role-specific secrets, local boundaries and suppression of implicit `.env` imports.

Actual read-only provider checks established the active owner and available USD wallet through Tallie's credential. They do not establish successful sending, recipient receipt, fee behavior, bank linking, funding, cash-out or production hosting. The tracker records the founder's subsequent live observation when it happens.

**Preserve `tallie_owner_pilot`.** Its uniqueness constraints enforce one submitted operation within this durable database. Recreating the database would erase that constraint and is not a supported retry procedure.
