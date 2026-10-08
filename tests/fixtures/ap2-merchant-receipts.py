"""Ephemeral test merchant/PSP; private keys enter only child stdin, never files."""
import json
import runpy
import sys
import time
sys.stdout.reconfigure(encoding="utf-8")
functions = runpy.run_path(sys.argv[2], run_name="synthetic_merchant_import")
data = json.loads(sys.stdin.buffer.read(1048576))
data["expected"]["now"] = int(time.time())
parts = functions["verify_authorizations"](data)
client, payment = parts[-2:]
from jwcrypto.jwk import JWK
from ap2.sdk.receipt_wrapper import ReceiptClient
from ap2.sdk.jwt_helper import create_jwt
from ap2.sdk.utils import compute_sha256_b64url
receipts = ReceiptClient()
checkout_ref = compute_sha256_b64url(client.get_closed_mandate_jwt(data["evidence"]["checkoutMandate"]))
payment_ref = compute_sha256_b64url(client.get_closed_mandate_jwt(data["evidence"]["paymentMandate"]))
checkout = receipts.create_checkout_receipt(data["expected"]["merchantIssuer"], checkout_ref, data["expected"]["orderId"]).model_dump(mode="json")
payment_receipt = receipts.create_payment_receipt(payment, payment_ref).model_dump(mode="json")
if data.get("outcome") == "error":
    payment_receipt.update(status="Error", error="synthetic_decline", error_description="test only")
print(json.dumps({"checkoutReceipt": create_jwt({"alg": "ES256"}, checkout, JWK(**data["testKeys"]["merchant"])),
                 "paymentReceipt": create_jwt({"alg": "ES256"}, payment_receipt, JWK(**data["testKeys"]["psp"]))}))
