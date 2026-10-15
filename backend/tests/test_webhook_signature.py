import hashlib
import hmac
import json


def make_signature(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_signature_matches_raw_body():
    body = json.dumps({"event_id": "e-1", "event_type": "order.created"}).encode()
    signature = make_signature("test-secret", body)
    expected = hmac.new(b"test-secret", body, hashlib.sha256).hexdigest()
    assert signature == "sha256=" + expected


def test_signature_changes_when_body_changes():
    secret = "test-secret"
    first = b'{"event_id":"e-1"}'
    second = b'{"event_id":"e-2"}'
    assert make_signature(secret, first) != make_signature(secret, second)
