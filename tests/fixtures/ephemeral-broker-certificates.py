"""Ephemeral test-only PKI, created in the caller-owned temporary directory.
Not an operational issuer; no certificate-store registration or network access.
"""
from pathlib import Path
import sys
from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
import ipaddress

root = Path(sys.argv[1])
now = datetime.now(timezone.utc)
issuer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
issuer_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'ephemeral-evaluation-issuer')])
issuer = (x509.CertificateBuilder().subject_name(issuer_name).issuer_name(issuer_name)
    .public_key(issuer_key.public_key()).serial_number(x509.random_serial_number())
    .not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(hours=1))
    .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
    .sign(issuer_key,hashes.SHA256()))
(root/'TLS_CA').write_bytes(issuer.public_bytes(serialization.Encoding.PEM))
for label, purpose in [('server',ExtendedKeyUsageOID.SERVER_AUTH),('client',ExtendedKeyUsageOID.CLIENT_AUTH)]:
    key = rsa.generate_private_key(public_exponent=65537,key_size=2048)
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'ephemeral-evaluation-'+label)]))
        .issuer_name(issuer_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(minutes=30))
        .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
        .add_extension(x509.ExtendedKeyUsage([purpose]),critical=False)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False)
        .sign(issuer_key,hashes.SHA256()))
    (root/('TLS_CERT' if label=='server' else 'CLIENT_CERT')).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (root/('TLS_KEY' if label=='server' else 'CLIENT_KEY')).write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
