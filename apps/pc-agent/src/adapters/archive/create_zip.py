import base64
import json
import hashlib
import os
import sys
import zipfile


def main():
    payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    output_path = payload["outputPath"]
    inputs = payload["inputs"]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with zipfile.ZipFile(output_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in inputs:
            digest = hashlib.sha256()
            with open(item["path"], "rb") as source, archive.open(item["archiveName"], "w") as target:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
                    target.write(chunk)
            if digest.hexdigest() != item["sha256"]:
                raise ValueError("archive-input-integrity-mismatch")
    with zipfile.ZipFile(output_path, "r") as archive:
        bad = archive.testzip()
        entries = []
        for info in archive.infolist():
            digest = hashlib.sha256()
            with archive.open(info) as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            entries.append({"name": info.filename, "size": info.file_size,
                            "compressedSize": info.compress_size, "sha256": digest.hexdigest()})
    print(json.dumps({"status": "success" if bad is None else "failed", "badEntry": bad, "entries": entries}, ensure_ascii=False))


if __name__ == "__main__":
    main()
