# AWS preview storage preparation

**September 26, 2026 — prepared configuration, not applied.** No AWS credentials were read, no authenticated AWS API was called, and no bucket or IAM identity was created by this task. The current preview keeps receipt uploads disabled. Browser setup is the founder's current preference; the optional policy below is for a future API workflow.

**Console inspection:** authenticated Billing and Free Tier pages were inspected during deployment. They show $0 month-to-date charges and no Free Tier usage data, but do not confirm an active Free account plan with credits and a future expiry. Storage provisioning is therefore deferred under the $0 budget. No account plan or payment setting was changed. The Render account preview does not require AWS storage.

## Confirm the $0 constraint first

In AWS Console Home / Billing, verify the account is on the **Free account plan**, active, with remaining credit and a future expiration. AWS's free plan ends at six months or credit exhaustion, whichever is earlier; the account then closes. A paid plan with credit can still incur charges beyond its coverage. Under the current $0-only authorization, an unknown or paid plan means **defer S3 and leave receipts disabled**. [AWS plan comparison](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html).

For a future API check, the exact operation is **`GetAccountPlanState`**, with IAM action `freetier:GetAccountPlanState` and CLI:

```sh
aws freetier get-account-plan-state --region us-east-1 --profile tallie-preview-provisioner
```

Require `accountPlanType=FREE`, `accountPlanStatus=ACTIVE`, `accountPlanRemainingCredits.unit=USD`, a positive credit amount, and future `accountPlanExpirationDate`. Missing fields, denied access, or expired status do not establish coverage. The API also returns the account ID. Recheck immediately before provisioning; IAM cannot enforce this billing gate. [API response fields](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_freetier_GetAccountPlanState.html), [IAM action/resource requirements](https://docs.aws.amazon.com/service-authorization/latest/reference/list_freetier.html).

## Optional provisioning credential

The reviewed [policy template](../../deploy/aws-preview-storage-policy.json) grants account-plan reads, creation of general-purpose `tallie-preview-*` buckets in `us-east-1`, configuration reads, and lifecycle writes to those buckets in the same account. Prefer replacing all three bucket ARN patterns with the exact chosen new bucket name before attaching it. The Free Tier read needs `Resource: "*"` because it has no resource-level ARN.

If an API credential is later needed, an existing account administrator can create a dedicated IAM user and attach only this policy, then create one access key for it. Give it no console password, group membership, or additional policy. Use an AWS CLI named profile; keep credentials outside the repository. This credential cannot create users, policies, roles, or more keys. It has no object read/write/list/delete, bucket-policy, versioning, KMS, upgrade-plan, or bucket-deletion permission. These limits assume it receives no broader permissions from another policy.

The S3 statements require HTTPS. That constrains this credential's requests; it is **not a bucket-wide TLS enforcement policy**. Lifecycle permission can replace rules and cause future object expiration, so reserve this namespace for a new empty preview bucket and retire the provisioning key after setup. [S3 API permission mapping](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html), [same-account bucket restriction](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html).

## Prepare one empty private bucket

Use the S3 console as the founder's existing authorized identity, or the future API credential. Select **US East (N. Virginia), `us-east-1`**, general-purpose bucket, and a unique name starting `tallie-preview-`. Keep:

| Setting                                                        | Required value                       |
| -------------------------------------------------------------- | ------------------------------------ |
| Object Ownership                                               | Bucket owner enforced; ACLs disabled |
| Block Public Access                                            | All four settings enabled            |
| Default encryption                                             | SSE-S3 / AES256                      |
| Versioning                                                     | Never enabled                        |
| Bucket policy, website, replication, acceleration, Object Lock | Unconfigured                         |
| Contents                                                       | Empty; no receipt or test upload yet |

The API workflow intentionally uses current secure creation defaults and verifies them. It omits `--object-ownership`, because sending that header requires an additional permission that also permits changing ownership controls. It omits `--create-bucket-configuration`, which is the required default-region form for `us-east-1`; the policy's `Null` condition rejects a different location constraint. Block Public Access is enabled and ownership is enforced by default for new buckets. Default encryption is SSE-S3. [CreateBucket behavior and permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html), [encryption defaults](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketEncryption.html).

After the billing gate, a future API workflow may use:

```sh
TALLIE_PREVIEW_BUCKET='tallie-preview-replace-with-a-unique-name'
TALLIE_PREVIEW_OWNER='replace-with-the-12-digit-account-id'
aws s3api create-bucket --bucket "$TALLIE_PREVIEW_BUCKET" --region us-east-1 --profile tallie-preview-provisioner
```

Use a **new** name. Do not blindly repeat CreateBucket on an existing owned bucket: the `us-east-1` legacy behavior can reset ACLs. Read configuration after an uncertain result instead.

Read back `get-bucket-location`, `get-bucket-ownership-controls`, `get-public-access-block`, `get-bucket-encryption`, and `get-bucket-versioning`, each with `--bucket "$TALLIE_PREVIEW_BUCKET" --expected-bucket-owner "$TALLIE_PREVIEW_OWNER" --region us-east-1 --profile tallie-preview-provisioner`. Location must be `null` for `us-east-1`; ownership must be `BucketOwnerEnforced`, all public-block booleans true, encryption AES256, and versioning status absent. If any setting differs, stop; the narrow credential cannot repair security settings. [Location response](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketLocation.html).

Add this exact lifecycle configuration through the console, or `put-bucket-lifecycle-configuration` with the same bucket, expected owner, region and profile flags:

```json
{
  "Rules": [
    {
      "ID": "expire-preview-receipts",
      "Status": "Enabled",
      "Filter": { "Prefix": "receipts/v1/" },
      "Expiration": { "Days": 2 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

Read back with `get-bucket-lifecycle-configuration`. This replaces lifecycle configuration; apply it only to the dedicated new bucket. Two days defines lifecycle eligibility, not a guaranteed 48-hour deletion deadline. There are no storage-class transitions. [Lifecycle API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketLifecycleConfiguration.html), [expiration timing](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html).

## Gate before any runtime upload

An empty bucket is preparation only. Keep `RECEIPTS_ENABLED=false` until processing capacity, provider coverage and storage checks are ready. An administrator must then install and verify a bucket policy rejecting insecure transport: this provisioning policy intentionally excludes `s3:PutBucketPolicy`. Add separate object permissions for web and worker roles from [the receipt storage design](deployment-storage.md), verify denied public/cross-role access and cleanup, and confirm the billing plan again. Do not deploy the provisioning credential as a runtime credential.

**Verification:** official API/action/resource references checked; local JSON syntax and permission-shape checks passed. AWS policy validation, actual creation defaults, console behavior, lifecycle and authorization remain untested in the founder's account.
