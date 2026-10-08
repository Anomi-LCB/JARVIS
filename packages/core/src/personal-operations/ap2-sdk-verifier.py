"""Public-evidence verifier using a pinned, external AP2 SDK; no signing keys."""
import base64
import hashlib
import json
import logging
import os
import sys
import time

if len(sys.argv) > 1:
    sys.path.insert(0, sys.argv[1])

from jwcrypto.jwk import JWK
from ap2.sdk.mandate import MandateClient
from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
from ap2.sdk.payment_mandate_chain import PaymentMandateChain
from ap2.sdk.receipt_wrapper import ReceiptClient
from ap2.sdk.jwt_helper import verify_jwt
import ap2.sdk.mandate as mandate_module

logging.disable(logging.CRITICAL)
# This pinned SDK writes its own diagnostic file independently of logging.
# Configure only this isolated process; never edit the vendored SDK source.
mandate_module.LOG_FILE_PATH = os.devnull


def require(condition, code):
    if not condition:
        raise ValueError(code)


def members(pairs):
    result = {}
    for name, value in pairs:
        require(name not in result, "JSON_DUPLICATE")
        result[name] = value
    return result


def validate_json(value, depth=0):
    require(depth <= 32, "JSON_DEPTH")
    if isinstance(value, str):
        value.encode("utf-8", errors="strict")
    elif isinstance(value, dict):
        for key, child in value.items():
            validate_json(key, depth + 1)
            validate_json(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            validate_json(child, depth + 1)


def strict_json(text):
    value = json.loads(text, object_pairs_hook=members,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("JSON_NUMBER")))
    validate_json(value)
    return value


def decode(text):
    return strict_json(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)).decode("utf-8"))


def token_json(token):
    require(isinstance(token, str) and 1 <= len(token) <= 262144, "TOKEN_SIZE")
    hops = token.split("~~")
    require(len(hops) <= 2, "CHAIN_SCOPE")
    for hop in hops:
        segments = hop.split("~")
        jwt = segments[0].split(".")
        require(len(jwt) == 3 and all(jwt), "JWT_SHAPE")
        header = decode(jwt[0])
        require(header.get("alg") == "ES256", "ALGORITHM")
        require(not any(k in header for k in ["jku", "x5u", "x5c", "crit"]), "HEADER_SCOPE")
        decode(jwt[1])
        for disclosure in segments[1:]:
            if disclosure:
                decode(disclosure)


def public_key(value):
    require(isinstance(value, dict) and value.get("kty") == "EC" and value.get("crv") == "P-256"
            and "d" not in value and value.get("use", "sig") == "sig"
            and value.get("alg", "ES256") == "ES256"
            and ("key_ops" not in value or "verify" in value["key_ops"]), "PUBLIC_KEY")
    return JWK(**value)


def digest(text):
    return base64.urlsafe_b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode().rstrip("=")


def time_bound(payload, now):
    require(type(payload.get("iat")) is int and type(payload.get("exp")) is int
            and payload["iat"] <= now < payload["exp"] and payload["iat"] < payload["exp"], "MANDATE_TIME")


