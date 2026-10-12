import { readFile } from 'node:fs/promises';
import { assessPaymentReadiness, paymentReleaseEvidenceTemplate } from '@tallie/payments/readiness';

// Offline and read-only. Never print environment values, input contents or raw exceptions.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--template') {
    console.log(JSON.stringify(paymentReleaseEvidenceTemplate, null, 2));
    return;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--evidence' && args[1]))
    throw new Error('invalid_arguments');
  let evidence: unknown;
  if (args[1]) {
    const source = await readFile(args[1]);
    if (source.byteLength > 16_384) throw new Error('evidence_too_large');
    evidence = JSON.parse(source.toString('utf8')) as unknown;
  }
  const result = assessPaymentReadiness(process.env, evidence);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'ready' ? 0 : 1;
}

void main().catch(() => {
  console.error(
    JSON.stringify({
      status: 'blocked',
      moneyMovementEnabled: false,
      reason: 'invalid_input',
      message:
        'Use no arguments, --template, or --evidence with a readable versioned JSON evidence file.',
    }),
  );
  process.exitCode = 2;
});
