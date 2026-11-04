"""Static checks only: no container runtime, n8n or Grafana account access."""
import importlib.util
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
CLOUD = ROOT / "deploy" / "cloud"
METRICS = {"onsori_jobs_total", "onsori_jobs_active", "onsori_job_duration_seconds", "onsori_provider_audio_seconds_total", "onsori_storage_bytes"}


def test_compose_exposure_and_resource_bounds():
    cfg = yaml.safe_load((CLOUD / "compose.yaml").read_text(encoding="utf-8"))
    services = cfg["services"]
    assert set(services) == {"gateway", "prometheus"}
    assert sum(int(s["mem_limit"][:-1]) for s in services.values()) < 2048
    for service in services.values():
        assert all(p.startswith("127.0.0.1:") for p in service["ports"])
        assert service["read_only"] is True
        assert service["restart"] == "unless-stopped"
        assert "ALL" in service["cap_drop"]
        assert service["logging"]["options"]["max-file"] == "2"
    command = services["prometheus"]["command"]
    assert "--storage.tsdb.retention.time=7d" in command
    assert "--storage.tsdb.retention.size=512MB" in command
    dockerfile = (CLOUD / "Dockerfile").read_text(encoding="utf-8")
    assert "USER 10001:10001" in dockerfile
    assert '"--workers", "1"' in dockerfile
    assert "cloud_gateway/requirements.txt" in dockerfile


def test_prometheus_auth_and_proxy_boundary():
    cfg = yaml.safe_load((CLOUD / "prometheus.yml").read_text(encoding="utf-8"))
    scrape = cfg["scrape_configs"][0]
    assert scrape["authorization"] == {"type": "Bearer", "credentials_file": "/run/secrets/metrics_token"}
    assert scrape["static_configs"][0]["targets"] == ["gateway:8000"]
    proxy = (CLOUD / "nginx-https.conf.example").read_text(encoding="utf-8")
    assert "location = /metrics { return 404; }" in proxy
    assert "location ^~ /metrics/ { return 404; }" in proxy
    assert "deny all;" in proxy
    assert "9090" not in proxy.split("limit_req_zone", 1)[1]


def test_pilot_nginx_public_paths():
    main = (CLOUD / "nginx" / "nginx.conf").read_text(encoding="utf-8")
    assert "ssl_reject_handshake on;" in main and "return 444;" in main
    assert "$args" not in main and "$request_uri" not in main and "$http_" not in main
    site = (CLOUD / "nginx" / "onsori-pilot.conf").read_text(encoding="utf-8")
    assert "location = /metrics { return 404; }" in site
    v1 = site.split("location ^~ /v1/ {", 1)[1].split("}", 1)[0]
    assert "allow 180.210.76.21;" in v1 and "deny all;" in v1
    assert "limit_except GET { deny all; }" in site.split("location ^~ /v1/ {", 1)[1]
    prom = site.split("location ^~ /prometheus/ {", 1)[1]
    assert prom.index("include /etc/nginx/onsori-grafana-allow.conf;") < prom.index("deny all;")
    assert "auth_basic_user_file /etc/nginx/onsori-prometheus.htpasswd;" in prom
    assert "admin" not in prom and "remote_write" not in prom
    assert "proxy_pass http://127.0.0.1:9090;" in prom
    assert site.rstrip().endswith("location / { return 404; }\n}")


def test_preflight_rejects_placeholders_and_cost_misconfiguration():
    spec = importlib.util.spec_from_file_location("cloud_preflight", CLOUD / "preflight.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.check({"ONSORI_API_TOKEN": "CHANGE_ME", "ONSORI_METRICS_TOKEN": "CHANGE_ME"}, "CHANGE_ME")
    good = {"ONSORI_API_TOKEN": "a" * 40, "ONSORI_METRICS_TOKEN": "b" * 40, "ONSORI_PROVIDER": "disabled", "ONSORI_ALLOW_PAID": "false"}
    assert not mod.check(good, "b" * 40)
    assert mod.check(good, "c" * 40)
    assert mod.check({**good, "ONSORI_PROVIDER": "deepinfra"}, "b" * 40)
    assert mod.check({**good, "ONSORI_API_TOKEN": "b" * 40}, "b" * 40)


def test_n8n_manual_readonly_workflows_and_connections():
    files = list((ROOT / "integrations" / "n8n").glob("*.json"))
    assert len(files) == 2
    allowed = {"n8n-nodes-base.manualTrigger", "n8n-nodes-base.set", "n8n-nodes-base.if", "n8n-nodes-base.httpRequest"}
    for path in files:
        raw = path.read_text(encoding="utf-8")
        workflow = json.loads(raw)
        assert workflow["active"] is False
        names = {n["name"] for n in workflow["nodes"]}
        assert len(names) == len(workflow["nodes"])
        assert all(n["type"] in allowed for n in workflow["nodes"])
        assert sum(n["type"].endswith("manualTrigger") for n in workflow["nodes"]) == 1
        assert "$env" not in raw and "eval(" not in raw and "Authorization" not in raw
        assert "CHANGE-ME.invalid" in raw
        for node in workflow["nodes"]:
            assert not node.get("credentials")
            if node["type"].endswith("httpRequest"):
                assert node["parameters"].get("method", "GET") == "GET"
                assert node["retryOnFail"] is False
                assert node["parameters"]["options"]["timeout"] == 10000
                assert node["parameters"]["options"].get("allowUnauthorizedCerts") is not True
                if node["name"] != "Health":
                    assert node["parameters"]["genericAuthType"] == "httpHeaderAuth"
        for origin, groups in workflow["connections"].items():
            assert origin in names
            for branch in groups["main"]:
                assert all(edge["node"] in names for edge in branch)
        guard = next(n for n in workflow["nodes"] if n["name"] == "Validate configuration")
        assert guard["parameters"]["conditions"]["combinator"] == "and"
        assert any(c["rightValue"].startswith("^https://") for c in guard["parameters"]["conditions"]["conditions"])
        assert workflow["settings"]["saveManualExecutions"] is False


def test_grafana_import_datasource_and_real_metric_contract():
    dashboard = json.loads((ROOT / "integrations" / "grafana" / "onsori-operations.json").read_text(encoding="utf-8"))
    assert dashboard["__inputs"][0]["name"] == "DS_PROMETHEUS"
    all_expr = " ".join(t["expr"] for p in dashboard["panels"] for t in p["targets"])
    assert all(metric in all_expr for metric in METRICS)
    assert "onsori_job_duration_seconds_bucket" in all_expr
    assert "onsori_cpu" not in all_expr and "accuracy" not in all_expr
    assert all(p["datasource"]["uid"] == "${DS_PROMETHEUS}" for p in dashboard["panels"])
    assert not dashboard.get("alert")


def test_no_live_secrets_shipped():
    assert not (CLOUD / ".env").exists()
    assert not (CLOUD / "secrets").exists()
    example = (CLOUD / ".env.example").read_text(encoding="utf-8")
    assert "ONSORI_PROVIDER=disabled" in example
    assert "ONSORI_ALLOW_PAID=false" in example
    assert "DEEPINFRA_API_KEY=\n" in example
    for base in (CLOUD, ROOT / "integrations" / "n8n", ROOT / "integrations" / "grafana"):
        for path in base.rglob("*"):
            if path.is_file() and path.suffix not in {".pyc"}:
                data = path.read_text(encoding="utf-8")
                assert "sk-proj-" not in data
                assert "BEGIN PRIVATE KEY" not in data
