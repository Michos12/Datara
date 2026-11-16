from fastapi.testclient import TestClient

from insights.api.app import create_app

TOKEN = "test-service-token-123"


class FakeDatabase:
    def __init__(self, up: bool) -> None:
        self.up = up

    def ping(self) -> bool:
        return self.up


def client(*, db_up: bool = True) -> TestClient:
    return TestClient(
        create_app(version="1.2.3", service_token=TOKEN, database=FakeDatabase(db_up))
    )


def test_health_ok_when_database_up() -> None:
    res = client().get("/internal/health")
    assert res.status_code == 200
    assert res.json() == {
        "status": "ok",
        "service": "analytics",
        "version": "1.2.3",
        "checks": {"database": "up"},
    }


def test_health_degraded_when_database_down() -> None:
    res = client(db_up=False).get("/internal/health")
    assert res.status_code == 503
    assert res.json()["status"] == "degraded"
    assert res.json()["checks"]["database"] == "down"


def test_internal_routes_require_service_token() -> None:
    assert client().get("/internal/definitions").status_code == 401
    wrong = client().get("/internal/definitions", headers={"X-Service-Token": "wrong"})
    assert wrong.status_code == 401


def test_internal_routes_accept_valid_token() -> None:
    res = client().get("/internal/definitions", headers={"X-Service-Token": TOKEN})
    assert res.status_code == 200
    assert res.json() == {"data": []}


def test_public_docs_are_disabled() -> None:
    assert client().get("/docs").status_code == 404


def test_lifespan_hooks_run() -> None:
    calls: list[str] = []
    app = create_app(
        version="x",
        service_token=TOKEN,
        database=FakeDatabase(True),
        on_startup=lambda: calls.append("start"),
        on_shutdown=lambda: calls.append("stop"),
    )
    with TestClient(app):
        assert calls == ["start"]
    assert calls == ["start", "stop"]
