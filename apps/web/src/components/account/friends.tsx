'use client';
import { useAccountApi } from '../account-context';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, Link2, LockKeyhole, Share2, UserPlus } from 'lucide-react';
import type { SocialContact, SocialInvitation } from '@tallie/social/contracts';
import { errorMessage, RequestError } from '@/lib/client';
import { Avatar, Button, Dialog } from '../ui';

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 10
    ? `+1${digits}`
    : digits.length === 11 && digits.startsWith('1')
      ? `+${digits}`
      : '';
}
const isDefinitive = (error: unknown) =>
  error instanceof RequestError && error.status >= 400 && error.status < 500;

export function AddFriend({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (contact: SocialContact) => Promise<void>;
}) {
  const api = useAccountApi();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{ key: string; body: { label: string; phone: string } } | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    setError('');
    const normalized = normalizePhone(phone);
    if (!name.trim()) {
      setError('What do you call your friend?');
      return;
    }
    if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(normalized)) {
      setError('Enter your friend’s US mobile number.');
      return;
    }
    attempt.current ??= {
      key: crypto.randomUUID(),
      body: { label: name.trim(), phone: normalized },
    };
    lock.current = true;
    setBusy(true);
    try {
      const contact = await api<SocialContact>(
        '/api/social/contacts',
        attempt.current.body,
        attempt.current.key,
      );
      if (alive.current) await onAdded(contact);
    } catch (cause) {
      if (alive.current) {
        setError(errorMessage(cause));
        const unknown = !isDefinitive(cause);
        setUncertain(unknown);
        if (!unknown) attempt.current = null;
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Good company starts here."
      description="Add their number. We’ll make the introduction easy."
      size="sm"
      initialFocusRef={nameInput}
    >
      <form onSubmit={(event) => void submit(event)} className="account-friend-form">
        <div className="account-friend-form-art">
          <UserPlus size={27} />
          <span>
            A familiar face.
            <br />A little less hassle.
          </span>
        </div>
        <label>
          What you call them
          <input
            ref={nameInput}
            autoComplete="off"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Maya Chen"
            disabled={busy || uncertain}
          />
        </label>
        <label>
          Their mobile number
          <div className="account-phone-input">
            <span>US +1</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              maxLength={24}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(202) 555-0123"
              aria-label="Friend’s mobile number"
              disabled={busy || uncertain}
            />
          </div>
        </label>
        <p className="account-small-note">
          <LockKeyhole size={14} /> This name is just for you. Their number keeps invitations going
          to the right person.
        </p>
        {error && (
          <p role="alert" className="account-inline-error">
            {error}
          </p>
        )}
        {uncertain && (
          <p className="account-small-note">
            We didn’t get a clear response. Retry the same details to check safely.
          </p>
        )}
        <Button type="submit" fullWidth loading={busy}>
          {uncertain ? 'Check this request again' : 'Add friend'}
        </Button>
        <p className="account-form-footnote">You choose when and how to share the invitation.</p>
      </form>
    </Dialog>
  );
}