def verify_authorizations(data):
    evidence, expected, keys = data["evidence"], data["expected"], data["keys"]
    require(type(expected["now"]) is int and type(expected["totalMinor"]) is int
            and 0 <= expected["totalMinor"] <= 9007199254740991, "EXPECTED_VALUES")
    for token in evidence.values():
        token_json(token)
    checkout_key, payment_key = public_key(keys["checkoutIssuer"]), public_key(keys["paymentIssuer"])
    merchant_key, psp_key = public_key(keys["merchant"]), public_key(keys["psp"])
    client = MandateClient()
    checkout_payloads = client.verify(evidence["checkoutMandate"], lambda _: checkout_key,
        expected_aud=expected["checkoutAudience"], expected_nonce=expected["checkoutNonce"],
        current_time=expected["now"], clock_skew_seconds=0)
    payment_payloads = client.verify(evidence["paymentMandate"], lambda _: payment_key,
        expected_aud=expected["paymentAudience"], expected_nonce=expected["paymentNonce"],
        current_time=expected["now"], clock_skew_seconds=0)
    require(isinstance(checkout_payloads, list) and len(checkout_payloads) == 2
            and isinstance(payment_payloads, list) and len(payment_payloads) == 2, "CHAIN_SCOPE")
    for payload in checkout_payloads + payment_payloads:
        time_bound(payload, expected["now"])
    checkout_chain = CheckoutMandateChain.parse(checkout_payloads)
    payment_chain = PaymentMandateChain.parse(payment_payloads)
    checkout_jwt = evidence["checkoutJwt"]
    checkout_hash = digest(checkout_jwt)
    require(checkout_chain.closed_mandate.checkout_jwt == checkout_jwt, "CHECKOUT_BINDING")
    require(not checkout_chain.verify(expected_checkout_hash=checkout_hash, checkout_jwt=checkout_jwt), "CHECKOUT_CONSTRAINTS")
    require(not payment_chain.verify(expected_transaction_id=checkout_hash), "PAYMENT_CONSTRAINTS")
    checkout = verify_jwt(checkout_jwt, merchant_key)
    payment = payment_chain.closed_mandate
    require(checkout.get("id") == expected["checkoutId"] and checkout.get("currency") == expected["currency"]
            and checkout.get("merchant", {}).get("id") == expected["merchantId"], "CHECKOUT_TARGET")
    totals = [t for t in checkout.get("totals", []) if t.get("type") == "total"]
    require(len(totals) == 1 and type(totals[0].get("amount")) is int
            and totals[0]["amount"] == expected["totalMinor"], "CHECKOUT_TOTAL")
    actual_items = sorted((item["item"]["id"], item["quantity"], item["item"]["price"])
                          for item in checkout.get("line_items", []))
    expected_items = sorted((item["itemId"], item["quantity"], item["unitPriceMinor"])
                            for item in expected["lineItems"])
    require(actual_items == expected_items, "CHECKOUT_ITEMS")
    require(payment.payee.id == expected["merchantId"] and payment.payment_amount.currency == expected["currency"]
            and payment.payment_amount.amount == expected["totalMinor"], "PAYMENT_TARGET")
    if "instrumentId" in expected or "instrumentType" in expected:
        require(payment.payment_instrument.id == expected["instrumentId"]
                and payment.payment_instrument.type == expected["instrumentType"], "PAYMENT_INSTRUMENT")
    return evidence, expected, merchant_key, psp_key, checkout_payloads, payment_payloads, client, payment


def verify_transaction(data):
    evidence, expected, merchant_key, psp_key, checkout_payloads, payment_payloads, client, payment = verify_authorizations(data)
    receipts = ReceiptClient()
    receipt_payloads = {}
    refs = {}
    for kind, key, issuer in [("checkout", merchant_key, expected["merchantIssuer"]), ("payment", psp_key, expected["pspIssuer"])]:
        reference = digest(client.get_closed_mandate_jwt(evidence[kind + "Mandate"]))
        result = receipts.verify_receipt(evidence[kind + "Receipt"], key,
            has_reference_in_store_cb=lambda ref: ref == reference, is_payment_receipt=kind == "payment")
        require(result.get("verified") is True, "RECEIPT_BINDING")
        payload = verify_jwt(evidence[kind + "Receipt"], key)
        require(payload.get("status") == "Success" and payload.get("iss") == issuer
                and type(payload.get("iat")) is int and 0 <= expected["now"] - payload["iat"] <= 86400
                and payload.get("error") is None and payload.get("error_description") is None, "RECEIPT_OUTCOME")
        receipt_payloads[kind] = payload
        refs[kind] = reference
    require(receipt_payloads["checkout"].get("order_id") == expected["orderId"], "ORDER_BINDING")
    require(all(isinstance(receipt_payloads["payment"].get(k), str) and receipt_payloads["payment"][k]
                for k in ["payment_id", "psp_confirmation_id", "network_confirmation_id"]), "PAYMENT_CONFIRMATION")
    return {"schemaVersion": "a-ap2-transaction-verification-v1", "verified": True,
            "checkoutId": expected["checkoutId"], "orderId": expected["orderId"],
            "currency": expected["currency"], "totalMinor": expected["totalMinor"],
            "mandateReferences": refs, "cryptographicEvidenceVerified": True,
            "evaluatedAtUnix": expected["now"],
            "validUntilUnix": min(p["exp"] for p in checkout_payloads + payment_payloads),
            "fundsSettlementObserved": False, "executionAuthority": False}


def verify_preorder(data):
    _, expected, _, _, checkout_payloads, payment_payloads, _, _ = verify_authorizations(data)
    return {"schemaVersion": "a-ap2-authorization-verification-v1", "verified": True,
            "checkoutId": expected["checkoutId"], "currency": expected["currency"], "totalMinor": expected["totalMinor"],
            "cryptographicEvidenceVerified": True, "evaluatedAtUnix": expected["now"],
            "validUntilUnix": min(p["exp"] for p in checkout_payloads + payment_payloads),
            "fundsSettlementObserved": False, "executionAuthority": False}


