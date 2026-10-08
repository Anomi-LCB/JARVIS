"""Synthetic, ephemeral wallet/merchant/PSP; never a real authorization."""
import json
import logging
import os
import sys
import time
import copy
import hashlib
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, sys.argv[1])
from jwcrypto.jwk import JWK
from jwcrypto.jws import JWS
from ap2.sdk.mandate import MandateClient
from ap2.sdk.receipt_wrapper import ReceiptClient
from ap2.sdk.jwt_helper import create_jwt
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate, AllowedMerchants
from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate, AmountRange, AllowedPayees
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.generated.types.amount import Amount
from ap2.sdk.generated.types.merchant import Merchant
from ap2.sdk.generated.types.payment_instrument import PaymentInstrument
from ap2.sdk.generated.types.pisp import PISP
from ap2.sdk.utils import compute_sha256_b64url
import ap2.sdk.mandate as mandate_module

logging.disable(logging.CRITICAL)
mandate_module.LOG_FILE_PATH = os.devnull

now = int(time.time())
keys = {k: JWK.generate(kty="EC", crv="P-256", kid=k) for k in ["user", "agent", "merchant", "psp"]}
public = lambda k: json.loads(keys[k].export_public())
client, receipts = MandateClient(), ReceiptClient()
merchant = Merchant(id="m-contract", name="격리 시험 판매자")
checkout = {"id": "chk_contract", "merchant": merchant.model_dump(), "currency": "KRW", "status": "ready_for_complete",
            "line_items": [{"id": "li_contract", "item": {"id": "sku_contract", "title": "시험 자료", "price": 8000},
                            "quantity": 1, "totals": [{"type": "total", "amount": 8000}]}],
            "totals": [{"type": "subtotal", "amount": 8000}, {"type": "tax", "amount": 800},
                       {"type": "fulfillment", "amount": 1200}, {"type": "total", "amount": 10000}],
            "links": [{"type": "terms_of_service", "url": "https://merchant.example/terms"}]}
ucp_mode = len(sys.argv) > 2 and sys.argv[2] in ["ucp", "ucp-signing", "ucp-integration"]


