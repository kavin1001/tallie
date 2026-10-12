import { describe, expect, it } from 'vitest';
import {
  assessPaymentReadiness,
  paymentReleaseEvidenceTemplate,
  type PaymentReadinessEnvironment,
  type PaymentReleaseEvidence,
} from './readiness';

const env: PaymentReadinessEnvironment = {
  NODE_ENV: 'production',
  APP_MODE: 'beta',
  APP_ORIGIN: 'https://tallie.example',
  DATABASE_URL: 'postgresql://fixture:fixture-secret@private-db.example/tallie',
  IDENTITY_ENCRYPTION_KEY: 'a'.repeat(64),
  BETTER_AUTH_SECRET: 'b'.repeat(64),
  SENDBLUE_API_KEY_ID: 'fixture-key',
  SENDBLUE_API_SECRET_KEY: 'fixture-secret',
  SENDBLUE_VERIFY_SERVICE_SID: 'fixture-service',
  NATURAL_PRODUCTION_API_KEY: 'sk_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_ID: `agt_${'1'.repeat(32)}`,
  NATURAL_PRODUCTION_PLATFORM_PARTY_ID: `pty_${'2'.repeat(32)}`,
  NATURAL_PRODUCTION_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
};
const evidence: PaymentReleaseEvidence = {
  version: 1,
  productionCredentialBindings: true,
  hostedOnboardingAndBankRoundTrip: true,
  passkeyAndRecoveryDevices: true,
  twoPersonPaymentDevices: true,
  webhookAndRestartRecovery: true,
  alwaysOnWorkerAndAlerts: true,
  databaseBackupRestore: true,
  paymentPauseControl: true,
  budget: {
    pricesChecked: true,
    fixedInfrastructureUsd: 66.5,
    providerSubscriptionsUsd: 0,
    variableUsageAllowanceUsd: 20,
    taxAndContingencyUsd: 13.5,
  },
};
function result(id: string, customEnv = env, customEvidence: unknown = evidence) {
  return assessPaymentReadiness(customEnv, customEvidence).checks.find((check) => check.id === id);
}