def sign_authorizations(data):
    """Broker-only delegated signing. User issuer keys are never generated here.
    UCP full-checkout nesting is deliberately not asserted by this SDK profile.
    """
    from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
    from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate
    from ap2.sdk.generated.checkout_mandate import CheckoutMandate
    from ap2.sdk.generated.payment_mandate import PaymentMandate
    from ap2.sdk.generated.types.merchant import Merchant
    from ap2.sdk.generated.types.amount import Amount
    from ap2.sdk.generated.types.payment_instrument import PaymentInstrument
    from ap2.sdk.generated.types.pisp import PISP

    expected, keys, material = dict(data["expected"]), data["keys"], data["material"]
    # The SDK timestamps the key-binding hop itself. A process-start timestamp
    # can precede that second; validate at the actual signing/verification time.
    requested_now = expected["now"]
    require(type(requested_now) is int and 0 <= int(time.time()) - requested_now <= 10, "SIGNING_CLOCK")
    expected["now"] = int(time.time())
    key_data = material["agentKey"]
    require(key_data.get("kty") == "EC" and key_data.get("crv") == "P-256" and isinstance(key_data.get("d"), str), "SIGNER_KEY")
    agent = JWK(**key_data)
    client = MandateClient()
    roots = []
    for name, model, trust in [("openCheckoutMandate", OpenCheckoutMandate, "checkoutIssuer"),
                               ("openPaymentMandate", OpenPaymentMandate, "paymentIssuer")]:
        token_json(material[name])
        require("~~" not in material[name], "ROOT_SCOPE")
        root = client.verify(material[name], public_key(keys[trust]), payload_type=model,
                             current_time=expected["now"], clock_skew_seconds=0).mandate_payload
        payload = root.model_dump(exclude_none=True)
        time_bound(payload, expected["now"])
        holder = public_key(payload.get("cnf", {}).get("jwk", {}))
        require(holder.thumbprint() == agent.thumbprint(), "SIGNER_NOT_DELEGATE")
        roots.append(payload)
    expires = min(roots[0]["exp"], roots[1]["exp"], expected["now"] + 300)
    checkout_jwt = data["checkoutJwt"]
    token_json(checkout_jwt)
    checkout_hash = digest(checkout_jwt)
    merchant = Merchant(id=expected["merchantId"], name=expected["merchantId"])
    checkout = CheckoutMandate(checkout_jwt=checkout_jwt, checkout_hash=checkout_hash, iat=expected["now"], exp=expires)
    payment = PaymentMandate(transaction_id=checkout_hash, payee=merchant,
        payment_amount=Amount(currency=expected["currency"], amount=expected["totalMinor"]),
        payment_instrument=PaymentInstrument(id=expected["instrumentId"], type=expected["instrumentType"]),
        pisp=PISP(legal_name=expected["pspIssuer"], brand_name=expected["pspIssuer"], domain_name=expected["pspIssuer"]),
        iat=expected["now"], exp=expires)
    evidence = {"checkoutJwt": checkout_jwt,
        "checkoutMandate": client.present(agent, material["openCheckoutMandate"], [checkout],
            aud=expected["checkoutAudience"], nonce=expected["checkoutNonce"]),
        "paymentMandate": client.present(agent, material["openPaymentMandate"], [payment],
            aud=expected["paymentAudience"], nonce=expected["paymentNonce"])}
    # Read back both actual signatures and every root/closed constraint before
    # permitting the broker to use any generated mandate.
    expected["now"] = int(time.time())
    require(requested_now <= expected["now"] <= requested_now + 10, "SIGNING_CLOCK")
    verify_authorizations({"evidence": evidence, "expected": expected, "keys": keys})
    return {"schemaVersion": "a-ap2-delegated-signing-v1", "checkoutId": expected["checkoutId"],
            "verified": True, "checkoutMandate": evidence["checkoutMandate"], "paymentMandate": evidence["paymentMandate"],
            "evaluatedAtUnix": expected["now"], "validUntilUnix": expires,
            "ucpFullNestingVerified": False, "executionAuthority": False}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(1048577)
        require(len(raw) <= 1048576, "INPUT_SIZE")
        data = strict_json(raw.decode("utf-8"))
        output = (sign_authorizations(data) if data.get("mode") == "sign" else
                  verify_preorder(data) if data.get("mode") == "authorizations" else verify_transaction(data))
        print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    except Exception:
        # Untrusted JWTs, personal data and library exception strings never exit
        # this process via the user-facing error or diagnostic stream.
        print('{"verified":false,"error":{"code":"A_AP2_TRANSACTION_EVIDENCE_INVALID"}}')
        sys.exit(2)
