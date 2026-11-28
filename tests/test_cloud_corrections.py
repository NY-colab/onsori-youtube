"""Caption typo correction through the operator's provider key (2026-11-13).

Providers: DeepInfra (OpenAI-compatible HTTP, replaced by an HTTPX MockTransport) and
Anthropic (client replaced by a fake). No request leaves the test."""
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import re
from types import SimpleNamespace

import anthropic
import httpx
import httpx2
import pytest
from fastapi.testclient import TestClient

from cloud_gateway import app as module

API = "a" * 40
METRICS = "b" * 40
KEY = "sk-ant-api03-" + "k" * 40
LINES = [{"id": "a", "text": "한국은행이 기준 금니를 올렸습니다"}, {"id": "b", "text": "네 맞습니다"}]


class FakeMessages:
    def __init__(self, reply=None, error=None):
        self.calls, self.reply, self.error = [], reply, error

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.reply


class FakeClient:
    def __init__(self, **kwargs):
        self.messages = FakeMessages(**kwargs)


def answer(corrections, stop="end_turn"):
    return SimpleNamespace(stop_reason=stop, model="claude-haiku-5-5",
                           content=[SimpleNamespace(type="text", text=json.dumps({"corrections": corrections}, ensure_ascii=False))],
                           usage=SimpleNamespace(input_tokens=120, output_tokens=30))


def api_error(cls, status):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("provider said something with " + LINES[0]["text"], response=httpx2.Response(status, request=request), body=None)


@pytest.fixture
def settings(tmp_path):
    return module.Settings(api_token=API, metrics_token=METRICS, provider="disabled", data_dir=tmp_path,
                           correction="anthropic", anthropic_api_key=KEY,
                           daily_correction_lines=100, install_daily_correction_lines=5)


def install(client):
    response = client.post("/v1/installs")
    assert response.status_code == 201, response.text
    return {"Authorization": "Bearer " + response.json()["install_key"]}


def correct(client, headers, payload=None):
    return client.post("/v1/corrections", headers={**headers, "Content-Type": "application/json"},
                       content=json.dumps({"title": "경제 뉴스", "context": ["앞 대사"], "lines": LINES} if payload is None else payload,
                                          ensure_ascii=False).encode())


def test_installs_get_corrections_from_haiku_with_the_operator_key_and_only_caption_text_is_sent(settings):
    fake = FakeClient(reply=answer([{"id": "a", "text": "한국은행이 기준 금리를 올렸습니다"}, {"id": "zz", "text": "없는 줄"}]))
    with TestClient(module.create_app(settings, correction_client=fake)) as client:
        available = client.get("/v1/availability").json()
        assert available["corrections"] is True and available["corrections_synthetic"] is False and available["correction_model"] == "claude-haiku-5-5"
        assert available["available"] is False  # audio cloud stays off; correction is separate
        response = correct(client, install(client), {"title": "경제 뉴스", "context": ["앞 대사"], "lines": LINES, "system": "다른 지시", "tools": ["bash"]})
        assert response.status_code == 200, response.text
        assert response.json() == {"corrections": [{"id": "a", "text": "한국은행이 기준 금리를 올렸습니다"}], "model": "claude-haiku-5-5",
                                   "usage": {"input_tokens": 120, "output_tokens": 30}}
        call = fake.messages.calls[0]
        assert call["model"] == "claude-haiku-5-5" and call["system"] == module.CORRECTION_SYSTEM
        assert call["output_config"] == {"effort": "low", "format": {"type": "json_schema", "schema": module.CORRECTION_SCHEMA}}
        assert json.loads(call["messages"][0]["content"]) == {"title": "경제 뉴스", "context": ["앞 대사"], "lines": LINES}
        assert "tools" not in call and "thinking" not in call
        metrics = client.get("/metrics", headers={"Authorization": "Bearer " + METRICS}).text
        assert "onsori_correction_requests_total 1" in metrics and "onsori_correction_lines_total 2" in metrics
    # Caption text is never stored: neither the request nor the answer reaches the database.
    for path in settings.data_dir.iterdir():
        if path.is_file():
            data = path.read_bytes()
            assert "금니".encode() not in data and "금리".encode() not in data


