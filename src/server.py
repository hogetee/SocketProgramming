import argparse
import socket
import threading
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, Optional, Set, Tuple


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 5050


@dataclass
class ClientSession:
    socket: socket.socket
    address: Tuple[str, int]


class ChatServer:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self._server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._clients: Dict[str, ClientSession] = {}
        self._groups: Dict[str, Set[str]] = defaultdict(set)
        self._lock = threading.RLock()
        self._shutdown_event = threading.Event()

    def start(self) -> None:
        self._server_socket.bind((self.host, self.port))
        self._server_socket.listen()
        print(f"Server listening on {self.host}:{self.port}")
        try:
            while not self._shutdown_event.is_set():
                try:
                    client_sock, address = self._server_socket.accept()
                except OSError:
                    break
                threading.Thread(
                    target=self._handle_client, args=(client_sock, address), daemon=True
                ).start()
        except KeyboardInterrupt:
            print("\nShutting down server...")
        finally:
            self._shutdown_event.set()
            self._server_socket.close()
            with self._lock:
                for session in self._clients.values():
                    session.socket.close()
            print("Server stopped.")

    def _handle_client(self, client_sock: socket.socket, address: Tuple[str, int]) -> None:
        name: Optional[str] = None
        try:
            self._send_line(client_sock, "Welcome to the network lab chat server!")
            name = self._negotiate_name(client_sock)
            if not name:
                return
            self._send_help(client_sock)
            self._broadcast_system(f"{name} joined the chat.")
            while True:
                data = client_sock.recv(4096)
                if not data:
                    break
                message = data.decode("utf-8").strip()
                if not message:
                    continue
                if message.startswith("/"):
                    should_close = self._process_command(name, message, client_sock)
                    if should_close:
                        break
                else:
                    self._send_line(
                        client_sock,
                        "Unknown input. Use /help to see the list of supported commands.",
                    )
        except ConnectionError:
            pass
        finally:
            client_sock.close()
            if name:
                self._remove_client(name)
                self._broadcast_system(f"{name} left the chat.")

    def _negotiate_name(self, client_sock: socket.socket) -> Optional[str]:
        self._send_line(
            client_sock,
            "Enter a nickname (letters, numbers, underscores). Use /quit to abort.",
        )
        while True:
            data = client_sock.recv(4096)
            if not data:
                return None
            candidate = data.decode("utf-8").strip()
            if candidate.lower() == "/quit":
                self._send_line(client_sock, "Goodbye!")
                return None
            if not candidate or not candidate.replace("_", "").isalnum():
                self._send_line(
                    client_sock, "Nickname must be alphanumeric (underscores allowed). Try again:"
                )
                continue
            with self._lock:
                if candidate in self._clients:
                    self._send_line(client_sock, "Name already in use. Try another:")
                    continue
                self._clients[candidate] = ClientSession(client_sock, client_sock.getpeername())
            self._send_line(client_sock, f"Hello {candidate}! Type /help to see commands.")
            return candidate

    def _process_command(self, name: str, raw: str, client_sock: socket.socket) -> bool:
        tokens = raw.strip().split()
        if not tokens:
            return False
        cmd = tokens[0].lower()
        if cmd == "/help":
            self._send_help(client_sock)
        elif cmd == "/list":
            if len(tokens) < 2:
                self._send_line(client_sock, "Usage: /list users|groups")
            elif tokens[1].lower() == "users":
                self._list_users(client_sock)
            elif tokens[1].lower() == "groups":
                self._list_groups(client_sock)
            else:
                self._send_line(client_sock, "Unknown list target. Use users or groups.")
        elif cmd == "/msg":
            if len(tokens) < 3:
                self._send_line(client_sock, "Usage: /msg <nickname> <message>")
            else:
                target = tokens[1]
                text = " ".join(tokens[2:])
                self._send_private(name, target, text, client_sock)
        elif cmd == "/group":
            if len(tokens) < 3:
                self._send_line(
                    client_sock,
                    "Usage: /group create|join|leave|send <group_name> [message]",
                )
            else:
                action = tokens[1].lower()
                group_name = tokens[2]
                if action == "create":
                    self._group_create(name, group_name, client_sock)
                elif action == "join":
                    self._group_join(name, group_name, client_sock)
                elif action == "leave":
                    self._group_leave(name, group_name, client_sock)
                elif action == "send":
                    if len(tokens) < 4:
                        self._send_line(client_sock, "Usage: /group send <group_name> <message>")
                    else:
                        message = " ".join(tokens[3:])
                        self._group_send(name, group_name, message, client_sock)
                else:
                    self._send_line(client_sock, "Unknown group action (create|join|leave|send).")
        elif cmd == "/quit":
            self._send_line(client_sock, "Disconnecting. Bye!")
            return True
        else:
            self._send_line(client_sock, "Unknown command. Use /help to see all options.")
        return False

    def _send_help(self, client_sock: socket.socket) -> None:
        help_lines = [
            "Commands:",
            "  /help                             Show this help message",
            "  /list users                       Show all connected clients",
            "  /list groups                      Show all groups with members",
            "  /msg <user> <message>             Send a private message",
            "  /group create <name>              Create a new group (you join automatically)",
            "  /group join <name>                Join an existing group",
            "  /group leave <name>               Leave a group you're part of",
            "  /group send <name> <message>      Send a message to a group you're in",
            "  /quit                             Disconnect from the server",
        ]
        self._send_line(client_sock, "\n".join(help_lines))

    def _list_users(self, client_sock: socket.socket) -> None:
        with self._lock:
            names = sorted(self._clients.keys())
        if not names:
            self._send_line(client_sock, "No connected users.")
            return
        users = ", ".join(names)
        self._send_line(client_sock, f"Online users ({len(names)}): {users}")

    def _list_groups(self, client_sock: socket.socket) -> None:
        with self._lock:
            if not self._groups:
                self._send_line(client_sock, "No groups have been created.")
                return
            lines = []
            for group, members in sorted(self._groups.items()):
                member_list = ", ".join(sorted(members)) or "(empty)"
                lines.append(f"{group}: {member_list}")
        self._send_line(client_sock, "\n".join(lines))

    def _send_private(
        self, sender: str, target: str, message: str, client_sock: socket.socket
    ) -> None:
        with self._lock:
            recipient = self._clients.get(target)
        if not recipient:
            self._send_line(client_sock, f"{target} is not online.")
            return
        self._send_line(recipient.socket, f"[PM] {sender}: {message}")
        self._send_line(client_sock, f"[PM -> {target}] {message}")

    def _group_create(self, name: str, group_name: str, client_sock: socket.socket) -> None:
        with self._lock:
            if group_name in self._groups:
                self._send_line(client_sock, "Group already exists.")
                return
            self._groups[group_name].add(name)
        self._send_line(client_sock, f"Created group {group_name} and joined it.")

    def _group_join(self, name: str, group_name: str, client_sock: socket.socket) -> None:
        with self._lock:
            if group_name not in self._groups:
                self._send_line(client_sock, "Group does not exist.")
                return
            self._groups[group_name].add(name)
        self._send_line(client_sock, f"Joined group {group_name}.")

    def _group_leave(self, name: str, group_name: str, client_sock: socket.socket) -> None:
        with self._lock:
            members = self._groups.get(group_name)
            if not members or name not in members:
                self._send_line(client_sock, "You are not a member of that group.")
                return
            members.remove(name)
            if not members:
                del self._groups[group_name]
        self._send_line(client_sock, f"Left group {group_name}.")

    def _group_send(
        self, sender: str, group_name: str, message: str, client_sock: socket.socket
    ) -> None:
        with self._lock:
            members = self._groups.get(group_name, set()).copy()
        if sender not in members:
            self._send_line(client_sock, "You must join the group before sending messages.")
            return
        for member in members:
            if member == sender:
                continue
            with self._lock:
                recipient = self._clients.get(member)
            if recipient:
                self._send_line(recipient.socket, f"[Group:{group_name}] {sender}: {message}")
        self._send_line(client_sock, f"[Group:{group_name}] (you): {message}")

    def _broadcast_system(self, message: str) -> None:
        with self._lock:
            recipients = list(self._clients.values())
        for session in recipients:
            self._send_line(session.socket, f"[System] {message}")

    def _remove_client(self, name: str) -> None:
        with self._lock:
            session = self._clients.pop(name, None)
            if session:
                for group, members in list(self._groups.items()):
                    members.discard(name)
                    if not members:
                        del self._groups[group]

    @staticmethod
    def _send_line(sock: socket.socket, message: str) -> None:
        try:
            sock.sendall((message + "\n").encode("utf-8"))
        except OSError:
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Simple multi-client chat server.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Host interface to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to bind (default: 5050)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ChatServer(args.host, args.port)
    server.start()


if __name__ == "__main__":
    main()
