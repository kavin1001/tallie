import { validateNaturalWebhookSecret } from './webhook-verification';

/** Offline release assessment. This never enables payments or verifies provider credentials. */
export type PaymentReadinessEnvironment = Readonly<Record<string, string | undefined>>;
export interface PaymentReadinessCheck {
  id: string;
  category: 'configuration' | 'implementation' | 'operator_evidence' | 'budget';
  status: 'pass' | 'blocked';
  message: string;
}
export interface PaymentReleaseEvidence {
  version: 1;
  productionCredentialBindings: boolean;
  hostedOnboardingAndBankRoundTrip: boolean;
  passkeyAndRecoveryDevices: boolean;
  twoPersonPaymentDevices: boolean;
  webhookAndRestartRecovery: boolean;
  alwaysOnWorkerAndAlerts: boolean;
  databaseBackupRestore: boolean;
  paymentPauseControl: boolean;
  budget: {
    pricesChecked: boolean;
    fixedInfrastructureUsd: number;
    providerSubscriptionsUsd: number;
    variableUsageAllowanceUsd: number;
    taxAndContingencyUsd: number;
  };
}

export const paymentReleaseEvidenceTemplate: PaymentReleaseEvidence = {
  version: 1,
  productionCredentialBindings: false,
  hostedOnboardingAndBankRoundTrip: false,
  passkeyAndRecoveryDevices: false,
  twoPersonPaymentDevices: false,
  webhookAndRestartRecovery: false,
  alwaysOnWorkerAndAlerts: false,
  databaseBackupRestore: false,
  paymentPauseControl: false,
  budget: {
    pricesChecked: false,
    fixedInfrastructureUsd: 0,
    providerSubscriptionsUsd: 0,
    variableUsageAllowanceUsd: 0,
    taxAndContingencyUsd: 0,
  },
};

