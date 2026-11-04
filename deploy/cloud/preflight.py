"""Offline configuration checks. Never deploys, installs, calls APIs, or prints secrets."""
from pathlib import Path
import argparse
import os
import secrets
import shutil
import sys

ROOT = Path(__file__).resolve().parent

def read_env(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            key, sep, value = line.partition("=")
            if not sep or not key.replace("_", "").isalnum():
                raise ValueError("Invalid env file format")
            values[key] = value
    return values

def check(values, metrics):
    errors = []
    tokens = [values.get(k, "") for k in ("ONSORI_API_TOKEN", "ONSORI_METRICS_TOKEN")]
    # Rocky Linux 8 ships Python 3.6, which has no str.isascii().
    if any(len(t) < 32 or "CHANGE_ME" in t or any(ord(c) > 127 or c.isspace() for c in t) for t in tokens):
        errors.append("Two non-placeholder tokens of at least 32 characters are required")
    if tokens[0] == tokens[1]:
        errors.append("API and metrics tokens must differ")
    if metrics != tokens[1]:
        errors.append("Prometheus token file must match ONSORI_METRICS_TOKEN")
    provider = values.get("ONSORI_PROVIDER", "disabled")
    if provider not in {"disabled", "mock", "deepinfra"}:
        errors.append("Unsupported provider")
    paid = values.get("ONSORI_ALLOW_PAID", "false")
    if paid not in {"true", "false"}:
        errors.append("ONSORI_ALLOW_PAID must be true or false")
    if provider == "deepinfra" and (paid != "true" or not values.get("DEEPINFRA_API_KEY")):
        errors.append("DeepInfra requires explicit paid enablement and an operator-provided API key")
    return errors

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--init", action="store_true", help="Create missing disabled-provider secrets locally; never overwrite")
    args = parser.parse_args()
    envpath, secretpath = ROOT / ".env", ROOT / "secrets" / "metrics_token"
    if args.init:
        if envpath.exists() or secretpath.exists():
            print("Refusing initialization: configuration already exists; inspect and rotate manually", file=sys.stderr)
            return 2
        admin, metrics = secrets.token_urlsafe(36), secrets.token_urlsafe(36)
        secretpath.parent.mkdir(mode=0o700, exist_ok=True)
        envpath.write_text("ONSORI_API_TOKEN=" + admin + "\nONSORI_METRICS_TOKEN=" + metrics + "\nONSORI_PROVIDER=disabled\nONSORI_ALLOW_PAID=false\nDEEPINFRA_API_KEY=\nONSORI_DATA_DIR=/data\nONSORI_MAX_QUEUE=4\nONSORI_DAILY_AUDIO_MINUTES=60\nONSORI_RESULT_TTL_SECONDS=86400\nONSORI_SWEEP_INTERVAL_SECONDS=60\nONSORI_PROVIDER_TIMEOUT_SECONDS=180\n", encoding="utf-8")
        secretpath.write_text(metrics + "\n", encoding="utf-8")
        os.chmod(envpath, 0o600)
        # Prometheus image uses an unprivileged UID; containing directory is 0700 on host.
        os.chmod(secretpath, 0o444)
        print("Created local configuration; no deployment or network action performed")
    if not envpath.is_file() or not secretpath.is_file():
        print("Missing .env or secrets/metrics_token; run --init on the approved host", file=sys.stderr)
        return 2
    try:
        errors = check(read_env(envpath), secretpath.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        print("Cannot parse local configuration", file=sys.stderr)
        return 2
    for error in errors:
        print(error, file=sys.stderr)
    print("Docker executable: " + ("found; runtime not tested" if shutil.which("docker") else "missing"))
    print("Configured container memory caps: 1280 MiB; host/proxy/build/cache require additional capacity")
    print("Configuration: " + ("FAIL" if errors else "PASS; does not authorize deployment or paid provider"))
    return 1 if errors else 0

if __name__ == "__main__":
    raise SystemExit(main())
