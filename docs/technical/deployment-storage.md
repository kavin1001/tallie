# Private receipt storage for deployment

**Updated:** September 26, 2026. **Status:** S3 adapter implemented and tested with mocked SDK ports. No AWS bucket, IAM identity, lifecycle rule, credential, upload, or deployed role permission has been provisioned or verified by this work.

Separate web and receipt-worker services cannot rely on the same local directory. Local development keeps the filesystem adapter. Deployment can select the S3 adapter, with a private bucket shared by narrowly scoped service identities.

## Configuration

| Variable | Meaning |
|---|---|
| `RECEIPT_STORAGE_DRIVER` | `filesystem` (default) or `s3`. Unknown values fail closed. |
| `RECEIPT_STORAGE_DIR` | Absolute local directory; required only for filesystem mode. |
| `RECEIPTS_BUCKET` | Dedicated plain bucket name for S3 mode. This implementation accepts lowercase letters, digits and hyphens, 3–63 characters. It accepts no bucket URL, ARN or dotted name. |
| `AWS_REGION` | Actual AWS region containing the bucket. |
| `RECEIPTS_BUCKET_OWNER` | Recommended optional 12-digit owning AWS account ID. If set, every command sends `ExpectedBucketOwner`. |
| AWS standard credential chain | Prefer an attached IAM role where supported. On a host without AWS workload identity, set that service's separate `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, for temporary credentials, `AWS_SESSION_TOKEN` in secret environment settings. Never use root credentials. |

Use the same bucket, region and owner across services. Give each service its own IAM principal/credentials. The core maintenance worker needs no object-store credentials. Messaging needs source upload permission only when its receipt-ingestion path is enabled.

The adapter explicitly selects the AWS S3 HTTPS endpoint derived from the configured region; arbitrary endpoints and provider URLs are unsupported. It does not create signed URLs, public objects or bucket ACLs. It does not read or log AWS key values. Credentials must never be supplied at image build time.

## Object and access model

Keys contain a backend-created UUID and fixed prefix, never a filename, phone number, contact name, receipt contents or model output:

```text
receipts/v1/source/{receipt_uuid}.source
receipts/v1/normalized/{receipt_uuid}.jpg
```

Both object types are limited to 8 MiB by the S3 adapter. Source writes use conditional `If-None-Match: *` and cannot replace an existing object. Normalized writes atomically replace the complete normalized object; there is no exposed partial upload. Writes specify SSE-S3 (`AES256`), a SHA-256 checksum and private/no-store cache metadata. Originals use `application/octet-stream`; normalized images use `image/jpeg`.

Reads stream through the authenticated server and enforce both declared-length and actual-byte limits. Truncated, oversized and stalled responses are rejected; the overall read deadline is 15 seconds. Provider failures are mapped to safe application errors without upstream response bodies, credentials or object keys. A duplicate source write is a nonretryable conflict; a transient storage interruption is retryable within the existing receipt job limits.

The application checks receipt ownership before reading an image. S3 has no anonymous read route. The storage helper is deliberately unaware of users; callers remain responsible for current account/session authorization.

## Service permissions

Use the exact bucket ARN in each policy. None of these services needs `s3:ListBucket`, ACL management, bucket-policy updates, lifecycle updates, object-store administration, or access outside the fixed receipt prefix.

| Principal | Object permissions |
|---|---|
| Web | `s3:PutObject` on `receipts/v1/source/*`; `s3:GetObject` on `receipts/v1/normalized/*` |
| Receipt worker | `s3:GetObject` on source; `s3:PutObject` on normalized; `s3:DeleteObject` on source and normalized |
| Messaging worker | `s3:PutObject` on source, only for the configured inbound-receipt workflow |
| Core maintenance worker | None |

The web upload rollback attempts deletion as a best effort. Its IAM principal may intentionally deny that call; the original application error is preserved. An orphan object stays private until lifecycle cleanup. This avoids giving the web process deletion authority over every user's images.