const evidenceMessages = {
  productionCredentialBindings:
    'Verify production credential ownership, active agent and exact agent-key binding with read-only checks.',
  hostedOnboardingAndBankRoundTrip:
    'Observe real hosted customer acceptance, the intended wallet grant, bank funding availability and cash-out.',
  passkeyAndRecoveryDevices:
    'Verify production-origin passkey enrollment, sign-in, recovery and phone-demo account migration on devices.',
  twoPersonPaymentDevices:
    'Observe two consenting people claim, review and explicitly approve one payment on their own devices.',
  webhookAndRestartRecovery:
    'Verify authenticated production event delivery, duplicate events and reconciliation after process restart.',
  alwaysOnWorkerAndAlerts:
    'Verify an always-on payment worker and actionable alerts for unresolved transfers and worker failure.',
  databaseBackupRestore: 'Verify the production database has backups and exercise a restore.',
  paymentPauseControl:
    'Verify pausing new payment submissions preserves reconciliation of existing transfers.',
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evidenceIsValid(value: unknown): value is PaymentReleaseEvidence {
  if (!object(value) || value.version !== 1 || !object(value.budget)) return false;
  const budget = value.budget;
  const evidenceKeys = Object.keys(paymentReleaseEvidenceTemplate);
  const budgetKeys = Object.keys(paymentReleaseEvidenceTemplate.budget);
  if (
    Object.keys(value).length !== evidenceKeys.length ||
    Object.keys(value).some((key) => !evidenceKeys.includes(key)) ||
    Object.keys(budget).length !== budgetKeys.length ||
    Object.keys(budget).some((key) => !budgetKeys.includes(key)) ||
    Object.keys(evidenceMessages).some((key) => typeof value[key] !== 'boolean') ||
    typeof budget.pricesChecked !== 'boolean'
  )
    return false;
  return budgetKeys
    .filter((key) => key !== 'pricesChecked')
    .every((key) => {
      const amount = budget[key];
      return (
        typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= 100_000
      );
    });
}

function publicOrigin(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '');
    return (
      url.origin === value &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

function configuredDatabase(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '');
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      Boolean(url.hostname && url.username && url.password && url.pathname.length > 1) &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function configuredWebhookSecret(value: string | undefined): boolean {
  try {
    validateNaturalWebhookSecret(value ?? '');
    return true;
  } catch {
    return false;
  }
}

/** Facts about this release, deliberately compiled into code rather than environment flags.
 * Sandbox equivalents and operator declarations cannot satisfy these production requirements.
 */
const productionImplementation = {
  customerActivation:
    'Complete recovery of unknown or expired hosted invitations and verify real customer/delegation/wallet binding.',
  bankFundingAndWithdrawal:
    'Implement a supported production funding and cash-out journey with available balances, fees and holds.',
  exactShareDebit:
    'Implement the production share journal, exact consent, recent strong authentication and payment limits.',
  durablePaymentLifecycle:
    'Connect production payment dispatch, authenticated events, canonical reconciliation and late returns.',
} as const;

export function assessPaymentReadiness(env: PaymentReadinessEnvironment, evidence?: unknown) {
  const checks: PaymentReadinessCheck[] = [];
  const check = (
    id: string,
    category: PaymentReadinessCheck['category'],
    condition: boolean,
    message: string,
  ) => checks.push({ id, category, status: condition ? 'pass' : 'blocked', message });

  check(
    'production_runtime',
    'configuration',
    env.NODE_ENV === 'production' && env.APP_MODE === 'beta',
    'Use the production runtime in beta mode; the simulator is not a payment release.',
  );
  check(
    'public_origin',
    'configuration',
    publicOrigin(env.APP_ORIGIN),
    'Configure the exact public HTTPS origin used by passkeys, invitations and callbacks.',
  );
  check(
    'persistent_database',
    'configuration',
    configuredDatabase(env.DATABASE_URL),
    'Configure the intended hosted PostgreSQL database; this syntax check does not verify TLS, access or durability.',
  );
  check(
    'demo_authority_disabled',
    'configuration',
    env.APP_PREVIEW_MODE !== 'true' &&
      env.IDENTITY_PHONE_DEMO_ENABLED !== 'true' &&
      env.NATURAL_SANDBOX_ENABLED !== 'true',
    'Disable phone-demo access, the free-preview runtime and synthetic accounts for this live-money release.',
  );
  check(
    'identity_secrets',
    'configuration',
    /^[a-f\d]{64}$/i.test(env.IDENTITY_ENCRYPTION_KEY ?? '') &&
      (env.BETTER_AUTH_SECRET?.length ?? 0) >= 32 &&
      env.IDENTITY_ENCRYPTION_KEY !== env.BETTER_AUTH_SECRET,
    'Configure independent identity encryption and authentication secrets; presence is not proof of secure generation.',
  );
  check(
    'phone_verification_config',
    'configuration',
    ['SENDBLUE_API_KEY_ID', 'SENDBLUE_API_SECRET_KEY', 'SENDBLUE_VERIFY_SERVICE_SID'].every((key) =>
      Boolean(env[key]?.trim()),
    ),
    'Configure the phone verification provider; this check makes no provider calls.',
  );
  check(
    'production_natural_credentials',
    'configuration',
    /^sk_ntl_prod_[A-Za-z0-9_-]{1,512}$/.test(env.NATURAL_PRODUCTION_API_KEY ?? '') &&
      /^ak_ntl_prod_[A-Za-z0-9_-]{1,512}$/.test(env.NATURAL_PRODUCTION_AGENT_KEY ?? '') &&
      /^agt_[0-9a-f]{32}$/.test(env.NATURAL_PRODUCTION_AGENT_ID ?? '') &&
      /^pty_[0-9a-f]{32}$/.test(env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID ?? ''),
    'Configure separate production party and bound-agent credentials and production agent/platform IDs.',
  );
  check(
    'production_webhook_secret',
    'configuration',
    configuredWebhookSecret(env.NATURAL_PRODUCTION_WEBHOOK_SECRET),
    'Store the signing secret issued for the production Natural webhook separately from sandbox.',
  );
  for (const [id, message] of Object.entries(productionImplementation))
    check(id, 'implementation', false, message);

  const validEvidence = evidenceIsValid(evidence);
  check(
    'evidence_format',
    'operator_evidence',
    validEvidence,
    'Supply the versioned evidence file containing only the documented booleans and numeric budget allowances.',
  );
  for (const [key, message] of Object.entries(evidenceMessages))
    check(
      key,
      'operator_evidence',
      validEvidence && evidence[key as keyof typeof evidenceMessages] === true,
      message,
    );
  const budget = validEvidence ? evidence.budget : null;
  const plannedCents = budget
    ? Math.ceil(budget.fixedInfrastructureUsd * 100) +
      Math.ceil(budget.providerSubscriptionsUsd * 100) +
      Math.ceil(budget.variableUsageAllowanceUsd * 100) +
      Math.ceil(budget.taxAndContingencyUsd * 100)
    : null;
  check(
    'monthly_budget',
    'budget',
    Boolean(
      budget?.pricesChecked &&
      budget.fixedInfrastructureUsd > 0 &&
      budget.variableUsageAllowanceUsd > 0 &&
      budget.taxAndContingencyUsd > 0 &&
      plannedCents !== null &&
      plannedCents <= 10_000,
    ),
    'Keep hosting, existing provider subscriptions, variable usage and tax/contingency within the approved $100 monthly ceiling.',
  );

  return {
    version: 1 as const,
    mode: 'offline_release_assessment' as const,
    status: checks.every((item) => item.status === 'pass') ? 'ready' : 'blocked',
    moneyMovementEnabled: false as const,
    naturalP2pApproval: 'founder_confirmed' as const,
    evidenceLevel: 'configuration_syntax_and_operator_declarations' as const,
    notice:
      'This offline report does not authenticate credentials, inspect hosted infrastructure, verify declarations or enable payments.',
    budget: {
      approvedMonthlyUsd: 100,
      plannedMonthlyUsd: plannedCents === null ? null : plannedCents / 100,
    },
    checks,
  };
}
