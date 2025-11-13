import React, { useEffect, useMemo, useRef, useState } from "react";

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:3000/ws`;
const HISTORY_LIMIT = 200;
const SYSTEM_ROOM_ID = "!system";

function roomDescriptor(type, identifierRaw = "") {
  const identifier = identifierRaw.trim();
  if (type === "system") {
    return { id: SYSTEM_ROOM_ID, label: "system", target: undefined };
  }
  if (type === "private") {
    const value = identifier.replace(/^@/, "");
    return { id: `@${value}`, label: `@${value}`, target: value };
  }
  if (type === "group") {
    const value = identifier.replace(/^#/, "");
    return { id: `#${value}`, label: `#${value}`, target: value };
  }
  return { id: identifier || "?room", label: identifier || "?room", target: identifier };
}

function seedMessages(type, label, target) {
  if (type === "system") {
    return [
      "[info] System room active. Server prompts will appear here.",
      "Enter your nickname when prompted. Use /chat @nickname or /chat #group after joining.",
    ];
  }
  if (type === "private" && target) {
    return [`[info] Private chat with ${target}. Type to send direct messages.`];
  }
  if (type === "group" && target) {
    return [`[info] Group chat ${label}. Members will see anything you send here.`];
  }
  return [];
}

function createRoom(type, identifier) {
  const descriptor = roomDescriptor(type, identifier);
  return {
    ...descriptor,
    type,
    messages: seedMessages(type, descriptor.label, descriptor.target),
    unread: 0,
  };
}

function sortRooms(a, b) {
  if (a.id === SYSTEM_ROOM_ID) return -1;
  if (b.id === SYSTEM_ROOM_ID) return 1;
  return a.label.localeCompare(b.label);
}

