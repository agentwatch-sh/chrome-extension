#!/usr/bin/env python3
"""Native messaging host for the live test only (stdlib).

Chrome starts this program for the receiver extension. It relays messages
between Chrome's native messaging stdio (a 4-byte little-endian length, then
JSON) and the stub daemon's Unix socket (one NDJSON line per message). After
each connect to the socket it tells the extension {"t":"link","up":true}; the
receiver answers with its hello. While stdin is open it retries the socket
every second. When stdin closes (Chrome closed the port), it exits.

It logs message types and sizes only, never a message body.
"""

import argparse
import json
import os
import socket
import struct
import sys
import threading
import time

MAX_TO_EXTENSION = 1024 * 1024  # Chrome's limit for host-to-extension messages


class Relay:
    def __init__(self, sock_path: str, log_path: str | None) -> None:
        self.sock_path = sock_path
        self.log_path = log_path
        self.sock: socket.socket | None = None
        self.sock_lock = threading.Lock()
        self.out_lock = threading.Lock()
        self.stdin_open = True

    def log(self, **fields: object) -> None:
        if not self.log_path:
            return
        line = json.dumps({"ts": round(time.time(), 3), "pid": os.getpid(), **fields}, sort_keys=True)
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    # -- Chrome side

    def to_extension(self, data: bytes) -> None:
        if len(data) >= MAX_TO_EXTENSION:
            self.log(event="dropped", reason="too large for native messaging", bytes=len(data))
            return
        with self.out_lock:
            sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
            sys.stdout.buffer.flush()

    def read_extension(self) -> bytes | None:
        head = sys.stdin.buffer.read(4)
        if len(head) < 4:
            return None
        n = struct.unpack("<I", head)[0]
        body = sys.stdin.buffer.read(n)
        return body if len(body) == n else None

    # -- daemon side

    def connect_loop(self) -> None:
        while self.stdin_open:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                s.connect(self.sock_path)
            except OSError:
                s.close()
                time.sleep(1.0)
                continue
            with self.sock_lock:
                self.sock = s
            self.log(event="socket", up=True)
            self.to_extension(json.dumps({"t": "link", "up": True}, separators=(",", ":")).encode())
            self.read_socket(s)
            with self.sock_lock:
                if self.sock is s:
                    self.sock = None
            s.close()
            self.log(event="socket", up=False)
            time.sleep(1.0)

    def read_socket(self, s: socket.socket) -> None:
        buf = b""
        while True:
            try:
                chunk = s.recv(1 << 20)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    self.log(event="bad line from daemon", bytes=len(line))
                    continue
                self.log(event="to extension", t=msg.get("t") if isinstance(msg, dict) else None, bytes=len(line))
                self.to_extension(line)

    def run(self) -> None:
        self.log(event="start", origin=sys.argv[-1] if len(sys.argv) > 1 else None)
        threading.Thread(target=self.connect_loop, daemon=True).start()
        while True:
            data = self.read_extension()
            if data is None:
                break
            try:
                msg = json.loads(data)
            except ValueError:
                self.log(event="bad message from extension", bytes=len(data))
                continue
            t = msg.get("t") if isinstance(msg, dict) else None
            with self.sock_lock:
                s = self.sock
            if s is None:
                self.log(event="dropped", reason="socket down", t=t)
                continue
            try:
                s.sendall(json.dumps(msg, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n")
                self.log(event="to daemon", t=t, bytes=len(data))
            except OSError:
                self.log(event="dropped", reason="socket write failed", t=t)
        self.stdin_open = False
        self.log(event="stdin closed")
        with self.sock_lock:
            if self.sock is not None:
                try:
                    self.sock.close()
                except OSError:
                    pass


def main() -> None:
    ap = argparse.ArgumentParser(description="live test native host relay")
    ap.add_argument("--socket", required=True, help="the stub daemon's Unix socket")
    ap.add_argument("--log", help="a log file for message types and sizes")
    args, _chrome_args = ap.parse_known_args()
    Relay(args.socket, args.log).run()
    os._exit(0)


if __name__ == "__main__":
    main()