export interface InviteContext {
  contact: SocialContact;
  expenseId?: string;
  key: string;
}
export function InvitationSheet({
  context,
  onClose,
  onFreshKey,
  onCopied,
}: {
  context: InviteContext;
  onClose: () => void;
  onFreshKey: () => void;
  onCopied: () => void;
}) {
  const api = useAccountApi();
  const [invitation, setInvitation] = useState<SocialInvitation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const generation = useRef(0);
  const urlInput = useRef<HTMLInputElement>(null);
  async function load() {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const next = await api<SocialInvitation>(
        '/api/social/invitations',
        {
          contactId: context.contact.id,
          ...(context.expenseId ? { expenseId: context.expenseId } : {}),
        },
        context.key,
      );
      if (current === generation.current) setInvitation(next);
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setInvitation(null);
    setCopied(false);
    void load();
    return () => {
      generation.current++;
    };
  }, [context.key]);
  async function copy() {
    if (!invitation || copying) return;
    setCopying(true);
    setError('');
    try {
      await navigator.clipboard.writeText(invitation.url);
      setCopied(true);
      onCopied();
    } catch {
      setError('Select and copy the link below.');
      urlInput.current?.select();
    } finally {
      setCopying(false);
    }
  }
  async function share() {
    if (!invitation) return;
    try {
      await navigator.share({
        title: 'Join me on Tallie',
        text: 'A little less sorting out. Join me on Tallie.',
        url: invitation.url,
      });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError'))
        setError('Sharing didn’t open. You can copy the link instead.');
    }
  }
  async function revoke() {
    if (!invitation || revoking) return;
    setRevoking(true);
    setError('');
    try {
      await api(`/api/social/invitations/${invitation.id}/revoke`, {});
      setInvitation({ ...invitation, status: 'revoked' });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRevoking(false);
    }
  }
  const expired =
    invitation && (invitation.status === 'expired' || invitation.status === 'revoked');
  return (
    <Dialog
      open
      onClose={onClose}
      title={`A little hello for ${context.contact.label.split(' ')[0]}.`}
      description={
        context.expenseId
          ? 'Their split is saved. This link brings them straight back to it.'
          : 'Share a private invitation and start making moments together.'
      }
      size="sm"
    >
      <div className="account-invite-person">
        <Avatar name={context.contact.label} size="lg" />
        <div>
          <strong>{context.contact.label}</strong>
          <span>{context.contact.maskedPhone}</span>
        </div>
        <span className="account-invite-lock">
          <LockKeyhole size={18} />
        </span>
      </div>
      <div className="account-invite-content">
        {busy ? (
          <div className="account-invite-loading" role="status">
            <span className="ui-spinner" /> Making a little introduction…
          </div>
        ) : invitation ? (
          <>
            {expired ? (
              <>
                <p className="account-inline-info">
                  {invitation.status === 'revoked'
                    ? 'This link is switched off.'
                    : 'This link has expired.'}{' '}
                  A fresh invitation keeps things moving.
                </p>
                <Button fullWidth onClick={onFreshKey}>
                  Make a fresh link
                </Button>
              </>
            ) : invitation.status === 'claimed' ? (
              <p className="account-inline-info">
                <Check size={18} /> This invitation has been accepted. You’re connected.
              </p>
            ) : (
              <>
                <div className="account-invite-link">
                  <Link2 size={17} />
                  <input
                    ref={urlInput}
                    aria-label="Private invitation link"
                    readOnly
                    value={invitation.url}
                  />
                </div>
                <Button
                  fullWidth
                  icon={copied ? <Check size={18} /> : <Copy size={17} />}
                  loading={copying}
                  onClick={() => void copy()}
                >
                  {copied ? 'Copied. Send a little hello.' : 'Copy private invitation'}
                </Button>
                {typeof navigator !== 'undefined' && 'share' in navigator && (
                  <Button
                    fullWidth
                    variant="secondary"
                    icon={<Share2 size={16} />}
                    onClick={() => void share()}
                  >
                    Share invitation
                  </Button>
                )}
                <p className="account-small-note">
                  <LockKeyhole size={14} /> Only the verified owner of {context.contact.maskedPhone}{' '}
                  can accept. The link expires in seven days.
                </p>
                {typeof window !== 'undefined' &&
                  ['localhost', '127.0.0.1'].includes(window.location.hostname) && (
                    <p className="account-form-footnote">
                      This local preview link opens on this computer. A hosted Tallie URL is needed
                      for friends on other devices.
                    </p>
                  )}
                <button
                  className="account-revoke-link"
                  disabled={revoking}
                  onClick={() => void revoke()}
                >
                  {revoking ? 'Disabling…' : 'Disable this link'}
                </button>
              </>
            )}
          </>
        ) : (
          <Button fullWidth onClick={() => void load()}>
            Try the same invitation again
          </Button>
        )}
        {error && (
          <p className="account-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
