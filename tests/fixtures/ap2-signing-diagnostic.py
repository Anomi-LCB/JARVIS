"""Synthetic diagnostic: frames/types only, never keys, claims or tokens."""
import contextlib
import io
import json
import pathlib
import runpy
import sys
import time
import traceback

sdk, fixture_path, verifier_path = sys.argv[1:]
sys.argv = [fixture_path, sdk, "signing"]
capture = io.StringIO()
with contextlib.redirect_stdout(capture):
    runpy.run_path(fixture_path, run_name="synthetic_fixture")
fixture = json.loads(capture.getvalue())
sys.argv = [verifier_path, sdk]
verifier = runpy.run_path(verifier_path, run_name="synthetic_signer")
expected = fixture["transaction"]["expected"]
expected.update(now=int(time.time()), instrumentId="synthetic-instrument", instrumentType="credit")
try:
    output = verifier["sign_authorizations"]({"expected": expected, "keys": fixture["transaction"]["keys"],
        "checkoutJwt": fixture["cases"]["valid"]["checkoutJwt"], "material": fixture["signingMaterial"]})
    print(json.dumps({"verified": output["verified"]}))
except Exception as error:
    print(json.dumps({"exceptionType": type(error).__name__, "frames": [
        {"file": pathlib.Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
        for frame in traceback.extract_tb(error.__traceback__)]}))