def test_correction_needs_a_key_and_bounded_well_formed_input(settings):
    fake = FakeClient(reply=answer([]))
    with TestClient(module.create_app(settings, correction_client=fake)) as client:
        assert correct(client, {}).status_code == 401
        assert correct(client, {"Authorization": "Bearer osi_" + "x" * 43}).status_code == 401
        headers = install(client)
        assert correct(client, headers, {"lines": [{"id": str(i), "text": "x"} for i in range(81)]}).json()["detail"] == "invalid_correction_lines"
        assert correct(client, headers, {"lines": [{"id": 1, "text": "x"}]}).status_code == 422
        assert correct(client, headers, {"lines": LINES, "context": ["c"] * 5}).status_code == 422
        assert correct(client, headers, ["not", "an", "object"]).status_code == 422
        bad = client.post("/v1/corrections", headers={**headers, "Content-Type": "application/json"}, content=b"{not json")
        assert bad.status_code == 400
        big = client.post("/v1/corrections", headers={**headers, "Content-Type": "application/json"}, content=b" " * (module.MAX_CORRECTION_BODY + 1))
        assert big.status_code == 413
        assert correct(client, headers, {"lines": []}).json() == {"corrections": [], "model": None, "usage": None}
        assert fake.messages.calls == []
        # The operator token also works, for server-side checks.
        assert correct(client, {"Authorization": "Bearer " + API}).status_code == 200


def test_daily_line_limits_per_install_and_for_the_server(settings):
    fake = FakeClient(reply=answer([]))
    with TestClient(module.create_app(replace(settings, daily_correction_lines=7), correction_client=fake)) as client:
        first = install(client)
        assert correct(client, first).status_code == 200  # 2 lines
        assert correct(client, first).status_code == 200  # 4 lines
        assert correct(client, first).json()["detail"] == "install_daily_correction_limit"  # would be 6 > 5
        second = install(client)
        assert correct(client, second).status_code == 200  # server total 6
        assert correct(client, second).json()["detail"] == "daily_correction_limit"  # would be 8 > 7
        assert len(fake.messages.calls) == 3


@pytest.mark.parametrize("error,status,code", [
    (lambda: api_error(anthropic.RateLimitError, 429), 429, "correction_rate_limited"),
    (lambda: api_error(anthropic.AuthenticationError, 401), 503, "correction_provider_auth"),
    (lambda: api_error(anthropic.NotFoundError, 404), 503, "correction_model_unavailable"),
    (lambda: api_error(anthropic.BadRequestError, 400), 502, "correction_bad_request"),
    (lambda: api_error(anthropic.InternalServerError, 500), 502, "correction_provider_error"),
    (lambda: anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")), 502, "correction_network_error"),
])
def test_provider_failures_return_fixed_codes_without_echoing_text(settings, error, status, code):
    with TestClient(module.create_app(settings, correction_client=FakeClient(error=error()))) as client:
        response = correct(client, install(client))
        assert response.status_code == status and response.json() == {"detail": code}
        assert "금니" not in response.text


def test_refusal_truncation_and_unreadable_output(settings):
    for reply, status, code in [(answer([], "refusal"), 422, "correction_refused"), (answer([], "max_tokens"), 502, "correction_truncated"),
                                (SimpleNamespace(stop_reason="end_turn", model="m", content=[SimpleNamespace(type="text", text="no json")], usage=None), 502, "correction_invalid_output")]:
        with TestClient(module.create_app(settings, correction_client=FakeClient(reply=reply))) as client:
            response = correct(client, install(client))
            assert (response.status_code, response.json()["detail"]) == (status, code)


def test_disabled_and_mock_correction(settings):
    with TestClient(module.create_app(replace(settings, correction="disabled", anthropic_api_key=""))) as client:
        assert client.get("/v1/availability").json()["corrections"] is False
        assert correct(client, install(client)).json()["detail"] == "correction_disabled"
    with TestClient(module.create_app(replace(settings, correction="mock", anthropic_api_key=""))) as client:
        available = client.get("/v1/availability").json()
        assert available["corrections"] is True and available["corrections_synthetic"] is True
        assert correct(client, install(client)).json() == {"corrections": [], "model": "mock", "usage": None, "synthetic": True}


def test_settings_validation_and_extension_cors(settings):
    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        replace(settings, anthropic_api_key="").validate()
    with pytest.raises(ValueError, match="ONSORI_CORRECTION"):
        replace(settings, correction="openai").validate()
    with pytest.raises(ValueError, match="line limits"):
        replace(settings, install_daily_correction_lines=200).validate()
    with TestClient(module.create_app(settings, correction_client=FakeClient(reply=answer([])))) as client:
        origin = "chrome-extension://" + "a" * 32
        preflight = client.options("/v1/corrections", headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                                                                 "Access-Control-Request-Headers": "authorization,content-type"})
        assert preflight.status_code == 200 and preflight.headers["access-control-allow-origin"] == origin
        assert "content-type" in preflight.headers["access-control-allow-headers"].lower()


