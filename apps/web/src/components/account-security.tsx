'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Fingerprint, ShieldCheck, Trash2 } from 'lucide-react';
import type { IdentityAccount } from '@tallie/identity/contracts';
import { identityClient } from '@tallie/identity/client';
import { errorMessage } from '@/lib/client';
import { useAccountApi } from './account-context';
import { Button, Dialog } from './ui';

type Passkey = { id: string; name: string; createdAt: string | null };

export function AccountSecurity({
  account,
  onClose,
  onChanged,
}: {
  account: IdentityAccount;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const api = useAccountApi();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const active = useRef(true);
  const refreshKeys = useCallback(async () => {
    const result = await api<{ passkeys: Passkey[] }>('/api/identity/passkeys');
    if (active.current) setPasskeys(result.passkeys);
  }, [api]);
  useEffect(() => {
    active.current = true;
    void refreshKeys().catch((e) => {
      if (active.current) setError(errorMessage(e));
    });
    return () => {
      active.current = false;
    };
  }, [refreshKeys]);

  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await task();
      await onChanged();
      if (active.current) await refreshKeys();
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      if (active.current) setBusy(false);
      lock.current = false;
    }
  }
  function saveCodes() {
    const blob = new Blob(
      [
        `Tallie recovery codes\nKeep these private. Each code can be used once, together with phone verification.\n\n${codes.join('\n')}\n`,
      ],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tallie-recovery-codes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Yours, and only yours."
      description="A few little things that keep your account safe."
    >
      <div className="account-security-row">
        <Fingerprint size={24} />
        <div>
          <strong>Your passkeys</strong>
          <p>Use your device to sign in, without a password.</p>
        </div>
      </div>
      <Button
        variant="secondary"
        fullWidth
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await identityClient.signIn.passkey({
              fetchOptions: { headers: { 'X-Tallie-Account': account.id } },
            });
            if (result.error) throw new Error('Your passkey wasn’t used. Please try again.');
          })
        }
      >
        Confirm it’s you <Fingerprint size={17} />
      </Button>
      <div className="account-passkey-list">
        {passkeys.map((passkey) => (
          <div key={passkey.id} className="account-passkey">
            <div>
              <strong>{passkey.name}</strong>
              <small>
                {passkey.createdAt
                  ? `Added ${new Date(passkey.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  : 'Saved to your account'}
              </small>
            </div>
            {removing === passkey.id ? (
              <span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
                  Keep
                </Button>
                <Button
                  size="sm"
                  loading={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/identity/passkeys/${passkey.id}/remove`, {});
                      if (active.current) setRemoving(null);
                    })
                  }
                >
                  Remove
                </Button>
              </span>
            ) : (
              <button
                className="text-action"
                disabled={busy || passkeys.length <= 1}
                aria-label={`Remove ${passkey.name}`}
                onClick={() => setRemoving(passkey.id)}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      {removing && (
        <p className="fine-print">
          Removing a passkey also signs out your other sessions. Keep at least one passkey.
        </p>
      )}
      <Button
        variant="ghost"
        fullWidth
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await identityClient.passkey.addPasskey({
              name: 'Another Tallie passkey',
              fetchOptions: { headers: { 'X-Tallie-Account': account.id } },
            });
            if (result.error)
              throw new Error('Confirm it’s you first, then try adding the passkey again.');
          })
        }
      >
        Add another passkey
      </Button>
      <div className="account-security-row">
        <ShieldCheck size={24} />
        <div>
          <strong>Keep a way back in.</strong>
          <p>
            A recovery code plus phone verification can restore access if you lose your passkeys.
          </p>
        </div>
      </div>
      {codes.length ? (
        <>
          <div className="account-recovery-codes">
            {codes.map((code) => (
              <code key={code}>{code}</code>
            ))}
          </div>
          <Button fullWidth onClick={saveCodes}>
            {saved ? 'Download again' : 'Save my recovery codes'} <Check size={16} />
          </Button>
          <p className="fine-print">
            This set is shown once. Keep it somewhere private. Generating another set replaces these
            codes.
          </p>
        </>
      ) : (
        <>
          <p className="fine-print">
            {account.recoveryCodesRemaining
              ? `${account.recoveryCodesRemaining} unused recovery codes. A new set replaces them.`
              : 'No recovery codes saved yet.'}
          </p>
          <Button
            fullWidth
            loading={busy}
            onClick={() =>
              void run(async () => {
                const result = await api<{ codes: string[] }>('/api/identity/recovery-codes', {});
                if (active.current) {
                  setCodes(result.codes);
                  setSaved(false);
                }
              })
            }
          >
            {account.recoveryCodesRemaining ? 'Replace recovery codes' : 'Create recovery codes'}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