export default function App() {
  const [rooms, setRooms] = useState(() => ({
    [SYSTEM_ROOM_ID]: createRoom("system", "system"),
  }));
  const [activeRoomId, setActiveRoomId] = useState(SYSTEM_ROOM_ID);
  const [chatInput, setChatInput] = useState("");
  const [readyForChats, setReadyForChats] = useState(false);
  const [nickInput, setNickInput] = useState("");
  const [nickname, setNickname] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [userRefreshPending, setUserRefreshPending] = useState(false);
  const [groupRefreshPending, setGroupRefreshPending] = useState(false);
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [directTarget, setDirectTarget] = useState("");
  const [groupName, setGroupName] = useState("");
  const [roomHintShown, setRoomHintShown] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);

  const wsRef = useRef(null);
  const bufferRef = useRef("");
  const handlerRef = useRef(() => {});
  const chatScrollRef = useRef(null);
  const groupAccumulatorRef = useRef(null);
  const groupTimerRef = useRef(null);

  const roomsList = useMemo(() => Object.values(rooms).sort(sortRooms), [rooms]);
  const activeRoom = rooms[activeRoomId] || rooms[SYSTEM_ROOM_ID];
  const socketReady = connectionStatus === "open";

  useEffect(() => {
    handlerRef.current = handleSocketPayload;
  });

  useEffect(() => {
    bufferRef.current = "";
    const socket = new WebSocket(WS_URL);
    wsRef.current = socket;
    setConnectionStatus("connecting");

    const handleOpen = () => setConnectionStatus("open");
    const handleMessage = (event) => handlerRef.current(event.data);
    const handleClose = () => {
      setConnectionStatus("closed");
      setReadyForChats(false);
      setNickname("");
      finalizeGroupAccumulator(true);
    };
    const handleError = () => setConnectionStatus("error");

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);

    return () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
      socket.close();
    };
  }, [reconnectKey]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [activeRoom?.messages]);

  useEffect(() => {
    if (readyForChats) {
      refreshUsers();
      refreshGroups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyForChats]);

  function sendRaw(text) {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const payload = text.endsWith("\n") ? text : `${text}\n`;
    socket.send(payload);
    return true;
  }

  function ensureRoom(type, identifier) {
    const descriptor = roomDescriptor(type, identifier);
    setRooms((prev) => {
      if (prev[descriptor.id]) {
        return prev;
      }
      return {
        ...prev,
        [descriptor.id]: createRoom(type, identifier),
      };
    });
    return descriptor;
  }

  function focusRoomById(id) {
    if (!id) return;
    setActiveRoomId(id);
    setRooms((prev) => {
      const room = prev[id];
      if (!room || room.unread === 0) {
        return prev;
      }
      return { ...prev, [id]: { ...room, unread: 0 } };
    });
  }

  function appendMessage(type, identifier, text) {
    setRooms((prev) => {
      const descriptor = roomDescriptor(type, identifier);
      const existing = prev[descriptor.id] || createRoom(type, identifier);
      const nextMessages = [...existing.messages, text].slice(-HISTORY_LIMIT);
      const unread = descriptor.id === activeRoomId ? 0 : existing.unread + 1;
      return {
        ...prev,
        [descriptor.id]: { ...existing, messages: nextMessages, unread },
      };
    });
  }

  function detectGroupRoomHints(line) {
    const createdMatch = line.match(/^Created group ([A-Za-z0-9_]+) and joined it\./);
    if (createdMatch) {
      appendMessage("group", createdMatch[1], "[info] You created this group.");
      return;
    }
    const joinedMatch = line.match(/^Joined group ([A-Za-z0-9_]+)\./);
    if (joinedMatch) {
      appendMessage("group", joinedMatch[1], "[info] You joined this group.");
    }
  }

  function handleNickSubmit(e) {
    e.preventDefault();
    const value = nickInput.trim();
    if (!value || !socketReady) {
      return;
    }
    if (sendRaw(value)) {
      setNickInput("");
    }
  }

  function handleSendMessage(e) {
    e?.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      sendRaw(text);
      setChatInput("");
      return;
    }
    const room = rooms[activeRoomId];
    if (!readyForChats || !room || room.type === "system" || !room.target) {
      appendMessage("system", "system", "Use /chat @nickname or /chat #group before sending plain text.");
      setChatInput("");
      return;
    }
    if (room.type === "private") {
      sendRaw(`/msg ${room.target} ${text}`);
    } else if (room.type === "group") {
      sendRaw(`/group send ${room.target} ${text}`);
    }
    setChatInput("");
  }

  function handleDirectOpen(e) {
    e.preventDefault();
    const value = directTarget.trim().replace(/^@/, "");
    if (!value) return;
    const descriptor = ensureRoom("private", value);
    focusRoomById(descriptor.id);
    setDirectTarget("");
  }

  function handleGroupOpen(e) {
    e.preventDefault();
    const value = groupName.trim().replace(/^#/, "");
    if (!value) return;
    const descriptor = ensureRoom("group", value);
    focusRoomById(descriptor.id);
  }

  function handleGroupAction(action) {
    const value = groupName.trim().replace(/^#/, "");
    if (!value) return;
    sendRaw(`/group ${action} ${value}`);
    if (action === "create" || action === "join") {
      const descriptor = ensureRoom("group", value);
      focusRoomById(descriptor.id);
    }
    if (action === "leave") {
      appendMessage("group", value, "[info] You asked to leave this group.");
    }
    setGroupName("");
  }

  function refreshUsers() {
    setUserRefreshPending(true);
    if (!sendRaw("/list users")) {
      setUserRefreshPending(false);
    }
  }

  function refreshGroups() {
    setGroupRefreshPending(true);
    groupAccumulatorRef.current = [];
    if (!sendRaw("/list groups")) {
      groupAccumulatorRef.current = null;
      setGroupRefreshPending(false);
    }
  }

  function restartGroupAccumulatorTimer() {
    if (groupTimerRef.current) {
      clearTimeout(groupTimerRef.current);
    }
    groupTimerRef.current = setTimeout(() => finalizeGroupAccumulator(), 150);
  }

  function finalizeGroupAccumulator(dropOnly = false) {
    if (groupTimerRef.current) {
      clearTimeout(groupTimerRef.current);
      groupTimerRef.current = null;
    }
    if (!groupAccumulatorRef.current) {
      return;
    }
    const payload = groupAccumulatorRef.current;
    groupAccumulatorRef.current = null;
    if (dropOnly) {
      setGroupRefreshPending(false);
      return;
    }
    if (payload.length === 0) {
      setGroups([]);
    } else {
      setGroups(
        payload.map(({ name, members }) => ({
          name,
          members: members
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        }))
      );
    }
    setGroupRefreshPending(false);
  }

  function handleUserMetadata(line) {
    if (line.startsWith("Online users")) {
      const afterColon = line.split(":").slice(1).join(":");
      const names = afterColon
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      setUsers(names);
      setUserRefreshPending(false);
    } else if (line === "No connected users.") {
      setUsers([]);
      setUserRefreshPending(false);
    }
  }

  function handleGroupMetadata(line) {
    if (!groupAccumulatorRef.current) {
      return;
    }
    if (line === "No groups have been created.") {
      setGroups([]);
      finalizeGroupAccumulator();
      return;
    }
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (match) {
      const [, name, members] = match;
      groupAccumulatorRef.current.push({ name, members });
      restartGroupAccumulatorTimer();
      return;
    }
    if (groupAccumulatorRef.current.length > 0) {
      finalizeGroupAccumulator();
    } else {
      finalizeGroupAccumulator(true);
    }
  }

  function routeServerLine(line) {
    if (!line.trim()) {
      return;
    }
    handleUserMetadata(line);
    handleGroupMetadata(line);

    const privateIncoming = line.match(/^\[PM\]\s+([^:]+):\s*(.*)$/);
    if (privateIncoming) {
      const [, sender, body] = privateIncoming;
      appendMessage("private", sender, `${sender}: ${body}`);
      return;
    }
    const privateOutgoing = line.match(/^\[PM -> ([^\]]+)\]\s*(.*)$/);
    if (privateOutgoing) {
      const [, target, body] = privateOutgoing;
      appendMessage("private", target, `(you): ${body}`);
      return;
    }
    const groupMatch = line.match(/^\[Group:([^\]]+)\]\s+(.*)$/);
    if (groupMatch) {
      const [, groupName, rest] = groupMatch;
      const colonIndex = rest.indexOf(":");
      if (colonIndex === -1) {
        appendMessage("group", groupName, rest.trim());
      } else {
        const speaker = rest.slice(0, colonIndex).trim();
        const body = rest.slice(colonIndex + 1).trim();
        appendMessage("group", groupName, `${speaker}: ${body}`);
      }
      return;
    }

    detectGroupRoomHints(line);
    appendMessage("system", "system", line);
    const helloMatch = line.match(/^Hello\s+([A-Za-z0-9_]+)!/);
    if (helloMatch) {
      setNickname(helloMatch[1]);
      setReadyForChats(true);
      if (!roomHintShown) {
        appendMessage("system", "system", "Chat rooms unlocked. Use /chat @nickname or /chat #group to focus a room.");
        appendMessage(
          "system",
          "system",
          "While a room is active you can type without prefixes to use it as a chat box."
        );
        setRoomHintShown(true);
      }
    }
  }

  function handleSocketPayload(payload) {
    if (typeof payload !== "string") {
      return;
    }
    bufferRef.current += payload;
    while (true) {
      const newline = bufferRef.current.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const rawLine = bufferRef.current.slice(0, newline);
      bufferRef.current = bufferRef.current.slice(newline + 1);
      const line = rawLine.replace(/\r$/, "");
      routeServerLine(line);
    }
  }

  function handleReconnect() {
    setRooms({ [SYSTEM_ROOM_ID]: createRoom("system", "system") });
    setActiveRoomId(SYSTEM_ROOM_ID);
    setReadyForChats(false);
    setNickname("");
    setUsers([]);
    setGroups([]);
    setRoomHintShown(false);
    groupAccumulatorRef.current = null;
    bufferRef.current = "";
    setReconnectKey((key) => key + 1);
  }

  if (!readyForChats) {
    return (
      <div className="entry-screen">
        <div className="entry-card">
          <h2>Create Avatar</h2>
          <p className="muted small">Pick a nickname to join the chat (avatars coming soon).</p>
          <div className="entry-status">
            <span>Status: {connectionStatus}</span>
            {(connectionStatus === "closed" || connectionStatus === "error") && (
              <button type="button" onClick={handleReconnect}>
                Reconnect
              </button>
            )}
          </div>
          <div className="avatar-row">
            {["🐻", "🐼", "🦊", "🐥"].map((emoji) => (
              <span key={emoji} className="avatar-pill" aria-hidden="true">
                {emoji}
              </span>
            ))}
          </div>
          <form className="entry-form" onSubmit={handleNickSubmit}>
            <label htmlFor="avatar-name">Avatar Name</label>
            <input
              id="avatar-name"
              value={nickInput}
              onChange={(e) => setNickInput(e.target.value)}
              placeholder="avatar name"
              disabled={!socketReady}
            />
            <button type="submit" disabled={!socketReady || !nickInput.trim()}>
              {socketReady ? "Create" : "Connecting..."}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="status-bar">
        <div>
          <strong>Status:</strong> {connectionStatus}
          {(connectionStatus === "closed" || connectionStatus === "error") && (
            <button type="button" className="pill-btn" onClick={handleReconnect}>
              Reconnect
            </button>
          )}
        </div>
        <div>{nickname ? `Connected as ${nickname}` : "Choose a nickname to join the chat."}</div>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <section className="panel">
            <div className="panel-header">
              <h3>Rooms</h3>
              <button type="button" onClick={() => focusRoomById(SYSTEM_ROOM_ID)}>
                System
              </button>
            </div>
            <ul className="room-list">
              {roomsList.map((room) => (
                <li
                  key={room.id}
                  className={room.id === activeRoomId ? "active" : ""}
                  onClick={() => focusRoomById(room.id)}
                >
                  <span>{room.label}</span>
                  {room.unread > 0 && <span className="pill">{room.unread}</span>}
                </li>
              ))}
            </ul>
            <form className="form-row" onSubmit={handleDirectOpen}>
              <input
                value={directTarget}
                onChange={(e) => setDirectTarget(e.target.value)}
                placeholder="open @nickname"
              />
              <button type="submit">Open</button>
            </form>
            <form className="form-row" onSubmit={handleGroupOpen}>
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="open #group"
              />
              <button type="submit">Use</button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-header">
              <h3>Users</h3>
              <button type="button" onClick={refreshUsers} disabled={userRefreshPending}>
                {userRefreshPending ? "..." : "Refresh"}
              </button>
            </div>
            {users.length === 0 && <p className="muted">Run /list users to populate this list.</p>}
            <ul className="item-list">
              {users.map((user) => (
                <li key={user}>
                  <span>{user}</span>
                  <button type="button" onClick={() => openRoom("private", user)}>
                    Chat
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <div className="panel-header">
              <h3>Groups</h3>
              <button type="button" onClick={refreshGroups} disabled={groupRefreshPending}>
                {groupRefreshPending ? "..." : "Refresh"}
              </button>
            </div>
            {groups.length === 0 && <p className="muted">Use /group commands or refresh to see groups.</p>}
            <ul className="item-list">
              {groups.map((group) => (
                <li key={group.name}>
                  <div>
                    <strong>{group.name}</strong>
                    {group.members.length > 0 && (
                      <div className="muted small">
                        {group.members.length} member{group.members.length === 1 ? "" : "s"}
                      </div>
                    )}
                  </div>
                  <div className="group-actions">
                    <button type="button" onClick={() => openRoom("group", group.name)}>
                      Chat
                    </button>
                    <button type="button" onClick={() => sendRaw(`/group join ${group.name}`)}>
                      Join
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="group-form">
              <button type="button" onClick={() => handleGroupAction("create")}>
                Create
              </button>
              <button type="button" onClick={() => handleGroupAction("join")}>
                Join
              </button>
              <button type="button" onClick={() => handleGroupAction("leave")}>
                Leave
              </button>
            </div>
          </section>
        </aside>
        <section className="chat-panel">
          <div className="chat-header">
            <div>
              <h2>{activeRoom?.label || "system"}</h2>
              <p className="muted small">
                {activeRoom?.type === "system"
                  ? "Server prompts and command output."
                  : activeRoom?.type === "private"
                  ? `Private chat with ${activeRoom.target}`
                  : `Group chat ${activeRoom?.label}`}
              </p>
            </div>
          </div>
          <div className="messages" ref={chatScrollRef}>
            {(activeRoom?.messages ?? []).map((text, idx) => (
              <div key={`${activeRoom?.id}-${idx}`} className="line">
                {text}
              </div>
            ))}
          </div>
          <form className="controls" onSubmit={handleSendMessage}>
            <input
              className="txt"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={
                activeRoom?.type === "system"
                  ? "Type /command or open a room to chat"
                  : `Message ${activeRoom?.label}`
              }
            />
            <button type="submit">Send</button>
          </form>
          <p className="muted small">
            Prefix with / to send raw commands (e.g. /help, /list users). Plain text targets the active room.
          </p>
        </section>
      </div>
    </div>
  );

  function openRoom(type, identifier) {
    const descriptor = ensureRoom(type, identifier);
    focusRoomById(descriptor.id);
  }
}