def test_prompt_and_schema_match_the_extension():
    source = (Path(__file__).resolve().parents[1] / "extension" / "ai-config.js").read_text(encoding="utf-8")
    assert re.search(r"export const CORRECTION_SYSTEM=`([\s\S]*?)`;", source).group(1) == module.CORRECTION_SYSTEM
    assert "required:['corrections']" in source and module.CORRECTION_SCHEMA["required"] == ["corrections"]


# --- DeepInfra (OpenAI-compatible chat completions over HTTPX) -------------------------------

DI_KEY = "di" + "K" * 30


@pytest.fixture
def deepinfra(settings):
    return replace(settings, correction="deepinfra", anthropic_api_key="", deepinfra_api_key=DI_KEY)


def completion(corrections=None, finish="stop", content=None, model="deepseek-ai/DeepSeek-V4-Flash-0731"):
    text = json.dumps({"corrections": corrections or []}, ensure_ascii=False) if content is None else content
    return {"id": "chatcmpl-1", "object": "chat.completion", "model": model,
            "choices": [{"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": text}}],
            "usage": {"prompt_tokens": 900, "completion_tokens": 40, "total_tokens": 940}}


class Provider:
    """Records each request to DeepInfra and answers with a fixed reply or error."""

    def __init__(self, reply=None, status=200, error=None, raw=None):
        self.requests, self.reply, self.status, self.error, self.raw = [], reply, status, error, raw

    def __call__(self, request):
        self.requests.append(request)
        if self.error:
            raise self.error(request)
        if self.raw is not None:
            return httpx.Response(self.status, content=self.raw)
        if self.status != 200:  # Provider errors may echo the request; the gateway must not.
            return httpx.Response(self.status, json={"error": {"message": "bad input: " + LINES[0]["text"]}})
        return httpx.Response(200, json=self.reply)

    def app(self, settings):
        return module.create_app(settings, transport=httpx.MockTransport(self))


