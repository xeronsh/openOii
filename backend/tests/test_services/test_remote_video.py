from __future__ import annotations

import asyncio
import socket
import threading
import time

import pytest

from app.services import remote_video


def test_dns_lookup_cannot_outlive_the_download_budget(monkeypatch, tmp_path):
    release = threading.Event()

    def stuck_getaddrinfo(*_args, **_kwargs):
        release.wait(5)
        raise socket.gaierror("released")

    monkeypatch.setattr(remote_video.socket, "getaddrinfo", stuck_getaddrinfo)
    monkeypatch.setattr(remote_video, "MAX_DOWNLOAD_SECONDS", 0.2)
    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError, match="DNS lookup timed out"):
            remote_video.download_video("http://video.example/a.mp4", tmp_path / "a.mp4")
    finally:
        release.set()
    assert time.monotonic() - started < 2


def test_dns_errors_and_private_addresses_still_surface(monkeypatch):
    def failing(*_args, **_kwargs):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(remote_video.socket, "getaddrinfo", failing)
    with pytest.raises(socket.gaierror):
        remote_video._connection("http://missing.example/a.mp4", 1)

    monkeypatch.setattr(
        remote_video.socket,
        "getaddrinfo",
        lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 80))],
    )
    with pytest.raises(ValueError, match="public IP"):
        remote_video._connection("http://internal.example/a.mp4", 1)



class FakeResponse:
    def __init__(self, status=200, headers=None, chunks=(b"abc",)):
        self.status = status
        self._headers = headers or {}
        self._chunks = list(chunks)

    def getheader(self, name):
        return self._headers.get(name)

    def read(self, _n):
        return self._chunks.pop(0) if self._chunks else b""


class FakeConnection:
    def __init__(self, response, log):
        self.response = response
        self.log = log

    def request(self, method, target, headers=None):
        self.log.append(("GET", target))

    def getresponse(self):
        return self.response

    def close(self):
        self.log.append("close")


@pytest.fixture
def serve(monkeypatch):
    """Script the responses for successive URLs; record which URLs were opened."""
    opened: list[str] = []
    log: list = []
    queue: list[FakeResponse] = []

    def fake_connection(url, timeout):
        opened.append(url)
        return FakeConnection(queue.pop(0), log), "/target"

    monkeypatch.setattr(remote_video, "_connection", fake_connection)

    def use(*responses):
        queue[:] = list(responses)
        opened.clear()
        log.clear()
        return opened, log

    return use


def test_downloads_and_follows_relative_redirects(serve, tmp_path):
    opened, log = serve(
        FakeResponse(302, {"Location": "/next.mp4"}),
        FakeResponse(200, {"Content-Length": "6"}, [b"abc", b"def"]),
    )
    dest = tmp_path / "a.mp4"
    assert remote_video.download_video("https://cdn.example/a.mp4", dest) is True
    assert dest.read_bytes() == b"abcdef"
    assert opened == ["https://cdn.example/a.mp4", "https://cdn.example/next.mp4"]
    assert log.count("close") == 2


@pytest.mark.parametrize(
    ("responses", "error"),
    [
        ([FakeResponse(301, {})], "no destination"),
        ([FakeResponse(302, {"Location": "/x"})] * (remote_video.MAX_REDIRECTS + 1), "Too many"),
        ([FakeResponse(404)], "HTTP 404"),
        ([FakeResponse(200, {"Content-Length": "999"})], "size limit"),
        ([FakeResponse(200, {}, [b"0123456789"] * 2)], "size limit"),
    ],
)
def test_rejects_bad_responses_and_leaves_no_file(serve, tmp_path, responses, error):
    serve(*responses)
    dest = tmp_path / "b.mp4"
    with pytest.raises(ValueError, match=error):
        remote_video.download_video("https://cdn.example/b.mp4", dest, max_bytes=15)
    assert not dest.exists()