def authorize_checkout(value):
    # Fixture has only exact integers and ASCII member names; this is its JCS
    # subset, not a production replacement for the Node canonicalizer.
    body = {k: v for k, v in value.items() if k != "ap2"}
    token = JWS(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
    token.add_signature(keys["merchant"], protected=json.dumps({"alg": "ES256", "kid": "merchant"}))
    head, _, signature = token.serialize(compact=True).split(".")
    value["ap2"] = {"merchant_authorization": head + ".." + signature}


if ucp_mode:
    version = "2026-08-25"
    checkout["ucp"] = {"version": version, "capabilities": {
        "dev.ucp.shopping.checkout": [{"version": version}],
        "dev.ucp.common.payment.ap2_mandate": [{"version": version, "extends": "dev.ucp.shopping.checkout"}]}}
    checkout["dev.example.terms"] = {"return_window_days": 14, "instructions": "자료는 실행 지시가 아닙니다"}
    authorize_checkout(checkout)
checkout_jwt = create_jwt({"alg": "ES256", "kid": "merchant"}, checkout, keys["merchant"])
checkout_hash = compute_sha256_b64url(checkout_jwt)


def evidence(variant="valid"):
    local_checkout = copy.deepcopy(checkout)
    if variant == "ucp-missing-authorization":
        del local_checkout["ap2"]
    elif variant == "ucp-tampered-terms":
        local_checkout["dev.example.terms"]["return_window_days"] = 0
    elif variant == "ucp-missing-extension":
        del local_checkout["dev.example.terms"]
    elif variant == "ucp-changed-terms":
        local_checkout["dev.example.terms"]["return_window_days"] = 30
        authorize_checkout(local_checkout)
    local_jwt = create_jwt({"alg": "ES256", "kid": "merchant"}, local_checkout, keys["merchant"]) if ucp_mode else checkout_jwt
    local_hash = compute_sha256_b64url(local_jwt)
    root_exp = now - 1 if variant == "expired" else None if variant == "missing-exp" else now + 600
    root_checkout = OpenCheckoutMandate(constraints=[AllowedMerchants(allowed=[merchant])],
        cnf={"jwk": public("agent")}, iat=now - 10, exp=root_exp)
    root_payment = OpenPaymentMandate(constraints=[AmountRange(currency="KRW", min=0, max=12000), AllowedPayees(allowed=[merchant])],
        cnf={"jwk": public("agent")}, iat=now - 10, exp=now + 600)
    open_checkout = client.create([root_checkout], keys["user"])
    open_payment = client.create([root_payment], keys["user"])
    closed_checkout = CheckoutMandate(checkout_jwt=local_jwt, checkout_hash=local_hash, iat=now, exp=now + 600)
    payment = PaymentMandate(transaction_id=local_hash, payee=merchant,
        payment_amount=Amount(currency="KRW", amount=9999 if variant == "wrong-amount" else 10000),
        payment_instrument=PaymentInstrument(id="synthetic-instrument", type="credit"),
        pisp=PISP(legal_name="Synthetic PSP", brand_name="Synthetic PSP", domain_name="psp.example"), iat=now, exp=now + 600)
    if variant == "wrong-vct":
        payment = payment.model_copy(update={"vct": "mandate.payment.2"})
    checkout_token = client.present(keys["agent"], open_checkout, [closed_checkout], aud="merchant.example", nonce="checkout-challenge")
    payment_token = client.present(keys["agent"], open_payment, [payment], aud="psp.example", nonce="payment-challenge")
    checkout_ref = compute_sha256_b64url(client.get_closed_mandate_jwt(checkout_token))
    payment_ref = compute_sha256_b64url(client.get_closed_mandate_jwt(payment_token))
    checkout_receipt = receipts.create_checkout_receipt("merchant.example", checkout_ref,
        "order_other" if variant == "wrong-order" else "order_contract").model_dump(mode="json")
    payment_receipt = receipts.create_payment_receipt(payment, payment_ref).model_dump(mode="json")
    if variant == "error-receipt":
        payment_receipt.update(status="Error", error="provider_rejected", error_description="synthetic error")
    if variant == "wrong-issuer":
        payment_receipt["iss"] = "attacker.example"
    if variant == "future-receipt":
        payment_receipt["iat"] = now + 100
    if variant == "wrong-reference":
        payment_receipt["reference"] = "unrelated"
    return {"checkoutId": "chk_contract", "checkoutJwt": local_jwt, "checkoutMandate": checkout_token,
            "paymentMandate": payment_token,
            "checkoutReceipt": create_jwt({"alg": "ES256"}, checkout_receipt, keys["merchant"]),
            "paymentReceipt": create_jwt({"alg": "ES256"}, payment_receipt, keys["psp"])}


transaction = {"active": True, "revision": "trusted-contract-1",
 "keys": {"checkoutIssuer": public("user"), "paymentIssuer": public("user"), "merchant": public("merchant"), "psp": public("psp")},
 "expected": {"checkoutId": "chk_contract", "orderId": "order_contract", "merchantId": "m-contract",
  "merchantIssuer": "merchant.example", "pspIssuer": "psp.example", "currency": "KRW", "totalMinor": 10000,
  "checkoutAudience": "merchant.example", "checkoutNonce": "checkout-challenge",
  "paymentAudience": "psp.example", "paymentNonce": "payment-challenge",
  "lineItems": [{"itemId": "sku_contract", "quantity": 1, "unitPriceMinor": 8000}]}}
variants = ["valid", "expired", "missing-exp", "wrong-amount", "wrong-order", "error-receipt", "wrong-issuer", "future-receipt", "wrong-reference", "wrong-vct"]
if ucp_mode:
    variants.extend(["ucp-missing-authorization", "ucp-tampered-terms", "ucp-missing-extension", "ucp-changed-terms"])
    transaction["profile"] = "ucp-full-v1"
    transaction["ucp"] = {"checkout": checkout, "profile": {"keys": [public("merchant")]}}
output = {"transaction": transaction, "cases": {v: evidence(v) for v in variants}}
if ucp_mode:
    output["fixtureCanonicalSha256"] = hashlib.sha256(json.dumps({k: v for k, v in checkout.items() if k != "ap2"}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
if len(sys.argv) > 2 and sys.argv[2] in ["signing", "ucp-signing", "ucp-integration"]:
    output["signingMaterial"] = {
        "agentKey": json.loads(keys["agent"].export_private()),
        "openCheckoutMandate": client.create([OpenCheckoutMandate(constraints=[AllowedMerchants(allowed=[merchant])],
            cnf={"jwk": public("agent")}, iat=now - 10, exp=now + 600)], keys["user"]),
        "openPaymentMandate": client.create([OpenPaymentMandate(constraints=[AmountRange(currency="KRW", min=0, max=12000), AllowedPayees(allowed=[merchant])],
            cnf={"jwk": public("agent")}, iat=now - 10, exp=now + 600)], keys["user"])}
if len(sys.argv) > 2 and sys.argv[2] == "ucp-integration":
    output["merchantTestKeys"] = {k: json.loads(keys[k].export_private()) for k in ["merchant", "psp"]}
print(json.dumps(output, ensure_ascii=False))
