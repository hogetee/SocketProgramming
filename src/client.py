import argparse
import socket
import sys
import threading
from typing import Optional

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5050


class ChatClient:
    def __init__(self, host: str, port: int, nickname: Optional[str]) -> None:
        self.host = host
        self.port = port
        self.nickname = nickname
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._stop_event = threading.Event()

    def run(self) -> None:
        self._socket.connect((self.host, self.port))
        receiver = threading.Thread(target=self._receive_loop, daemon=True)
        receiver.start()
        if self.nickname:
            # Send the nickname once the server asks for it.
            self._socket.sendall((self.nickname + "\n").encode("utf-8"))
        try:
            while not self._stop_event.is_set():
                try:
                    user_input = input("> ")
                except EOFError:
                    user_input = "/quit"
                if not user_input:
                    continue
                message = user_input.strip()
                self._socket.sendall((message + "\n").encode("utf-8"))
                if message.lower() == "/quit":
                    break
        except KeyboardInterrupt:
            self._socket.sendall("/quit\n".encode("utf-8"))
        finally:
            self._stop_event.set()
            self._socket.close()
            receiver.join(timeout=1)

    def _receive_loop(self) -> None:
        try:
            while not self._stop_event.is_set():
                data = self._socket.recv(4096)
                if not data:
                    print("\n[Disconnected from server]")
                    break
                text = data.decode("utf-8")
                for line in text.splitlines():
                    sys.stdout.write(f"\r{line}\n> ")
                    sys.stdout.flush()
        finally:
            self._stop_event.set()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Terminal client for the socket chat server.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Server host to connect to (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Server port to connect to (default: 5050)")
    parser.add_argument("--name", help="Optional nickname to send immediately after connecting")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    client = ChatClient(args.host, args.port, args.name)
    client.run()


if __name__ == "__main__":
    main()
