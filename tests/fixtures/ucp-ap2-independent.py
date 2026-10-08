"""Test-only independent nested-binding oracle, never an authority provider.
Uses an unmodified MIT community implementation at a recorded commit.
Frozen checks cover disclosure/hash structure, not user issuer trust or expiry.
"""
import json
import pathlib
import sys
root = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "conformance" / "testbed"))
sys.path.insert(0, str(root / "conformance" / "common"))
import crypto
import frozen
import nested

fixture = json.loads(sys.stdin.buffer.read(1048576))
merchant = crypto.pub_from_jwk(fixture["transaction"]["keys"]["merchant"])
results = {}
for name in ["valid", "ucp-missing-authorization", "ucp-tampered-terms", "ucp-missing-extension", "ucp-changed-terms"]:
    wire = fixture["cases"][name]["checkoutMandate"]
    results[name] = {"frozen": frozen.frozen_verify(wire)[0],
                     "nested": nested.verify_ucp_nested(wire, merchant)[0]}
_, golden_merchant = crypto.keypair(b"ap2-merchant-fixture")
goldens = {}
for name in ["valid", "missing_mauth", "tampered_terms", "hash_mismatch"]:
    path = root / "conformance/selfcheck/fixtures/ap2/golden/nested" / ("nested_ucp." + name + ".json")
    wire = json.loads(path.read_text(encoding="utf-8"))["wire"]
    goldens[name] = {"frozen": frozen.frozen_verify(wire)[0],
                     "nested": nested.verify_ucp_nested(wire, golden_merchant)[0]}
print(json.dumps({"fixtureResults": results, "communityGoldenResults": goldens,
                  "officialConformance": False, "userTrustVerified": False}))