describe('offline production payment readiness', () => {
  it('cannot turn sandbox implementation into a production release with environment flags or declarations', () => {
    const report = assessPaymentReadiness(
      { ...env, NATURAL_PRODUCTION_ENABLED: 'true', PAYMENTS_ENABLED: 'true' },
      evidence,
    );
    expect(report.status).toBe('blocked');
    expect(report.moneyMovementEnabled).toBe(false);
    expect(report.naturalP2pApproval).toBe('founder_confirmed');
    expect(report.checks.filter((check) => check.category === 'configuration')).toSatisfy(
      (checks: { status: string }[]) => checks.every((check) => check.status === 'pass'),
    );
    expect(report.checks.filter((check) => check.category === 'implementation')).toHaveLength(4);
    expect(report.checks.filter((check) => check.category === 'implementation')).toSatisfy(
      (checks: { status: string }[]) => checks.every((check) => check.status === 'blocked'),
    );
  });

  it('fails closed with absent evidence and retains the separately confirmed P2P approval', () => {
    const report = assessPaymentReadiness({});
    expect(report.status).toBe('blocked');
    expect(report.naturalP2pApproval).toBe('founder_confirmed');
    expect(report.budget.plannedMonthlyUsd).toBeNull();
    expect(report.checks.find((check) => check.id === 'evidence_format')?.status).toBe('blocked');
    expect(report.checks.some((check) => check.id === 'program_approval')).toBe(false);
  });

  it.each(['APP_PREVIEW_MODE', 'IDENTITY_PHONE_DEMO_ENABLED', 'NATURAL_SANDBOX_ENABLED'])(
    'rejects %s for a real-money release',
    (setting) => {
      expect(result('demo_authority_disabled', { ...env, [setting]: 'true' })?.status).toBe(
        'blocked',
      );
    },
  );

  it.each([
    'http://localhost:3001',
    'https://localhost',
    'https://tallie.example/extra',
    'https://user:secret@tallie.example',
  ])('rejects invalid production origin %s', (origin) => {
    expect(result('public_origin', { ...env, APP_ORIGIN: origin })?.status).toBe('blocked');
  });

  it('rejects sandbox credentials in production settings', () => {
    expect(
      result('production_natural_credentials', {
        ...env,
        NATURAL_PRODUCTION_API_KEY: 'sk_ntl_sandbox_fixture',
      })?.status,
    ).toBe('blocked');
    expect(
      result('production_natural_credentials', {
        ...env,
        NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_sandbox_fixture',
      })?.status,
    ).toBe('blocked');
  });

  it('does not reuse sandbox IDs/credentials when independent production configuration is absent', () => {
    expect(
      result('production_natural_credentials', {
        ...env,
        NATURAL_PRODUCTION_AGENT_KEY: undefined,
        NATURAL_AGENT_KEY: 'ak_ntl_sandbox_fixture',
      })?.status,
    ).toBe('blocked');
  });

  it('treats $100 as the entire ceiling including provider subscriptions and usage', () => {
    expect(result('monthly_budget')?.status).toBe('pass');
    expect(
      result('monthly_budget', env, {
        ...evidence,
        budget: { ...evidence.budget, providerSubscriptionsUsd: 100 },
      })?.status,
    ).toBe('blocked');
    expect(
      result('monthly_budget', env, {
        ...evidence,
        budget: { ...evidence.budget, taxAndContingencyUsd: 13.501 },
      })?.status,
    ).toBe('blocked');
  });

  it('requires actual allowances and checked prices, not a zero-filled template', () => {
    expect(result('monthly_budget', env, paymentReleaseEvidenceTemplate)?.status).toBe('blocked');
    expect(
      result('monthly_budget', env, {
        ...evidence,
        budget: { ...evidence.budget, pricesChecked: false },
      })?.status,
    ).toBe('blocked');
  });

  it.each([
    { ...evidence, hostedOnboardingAndBankRoundTrip: 'true' },
    { ...evidence, version: 2 },
    { ...evidence, secret: 'accidentally pasted secret' },
    { ...evidence, budget: { ...evidence.budget, providerSubscriptionsUsd: -1 } },
    {
      ...evidence,
      budget: { ...evidence.budget, providerSubscriptionsUsd: Number.POSITIVE_INFINITY },
    },
    { ...evidence, budget: { ...evidence.budget, notes: 'sensitive text' } },
  ])('rejects malformed or unknown evidence fields without echoing their contents', (input) => {
    expect(result('evidence_format', env, input)?.status).toBe('blocked');
    const serialized = JSON.stringify(assessPaymentReadiness(env, input));
    expect(serialized).not.toContain('accidentally pasted secret');
    expect(serialized).not.toContain('sensitive text');
  });

  it('never copies secrets, database URLs, IDs or configuration values into output', () => {
    const report = JSON.stringify(assessPaymentReadiness(env, evidence));
    for (const key of [
      'BETTER_AUTH_SECRET',
      'IDENTITY_ENCRYPTION_KEY',
      'DATABASE_URL',
      'NATURAL_PRODUCTION_API_KEY',
      'NATURAL_PRODUCTION_AGENT_KEY',
      'NATURAL_PRODUCTION_AGENT_ID',
      'NATURAL_PRODUCTION_PLATFORM_PARTY_ID',
      'NATURAL_PRODUCTION_WEBHOOK_SECRET',
    ])
      expect(report).not.toContain(env[key]);
  });

  it('does not mutate caller evidence or configuration', () => {
    const original = JSON.stringify({ env, evidence });
    assessPaymentReadiness(env, evidence);
    expect(JSON.stringify({ env, evidence })).toBe(original);
  });
});
