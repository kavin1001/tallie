'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Link2 } from 'lucide-react';
import type { MessageDraft } from '@tallie/messaging/contracts';
import type { IdentityState } from '@tallie/identity/contracts';
import type { InvitationClaim, InvitationInspection } from '@tallie/social/contracts';
import { api, errorMessage } from '@/lib/client';
import { Button, Dialog, ToastProvider } from './ui';
import { Flower, ReceiptArt, Wordmark } from './brand';
import { AccountAuth } from './account-auth';
import { AccountHome } from './account-home';
import { AccountMessages } from './account-messages';
import { AccountSecurity } from './account-security';
import { AccountContext } from './account-context';
import { shouldResumeSignup } from './signup-flow';
import './account.css';

const INVITATION_KEY = 'tallie.pending-invitation.v1';

export function AccountApp({
  invitationEntry = false,
  demoAvailable = false,
  messagingAvailable = false,
}: {
  invitationEntry?: boolean;
  demoAvailable?: boolean;
  messagingAvailable?: boolean;
}) {
  return (
    <ToastProvider>
      <AccountContent
        invitationEntry={invitationEntry}
        demoAvailable={demoAvailable}
        messagingAvailable={messagingAvailable}
      />
    </ToastProvider>
  );
}

function AccountContent({
  invitationEntry,
  demoAvailable,
  messagingAvailable,
}: {
  invitationEntry: boolean;
  demoAvailable: boolean;
  messagingAvailable: boolean;
}) {
  const [state, setState] = useState<IdentityState | null>(null);
  const [authOpen, setAuthOpen] = useState(invitationEntry);
  const [error, setError] = useState('');
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<'available' | 'unavailable' | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [expenseId, setExpenseId] = useState<string>();
  const [receiptId, setReceiptId] = useState<string>();
  const [messageDraft, setMessageDraft] = useState<MessageDraft>();
  const [selectedDraftId, setSelectedDraftId] = useState<string>();
  const [securityOpen, setSecurityOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const generation = useRef(0);
  const hydrated = useRef(false);
  const claimLock = useRef(false);
  const accountIdRef = useRef(state?.account?.id);
  accountIdRef.current = state?.account?.id;
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const next = await api<IdentityState>('/api/identity/state');
      if (generation.current === version) {
        if (!hydrated.current) {
          hydrated.current = true;
          setAuthOpen((open) => open || shouldResumeSignup(next));
        }
        setState(next);
        setError('');
      }
    } catch (e) {
      if (generation.current === version) setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      generation.current++;
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);

  useEffect(() => {
    let token: string | null = null;
    const fragment = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (fragment && /^[A-Za-z0-9_-]{43}$/.test(fragment)) {
      token = fragment;
      try {
        sessionStorage.setItem(INVITATION_KEY, token);
      } catch {
        /* Keep the current page usable without browser storage. */
      }
      window.history.replaceState(null, '', window.location.pathname);
    } else
      try {
        token = sessionStorage.getItem(INVITATION_KEY);
      } catch {
        /* Optional tab persistence. */
      }
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    setInviteToken(token);
    const abort = new AbortController();
    void api<InvitationInspection>(
      '/api/social/invitations/inspect',
      { token },
      undefined,
      abort.signal,
    )
      .then((result) => {
        if (!abort.signal.aborted) setInviteStatus(result.status);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    setSecurityOpen(false);
    setMessagesOpen(false);
    setExpenseId(undefined);
    setReceiptId(undefined);
    setMessageDraft(undefined);
    setSelectedDraftId(undefined);
  }, [state?.account?.id, state?.account?.ready]);

  useEffect(() => {
    if (!state?.account?.ready) return;
    const params = new URLSearchParams(window.location.search);
    const draft = params.get('messageDraft'),
      expense = params.get('expense'),
      request = params.get('request');
    const valid = (id: string | null): id is string =>
      !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (messagingAvailable && valid(draft)) {
      setSelectedDraftId(draft);
      setMessagesOpen(true);
    } else if (valid(expense)) setExpenseId(expense);
    const abort = new AbortController();
    if (messagingAvailable && valid(request))
      void api<{ expenseId: string }>(
        `/api/messages/requests/${request}`,
        undefined,
        undefined,
        abort.signal,
        state.account.id,
      )
        .then((result) => {
          if (!abort.signal.aborted) setExpenseId(result.expenseId);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(errorMessage(e));
        });
    if (draft || expense || request)
      window.history.replaceState(null, '', window.location.pathname);
    return () => abort.abort();
  }, [state?.account?.id, state?.account?.ready, messagingAvailable]);

  function clearInvitation() {
    setInviteToken(null);
    setInviteStatus(null);
    try {
      sessionStorage.removeItem(INVITATION_KEY);
    } catch {
      /* In-memory state is still cleared. */
    }
  }
  async function claimInvitation() {
    if (!inviteToken || claimLock.current || !state?.account?.ready) return;
    const owner = state.account.id;
    claimLock.current = true;
    setClaiming(true);
    setError('');
    try {
      const result = await api<InvitationClaim>(
        '/api/social/invitations/claim',
        { token: inviteToken },
        undefined,
        undefined,
        owner,
      );
      if (accountIdRef.current !== owner) return;
      clearInvitation();
      setExpenseId(result.expenseId ?? undefined);
      await refresh();
    } catch (e) {
      if (accountIdRef.current === owner) setError(errorMessage(e));
    } finally {
      setClaiming(false);
      claimLock.current = false;
    }
  }
  async function signOut() {
    generation.current++;
    try {
      await api('/api/identity/sign-out', {});
      generation.current++;
      setState({
        available: state?.available ?? false,
        authenticationMode: state?.authenticationMode ?? 'passkey',
        account: null,
        challenge: null,
      });
      setAuthOpen(false);
      setSecurityOpen(false);
      setMessagesOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!state)
    return (
      <div className="account-loading">
        <Wordmark />
        <p role="status">Getting everything together…</p>
        {error && (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Button onClick={() => void refresh()}>Try again</Button>
          </>
        )}
      </div>
    );

  if (!state.account?.ready && authOpen)
    return (
      <AccountAuth
        key={state.account?.id ?? 'anonymous'}
        state={state}
        onState={(next) => {
          generation.current++;
          setState(next);
        }}
        onBack={() => setAuthOpen(false)}
        invited={Boolean(inviteToken)}
      />
    );

  if (!state.account?.ready)
    return (
      <div className="welcome-page account-welcome">
        <header className="welcome-header">
          <Wordmark />
          <span className="welcome-beta">
            <span />
            An early chapter
          </span>
        </header>
        <main className="welcome-main">
          <section className="welcome-copy">
            <div className="eyebrow">
              <span className="tiny-line" />
              MONEY BETWEEN FRIENDS, REIMAGINED
            </div>
            <h1>
              Good times.
              <br />
              <em>All square.</em>
            </h1>
            <p>
              A little less settling up.
              <br />A little more living.
            </p>
            <Button size="lg" onClick={() => setAuthOpen(true)}>
              {shouldResumeSignup(state) ? 'Finish setting up' : 'Make yourself at home'}{' '}
              <ArrowRight size={18} />
            </Button>
            <span className="welcome-note">
              Real accounts. Shared moments. Payments are coming next.
            </span>
            {demoAvailable && (
              <a className="account-demo-link" href="/demo">
                Take a look around the demo
              </a>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </section>
          <ReceiptArt />
        </main>
        <footer className="welcome-footer">
          <span>For dinners, detours, and everything in between.</span>
          <span>
            Made for the people you do life with <Flower />
          </span>
        </footer>
      </div>
    );

  return (
    <AccountContext.Provider value={state.account.id} key={state.account.id}>
      <AccountHome
        key={state.account.id}
        account={state.account}
        onSignOut={signOut}
        onSecurity={() => setSecurityOpen(true)}
        messagingAvailable={messagingAvailable}
        onMessages={() => {
          setSelectedDraftId(undefined);
          setMessagesOpen(true);
        }}
        {...(expenseId ? { initialExpenseId: expenseId } : {})}
        {...(receiptId ? { initialReceiptId: receiptId } : {})}
        {...(messageDraft ? { initialMessageDraft: messageDraft } : {})}
      />
      {error && (
        <div className="account-global-error" role="alert">
          {error}
          <button className="text-action" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      <Dialog
        open={Boolean(inviteToken)}
        onClose={() => {
          if (!claiming) clearInvitation();
        }}
        title={
          inviteStatus === 'unavailable'
            ? 'This invitation has moved on.'
            : 'A little something to share.'
        }
        description={
          inviteStatus === 'unavailable'
            ? 'Ask your friend for a fresh link. Your account is ready whenever they are.'
            : 'Accept with the same number your friend invited. Then you can see the shared details.'
        }
      >
        <div className="account-invite-art">
          <Link2 size={30} strokeWidth={1.4} />
        </div>
        {inviteStatus === 'available' && (
          <Button fullWidth size="lg" loading={claiming} onClick={() => void claimInvitation()}>
            Accept invitation <ArrowRight size={17} />
          </Button>
        )}
        {inviteStatus === null && <p role="status">Checking your invitation…</p>}
        {inviteStatus === 'unavailable' && (
          <Button fullWidth onClick={clearInvitation}>
            Back to Tallie
          </Button>
        )}
        <p className="fine-print">
          Your friend’s private information stays hidden until the invitation matches your account.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
      {securityOpen && (
        <AccountSecurity
          account={state.account}
          onClose={() => setSecurityOpen(false)}
          onChanged={refresh}
        />
      )}
      {messagingAvailable && messagesOpen && (
        <AccountMessages
          onClose={() => setMessagesOpen(false)}
          onDraft={(draft) => {
            setMessagesOpen(false);
            setMessageDraft({ ...draft });
          }}
          {...(selectedDraftId ? { selectedDraftId } : {})}
          onExpense={(id) => {
            setMessagesOpen(false);
            setExpenseId(id);
          }}
        />
      )}
    </AccountContext.Provider>
  );
}