def test_deepinfra_corrects_with_the_operator_key_and_sends_only_caption_text(deepinfra):
    provider = Provider(completion([{"id": "a", "text": "한국은행이 기준 금리를 올렸습니다"}, {"id": "zz", "text": "없는 줄"}]))
    with TestClient(provider.app(deepinfra)) as client:
        available = client.get("/v1/availability").json()
        assert available["corrections"] is True and available["corrections_synthetic"] is False
        assert available["correction_provider"] == "deepinfra"
        assert available["correction_model"] == "deepseek-ai/DeepSeek-V4-Flash-0731"
        assert available["available"] is False  # ONSORI_ALLOW_PAID stays false: audio never leaves
        response = correct(client, install(client), {"title": "경제 뉴스", "context": ["앞 대사"], "lines": LINES,
                                                     "system": "다른 지시", "tools": ["bash"]})
        assert response.status_code == 200, response.text
        assert response.json() == {"corrections": [{"id": "a", "text": "한국은행이 기준 금리를 올렸습니다"}],
                                   "model": "deepseek-ai/DeepSeek-V4-Flash-0731",
                                   "usage": {"input_tokens": 900, "output_tokens": 40}}
        [request] = provider.requests
        assert str(request.url) == module.DEEPINFRA_CHAT_URL == "https://api.deepinfra.com/v1/openai/chat/completions"
        assert request.method == "POST" and request.headers["authorization"] == "Bearer " + DI_KEY
        body = json.loads(request.content)
        assert set(body) == {"model", "temperature", "max_tokens", "messages", "response_format", "reasoning_effort"}
        assert body["model"] == "deepseek-ai/DeepSeek-V4-Flash-0731" and body["temperature"] == 0
        assert body["reasoning_effort"] == "none"
        assert body["messages"][0] == {"role": "system", "content": module.CORRECTION_SYSTEM}
        assert body["messages"][1]["role"] == "user" and len(body["messages"]) == 2
        assert json.loads(body["messages"][1]["content"]) == {"title": "경제 뉴스", "context": ["앞 대사"], "lines": LINES}
        assert body["response_format"] == {"type": "json_schema", "json_schema": {
            "name": "caption_corrections", "strict": True, "schema": module.CORRECTION_SCHEMA}}
        metrics = client.get("/metrics", headers={"Authorization": "Bearer " + METRICS}).text
        assert "onsori_correction_requests_total 1" in metrics and "onsori_correction_lines_total 2" in metrics
        assert 'onsori_correction_tokens_total{direction="input"} 900' in metrics
    for path in deepinfra.data_dir.iterdir():
        if path.is_file():
            data = path.read_bytes()
            assert "금니".encode() not in data and "금리".encode() not in data and DI_KEY.encode() not in data


def test_deepinfra_model_and_reasoning_come_from_settings(deepinfra):
    provider = Provider(completion(model="Qwen/Qwen3.8-Flash"))
    config = replace(deepinfra, correction_model="Qwen/Qwen3.8-Flash", correction_reasoning="default")
    with TestClient(provider.app(config)) as client:
        assert client.get("/v1/availability").json()["correction_model"] == "Qwen/Qwen3.8-Flash"
        assert correct(client, install(client)).json()["model"] == "Qwen/Qwen3.8-Flash"
    body = json.loads(provider.requests[0].content)
    assert body["model"] == "Qwen/Qwen3.8-Flash" and "reasoning_effort" not in body


@pytest.mark.parametrize("status,gateway_status,code", [
    (400, 502, "correction_bad_request"), (401, 503, "correction_provider_auth"),
    (402, 503, "correction_provider_billing"), (403, 503, "correction_provider_auth"),
    (404, 503, "correction_model_unavailable"), (422, 502, "correction_bad_request"),
    (429, 429, "correction_rate_limited"), (500, 502, "correction_provider_error"), (503, 502, "correction_provider_error"),
])
def test_deepinfra_http_errors_become_fixed_codes_without_retry_or_echo(deepinfra, status, gateway_status, code):
    provider = Provider(status=status)
    with TestClient(provider.app(deepinfra)) as client:
        response = correct(client, install(client))
        assert (response.status_code, response.json()) == (gateway_status, {"detail": code})
        assert "금니" not in response.text and DI_KEY not in response.text
        assert len(provider.requests) == 1  # never retried: a repeat could be billed twice
        assert "onsori_correction_failures_total 1" in client.get("/metrics", headers={"Authorization": "Bearer " + METRICS}).text


@pytest.mark.parametrize("error,status,code", [
    (lambda request: httpx.ReadTimeout("slow", request=request), 504, "correction_timeout"),
    (lambda request: httpx.ConnectError("refused", request=request), 502, "correction_network_error"),
])
def test_deepinfra_timeouts_and_network_errors(deepinfra, error, status, code):
    provider = Provider(error=error)
    with TestClient(provider.app(deepinfra)) as client:
        response = correct(client, install(client))
        assert (response.status_code, response.json()) == (status, {"detail": code})
        assert len(provider.requests) == 1


