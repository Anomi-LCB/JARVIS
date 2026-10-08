"""Observe SDK diagnostics without emitting keys, token bytes or claims."""
import contextlib
import io
import json
import logging
import os
import pathlib
import runpy
import sys
import tempfile

sys.path.insert(0, sys.argv[1])
import ap2.sdk.mandate as mandate_module
from ap2.sdk.mandate import MandateClient
from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from jwcrypto.jwk import JWK

logging.disable(logging.CRITICAL)
with tempfile.TemporaryDirectory(prefix="jarvis-ap2-log-") as root:
    path = pathlib.Path(root) / "diagnostic.log"
    mandate_module.LOG_FILE_PATH = str(path)
    # Public diagnostic API behavior, not a real user consent.
    user = JWK.generate(kty="EC", crv="P-256")
    agent = JWK.generate(kty="EC", crv="P-256")
    client = MandateClient()
    opened = client.create([OpenCheckoutMandate(constraints=[], cnf={"jwk": json.loads(agent.export_public())}, iat=1, exp=4102444800)], user)
    closed = CheckoutMandate(checkout_jwt="synthetic.checkout.signature", checkout_hash="synthetic", iat=1, exp=4102444800)
    token = client.present(agent, opened, [closed], aud="synthetic.example", nonce="synthetic")
    raw = path.read_text()
    leaf = token.split("~~")[-1]
    before = {"loggingDisabled": True, "diagnosticFileCreated": path.exists(), "presentationRecorded": leaf in raw}
    size = path.stat().st_size
    # Exercise the actual production verifier import, which must configure the
    # pinned SDK independently of Python's normal logging switch.
    runpy.run_path(sys.argv[2], run_name="privacy_probe_import")
    client.present(agent, opened, [closed], aud="synthetic.example", nonce="synthetic-after")
    after = {"sinkIsOsNull": mandate_module.LOG_FILE_PATH == os.devnull,
             "diagnosticUnchanged": path.stat().st_size == size}
    # Every invocation of the shared test fixture must also suppress SDK writes.
    mandate_module.LOG_FILE_PATH = str(path)
    with contextlib.redirect_stdout(io.StringIO()):
        old = sys.argv
        sys.argv = [sys.argv[3], old[1]]
        try:
            runpy.run_path(old[3], run_name="fixture_probe")
        finally:
            sys.argv = old
    after["fixtureDiagnosticUnchanged"] = path.stat().st_size == size
    print(json.dumps({"before": before, "after": after}))