def test_cancel_before_request_and_mid_stream(serve, tmp_path):
    stop = threading.Event()
    stop.set()
    serve(FakeResponse())
    with pytest.raises(InterruptedError):
        remote_video.download_video("https://cdn.example/c.mp4", tmp_path / "c.mp4", stop_event=stop)

    class StopAfterFirst(FakeResponse):
        def read(self, n):
            stop.set()
            return b"chunk"

    stop.clear()
    serve(StopAfterFirst())
    dest = tmp_path / "d.mp4"
    with pytest.raises(InterruptedError):
        remote_video.download_video("https://cdn.example/d.mp4", dest, stop_event=stop)
    assert not dest.exists()


def test_times_out_against_the_overall_deadline(serve, tmp_path, monkeypatch):
    clock = iter([0.0, 1.0, remote_video.MAX_DOWNLOAD_SECONDS + 1.0])
    monkeypatch.setattr(remote_video.time, "monotonic", lambda: next(clock))
    serve(FakeResponse(200, {}, [b"abc", b"def"]))
    dest = tmp_path / "e.mp4"
    with pytest.raises(TimeoutError):
        remote_video.download_video("https://cdn.example/e.mp4", dest)
    assert not dest.exists()

    clock2 = iter([0.0, remote_video.MAX_DOWNLOAD_SECONDS + 1.0])
    monkeypatch.setattr(remote_video.time, "monotonic", lambda: next(clock2))
    with pytest.raises(TimeoutError):
        remote_video.download_video("https://cdn.example/f.mp4", tmp_path / "f.mp4")


def test_existing_destination_is_not_overwritten_or_deleted(serve, tmp_path):
    dest = tmp_path / "g.mp4"
    dest.write_bytes(b"keep")
    serve(FakeResponse())
    with pytest.raises(FileExistsError):
        remote_video.download_video("https://cdn.example/g.mp4", dest)
    assert dest.read_bytes() == b"keep"


def _addr(ip):
    return [(None, None, None, "", (ip, 443))]


@pytest.mark.parametrize(
    "url",
    ["ftp://cdn.example/a.mp4", "https:///a.mp4", "https://user:pw@cdn.example/a.mp4"],
)
def test_connection_rejects_non_public_urls(url):
    with pytest.raises(ValueError, match="public HTTP"):
        remote_video._connection(url, 1)


def test_connection_pins_public_ips_only(monkeypatch):
    monkeypatch.setattr(remote_video, "_resolve", lambda host, port, timeout: _addr("10.0.0.5"))
    with pytest.raises(ValueError, match="public IP"):
        remote_video._connection("https://cdn.example/a.mp4", 1)
    monkeypatch.setattr(remote_video, "_resolve", lambda host, port, timeout: [])
    with pytest.raises(ValueError, match="public IP"):
        remote_video._connection("https://cdn.example/a.mp4", 1)

    monkeypatch.setattr(remote_video, "_resolve", lambda host, port, timeout: _addr("93.184.216.34"))
    conn, target = remote_video._connection("https://cdn.example/v/a.mp4?sig=1", 1)
    assert target == "/v/a.mp4?sig=1" and conn.port == 443
    conn, target = remote_video._connection("http://cdn.example:8080", 1)
    assert target == "/" and conn.port == 8080


def test_resolve_returns_addresses(monkeypatch):
    monkeypatch.setattr(remote_video.socket, "getaddrinfo", lambda *a, **k: [("ok",)])
    assert remote_video._resolve("cdn.example", 443, 1) == [("ok",)]


async def test_async_download_cancel_removes_partial_file(monkeypatch, tmp_path):
    dest = tmp_path / "h.mp4"
    started = threading.Event()

    def slow_download(url, destination, max_bytes, stop_event):
        destination.write_bytes(b"partial")
        started.set()
        stop_event.wait(5)
        return True

    monkeypatch.setattr(remote_video, "download_video", slow_download)
    task = asyncio.create_task(remote_video.download_video_async("https://cdn.example/h.mp4", dest))
    await asyncio.to_thread(started.wait, 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not dest.exists()

    def failing(url, destination, max_bytes, stop_event):
        started.set()
        stop_event.wait(5)
        raise InterruptedError("cancelled")

    started.clear()
    monkeypatch.setattr(remote_video, "download_video", failing)
    task = asyncio.create_task(remote_video.download_video_async("https://cdn.example/i.mp4", tmp_path / "i.mp4"))
    await asyncio.to_thread(started.wait, 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