@pytest.mark.parametrize("provider,status,code", [
    (Provider(completion(finish="length")), 502, "correction_truncated"),
    (Provider(completion(finish="content_filter")), 422, "correction_refused"),
    (Provider(completion(content="no json")), 502, "correction_invalid_output"),
    (Provider(completion(content="[1, 2]")), 502, "correction_invalid_output"),
    (Provider(completion(content='{"corrections": "a"}')), 502, "correction_invalid_output"),
    (Provider(raw=b"<html>gateway</html>"), 502, "correction_invalid_output"),
    (Provider(raw=json.dumps({"choices": []}).encode()), 502, "correction_invalid_output"),
    (Provider(raw=b" " * (module.MAX_CORRECTION_REPLY + 1)), 502, "correction_provider_error"),
])
def test_deepinfra_unusable_replies(deepinfra, provider, status, code):
    with TestClient(provider.app(deepinfra)) as client:
        response = correct(client, install(client))
        assert (response.status_code, response.json()["detail"]) == (status, code)


def test_deepinfra_reply_without_usage_or_model_still_works(deepinfra):
    reply = completion([{"id": "b", "text": "네, 맞습니다"}])
    del reply["usage"], reply["model"]
    with TestClient(Provider(reply).app(deepinfra)) as client:
        assert correct(client, install(client)).json() == {"corrections": [{"id": "b", "text": "네, 맞습니다"}],
                                                          "model": "deepseek-ai/DeepSeek-V4-Flash-0731",
                                                          "usage": {"input_tokens": 0, "output_tokens": 0}}


def test_deepinfra_settings_validation_and_env(deepinfra, monkeypatch):
    deepinfra.validate()
    with pytest.raises(ValueError, match="DEEPINFRA_API_KEY"):
        replace(deepinfra, deepinfra_api_key="").validate()
    with pytest.raises(ValueError, match="DEEPINFRA_API_KEY"):
        replace(deepinfra, deepinfra_api_key="has space " + "k" * 20).validate()
    with pytest.raises(ValueError, match="ONSORI_CORRECTION_MODEL"):
        replace(deepinfra, correction_model="no-owner").validate()
    with pytest.raises(ValueError, match="ONSORI_CORRECTION_REASONING"):
        replace(deepinfra, correction_reasoning="extreme").validate()
    # Correction does not need the audio paid switch; audio stays off.
    assert deepinfra.correction_enabled and not deepinfra.enabled and not deepinfra.allow_paid
    assert not replace(deepinfra, deepinfra_api_key="").correction_enabled
    for name, value in {"ONSORI_CORRECTION": "deepinfra", "DEEPINFRA_API_KEY": DI_KEY,
                        "ONSORI_CORRECTION_MODEL": "google/gemma-4-31B-it", "ONSORI_CORRECTION_REASONING": "low"}.items():
        monkeypatch.setenv(name, value)
    loaded = module.Settings.from_env()
    assert (loaded.correction, loaded.correction_model_name, loaded.correction_reasoning) == ("deepinfra", "google/gemma-4-31B-it", "low")


def test_preflight_accepts_deepinfra_correction_only_with_a_key():
    spec = importlib.util.spec_from_file_location("cloud_preflight", Path(__file__).resolve().parents[1] / "deploy" / "cloud" / "preflight.py")
    preflight = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(preflight)
    good = {"ONSORI_API_TOKEN": API, "ONSORI_METRICS_TOKEN": METRICS, "ONSORI_PROVIDER": "disabled", "ONSORI_ALLOW_PAID": "false",
            "ONSORI_CORRECTION": "deepinfra", "DEEPINFRA_API_KEY": DI_KEY}
    assert preflight.check(good, METRICS) == []
    assert preflight.check({**good, "ONSORI_CORRECTION_MODEL": "deepseek-ai/DeepSeek-V4-Flash-0731",
                            "ONSORI_CORRECTION_REASONING": "default"}, METRICS) == []
    assert preflight.check({**good, "DEEPINFRA_API_KEY": ""}, METRICS)
    assert preflight.check({**good, "ONSORI_CORRECTION_MODEL": "bad model"}, METRICS)
    assert preflight.check({**good, "ONSORI_CORRECTION_REASONING": "max"}, METRICS)
    assert preflight.check({**good, "ONSORI_CORRECTION": "gemini"}, METRICS)
