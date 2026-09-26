#!/usr/bin/env python3
"""Check public Natural OpenAPI assumptions without authenticated API requests.

Usage:
  python3 docs/technical/verification/check_natural_contract.py
  python3 docs/technical/verification/check_natural_contract.py --schema /path/openapi.json

Only the public schema is fetched (HTTP GET). This does not access an account,
create fixtures, call sandbox endpoints, or verify runtime/settlement behavior.
The sole written artifact is the JSON result file. No third-party modules needed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


SCHEMA_URL = "https://docs.natural.com/api-reference/openapi.json"
MAX_SCHEMA_BYTES = 15_000_000


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", type=Path, help="Read an existing schema instead of fetching it")
    parser.add_argument(
        "--output", type=Path,
        default=Path(__file__).with_name("natural-contract-results.json"),
    )
    parser.add_argument("--expected-sha256", help="Optional snapshot pin; drift fails this run")
    args = parser.parse_args()

    started_at = datetime.now(timezone.utc).isoformat()
    result: dict = {
        "checked_at": started_at,
        "source": SCHEMA_URL,
        "input_mode": "local_file" if args.schema else "public_http_get",
        "scope": "Public OpenAPI contract assertions only",
        "limitations": (
            "No authenticated API calls, sandbox fixtures, SDK serialization, "
            "runtime behavior, fees, authorization, or settlement were tested. "
            "Passing is evidence of these specific public schema fields only."
        ),
        "checks": [],
    }

    try:
        if args.schema:
            raw = args.schema.read_bytes()
        else:
            request = Request(SCHEMA_URL, headers={"User-Agent": "PeerPayments-ContractAudit/1.0"})
            with urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise RuntimeError(f"Schema GET returned HTTP {response.status}")
                raw = response.read(MAX_SCHEMA_BYTES + 1)
        if len(raw) > MAX_SCHEMA_BYTES:
            raise ValueError("Schema exceeds configured size limit")
        spec = json.loads(raw)
        result["sha256"] = hashlib.sha256(raw).hexdigest()
        result["schema_bytes"] = len(raw)
        result["openapi_version"] = spec.get("openapi")

        def request_attributes(path: str) -> dict:
            return spec["paths"][path]["post"]["requestBody"]["content"]["application/json"][
                "schema"
            ]["properties"]["data"]["properties"]["attributes"]

        def response_attributes(path: str) -> dict:
            return spec["paths"][path]["get"]["responses"]["200"]["content"]["application/json"][
                "schema"
            ]["properties"]["data"]["properties"]["attributes"]["properties"]

        def query_parameters(path: str) -> list[dict]:
            return [p for p in spec["paths"][path]["get"].get("parameters", []) if p["in"] == "query"]

        def check(name: str, verify) -> None:
            try:
                passed = bool(verify())
                result["checks"].append({"name": name, "passed": passed})
            except (KeyError, TypeError, IndexError, StopIteration) as exc:
                result["checks"].append({
                    "name": name, "passed": False,
                    "detail": f"Schema shape changed: {type(exc).__name__}: {exc}",
                })

        check("request_create_actor_wallet_payer", lambda: all(
            key in request_attributes("/payment-requests")["properties"]
            for key in ("customerPartyId", "walletId", "payer")
        ))
        check("request_amount_integer_positive", lambda:
            request_attributes("/payment-requests")["properties"]["amount"]["type"] == "integer"
            and request_attributes("/payment-requests")["properties"]["amount"]["exclusiveMinimum"] == 0
        )
        check("fulfill_amount_cannot_be_overridden", lambda:
            "amount" not in request_attributes("/payment-requests/{paymentRequestId}/fulfill")["properties"]
            and request_attributes("/payment-requests/{paymentRequestId}/fulfill")["additionalProperties"] is False
        )
        check("fulfill_only_wallet_external_account", lambda: {
            source["properties"]["type"]["enum"][0]
            for source in request_attributes("/payment-requests/{paymentRequestId}/fulfill")["properties"]["paymentSource"]["anyOf"]
        } == {"wallet", "external_account"})
        check("direct_pay_has_no_external_source", lambda:
            "externalAccountId" not in request_attributes("/payments")["properties"]
            and "paymentSource" not in request_attributes("/payments")["properties"]
        )
        check("cancel_can_act_for_requester", lambda:
            "customerPartyId" in request_attributes("/payment-requests/{paymentRequestId}/cancel")["properties"]
        )
        money_paths = (
            "/payment-requests", "/payment-requests/{paymentRequestId}/fulfill",
            "/payment-requests/{paymentRequestId}/cancel", "/payments",
            "/transfers/deposit", "/transfers/withdraw",
        )
        check("money_mutations_require_idempotency", lambda: all(
            any(header["name"] == "Idempotency-Key" and header["required"] is True
                for header in spec["paths"][path]["post"]["parameters"])
            for path in money_paths
        ))
        check("request_states_include_return", lambda:
            set(response_attributes("/payment-requests/{paymentRequestId}")["status"]["enum"])
            == {"OPEN", "PROCESSING", "COMPLETED", "FAILED", "RETURNED", "CANCELED", "DECLINED", "EXPIRED"}
        )
        check("payment_states_include_review", lambda:
            set(response_attributes("/payments/{paymentId}")["status"]["enum"])
            == {"CREATED", "PROCESSING", "PENDING_CLAIM", "IN_REVIEW", "COMPLETED", "FAILED", "RETURNED", "APPROVAL_DENIED", "CANCELED"}
        )
        check("webhooks_connected_optin", lambda:
            set(request_attributes("/webhooks")["properties"]["sources"]["items"]["enum"])
            == {"own", "connected"}
        )
        check("payment_returns_but_no_request_return_event", lambda:
            "payment.returned" in request_attributes("/webhooks")["properties"]["enabledEvents"]["items"]["enum"]
            and "payment_request.returned" not in request_attributes("/webhooks")["properties"]["enabledEvents"]["items"]["enum"]
        )
        check("event_history_requires_event_type_for_customer", lambda:
            "Required when customerPartyId names another party"
            in next(p["schema"]["description"] for p in query_parameters("/events") if p["name"] == "eventType")
        )
        check("no_payment_list_tag_filter", lambda:
            {p["name"] for p in query_parameters("/payments")} == {"customerPartyId", "limit", "cursor"}
        )
        check("connection_states", lambda:
            set(response_attributes("/customers/{customerId}")["delegation"]["properties"]["status"]["enum"])
            == {"ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"}
        )
        check("invite_redirect_supported", lambda:
            "redirectUrl" in request_attributes("/customers/invitations")["properties"]
        )
        check("instance_header_conditionally_optional_in_schema", lambda: all(
            any(header["name"] == "X-Instance-ID" and header["required"] is False
                for header in spec["paths"][path]["post"]["parameters"])
            for path in money_paths
        ))
        check("rest_payment_and_request_have_no_version_field", lambda: all(
            "version" not in response_attributes(path)
            for path in ("/payments/{paymentId}", "/payment-requests/{paymentRequestId}")
        ))
        check("rest_payment_and_request_have_updated_at", lambda: all(
            "updatedAt" in response_attributes(path)
            for path in ("/payments/{paymentId}", "/payment-requests/{paymentRequestId}")
        ))
        if args.expected_sha256:
            check("requested_snapshot_hash_matches", lambda: result["sha256"] == args.expected_sha256.lower())
        result["passed"] = all(item["passed"] for item in result["checks"])
    except (OSError, ValueError, RuntimeError) as exc:
        result["passed"] = False
        result["error"] = f"{type(exc).__name__}: {exc}"

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    passed = sum(item["passed"] for item in result["checks"])
    print(f"Public schema checks: {passed}/{len(result['checks'])} passed")
    print(f"SHA-256: {result.get('sha256', 'unavailable')}")
    if "error" in result:
        print(f"Error: {result['error']}")
    for item in result["checks"]:
        if not item["passed"]:
            print(f"FAIL: {item['name']}: {item.get('detail', 'assertion changed')}")
    print("No authenticated calls or sandbox/runtime validation performed.")
    print(f"Result: {args.output}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
