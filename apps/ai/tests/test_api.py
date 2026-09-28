from fastapi.testclient import TestClient

from app.main import app
from app.model import predict

client = TestClient(app)


def test_predict_unit() -> None:
    assert predict("I love this, it is great")[0] == "positive"
    assert predict("this is terrible")[0] == "negative"
    assert predict("the sky is blue") == ("neutral", 0.5)


def test_health() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_sentiment_endpoint() -> None:
    res = client.post("/v1/sentiment", json={"text": "What an awesome day"})
    assert res.status_code == 200
    body = res.json()
    assert body["label"] == "positive"
    assert 0 <= body["score"] <= 1
    assert body["model"] == "wordlist-v1"


def test_sentiment_validates_input() -> None:
    assert client.post("/v1/sentiment", json={"text": ""}).status_code == 422
    assert client.post("/v1/sentiment", json={}).status_code == 422