Example **web identity policy**, replace `YOUR_PRIVATE_BUCKET` before use:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteImmutableReceiptSources",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::YOUR_PRIVATE_BUCKET/receipts/v1/source/*",
      "Condition": {
        "StringEquals": {
          "s3:if-none-match": "*",
          "s3:x-amz-server-side-encryption": "AES256"
        }
      }
    },
    {
      "Sid": "ReadNormalizedReceipts",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR_PRIVATE_BUCKET/receipts/v1/normalized/*"
    }
  ]
}
```

Example **receipt-worker identity policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR_PRIVATE_BUCKET/receipts/v1/source/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::YOUR_PRIVATE_BUCKET/receipts/v1/normalized/*",
      "Condition": {
        "StringEquals": { "s3:x-amz-server-side-encryption": "AES256" }
      }
    },
    {
      "Effect": "Allow",
      "Action": "s3:DeleteObject",
      "Resource": [
        "arn:aws:s3:::YOUR_PRIVATE_BUCKET/receipts/v1/source/*",
        "arn:aws:s3:::YOUR_PRIVATE_BUCKET/receipts/v1/normalized/*"
      ]
    }
  ]
}
```

The messaging principal can use only the first statement of the web policy. These are reviewable policy templates, not evidence of applied permissions. Choose the correct ARN partition if deploying outside commercial AWS.

## Bucket configuration and retention

Create a dedicated private, nonversioned bucket for temporary receipt captures. Enable all S3 Block Public Access controls, Bucket owner enforced object ownership, default SSE-S3 encryption and a policy denying non-TLS requests. Do not enable object lock or replication for this temporary bucket without reviewing retention behavior. Browser CORS is unnecessary because users interact with authenticated Tallie endpoints.

The app's receipt draft expires after 24 hours. The receipt worker deletes both exact objects and then marks the database row purged. Jobs that cross expiry also try to remove their files. Unknown database commits are checked before a rollback cleanup can delete data.

S3 objects that have no committed database row cannot be discovered by the existing database purge. In S3 mode the local orphan-file sweep intentionally returns no paths, because workers have no broad bucket listing permission. **A bucket lifecycle rule is therefore required before enabling uploads.** Suggested temporary-receipt rule:

```json
{
  "Rules": [
    {
      "ID": "ExpireTemporaryTallieReceipts",
      "Status": "Enabled",
      "Filter": { "Prefix": "receipts/v1/" },
      "Expiration": { "Days": 2 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

This is a **two-day eligibility rule, not a guaranteed 48-hour deletion deadline**. AWS rounds day-based lifecycle times and removes eligible objects asynchronously. If an exact maximum retention period is required, implement and verify a separate inventory/janitor process with suitable permissions. No such deletion SLA is claimed here.

If bucket versioning is enabled, deleting current objects can leave previous versions. Add and verify noncurrent-version expiration and delete-marker cleanup before storing receipts. Avoid collecting object access logs containing keys into a broader analytics account; operational logs should use internal request/job references.

## Verification and deployment gates

Locally passed:

- **11 storage tests:** fixed endpoints/configuration, UUID keys, conditional originals, normalized replacements, encryption/cache metadata, input bounds, safe error mapping, exact/truncated reads, oversized headers/streams, stalled-stream timeout, exact-object deletion, S3 orphan behavior and filesystem compatibility.
- **49 receipt tests** passed together, including the prior receipt validation/media/provider tests and real PostgreSQL receipt integration suite.
- Strict TypeScript for the receipt package passed. No external AWS calls occurred.

Before enabling a hosted upload:

1. Provision the private bucket and service identities; inspect applied Block Public Access, ownership, encryption, TLS and lifecycle settings.
2. Verify each deployed role can perform exactly its intended operations and cannot list the bucket, read sources from the web role, make objects public, or access unrelated prefixes.
3. Upload one synthetic receipt through the hosted web app. Observe the separate worker read/decode/extract it and the uploader preview it. Confirm a different account cannot read it.
4. Force an ordinary expiry and confirm both objects are deleted and the database is marked purged. Separately verify an unreferenced synthetic object becomes eligible under the lifecycle policy and is eventually removed.
5. Test worker restart, transient object-store failure, immutable-source conflict and the absent-credential error path. Confirm private content and provider error bodies do not enter logs.

## Primary sources checked

- [AWS SDK v3 S3 examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html)
- [Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [Enforcing conditional writes in bucket policies](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html)
- [Lifecycle expiration and versioning behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html)
- [Lifecycle configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html)
