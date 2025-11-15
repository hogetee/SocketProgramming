import React, { useEffect, useMemo, useRef, useState } from "react";

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:3000/ws`;
const HISTORY_LIMIT = 200;
const SYSTEM_ROOM_ID = "!system";
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const ENTRY_ART =
  "data:image/svg+xml,%3Csvg width='360' height='200' viewBox='0 0 360 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23336CB5'/%3E%3Cstop offset='100%25' stop-color='%23F58C48'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='360' height='200' rx='32' fill='%23F6FBFF'/%3E%3Ccircle cx='80' cy='70' r='60' fill='%23DCEAFF'/%3E%3Ccircle cx='280' cy='60' r='70' fill='%23FFE2CB'/%3E%3Cpath d='M0 120C60 160 140 80 210 110C290 145 320 100 360 120V200H0V120Z' fill='url(%23grad)' opacity='0.85'/%3E%3Ccircle cx='120' cy='80' r='22' fill='%23FFFFFF' opacity='0.8'/%3E%3Ccircle cx='250' cy='90' r='16' fill='%23FFFFFF' opacity='0.8'/%3E%3Ccircle cx='210' cy='65' r='10' fill='%23FFFFFF' opacity='0.7'/%3E%3C/svg%3E";

function createMessage(text, extras = {}) {
  return { text, timestamp: Date.now(), ...extras };
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeFileName(value = "") {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return normalized || "photo";
}

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
      createMessage("[info] System room active. Server prompts will appear here."),
      createMessage("Enter your nickname when prompted. Use /chat @nickname or /chat #group after joining."),
    ];
  }
  if (type === "private" && target) {
    return [createMessage(`[info] Private chat with ${target}. Type to send direct messages.`)];
  }
  if (type === "group" && target) {
    return [createMessage(`[info] Group chat ${label}. Members will see anything you send here.`)];
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
  const [photoAttachment, setPhotoAttachment] = useState(null);
  const [photoCaption, setPhotoCaption] = useState("");
  const [photoError, setPhotoError] = useState("");

  const wsRef = useRef(null);
  const bufferRef = useRef("");
  const handlerRef = useRef(() => {});
  const chatScrollRef = useRef(null);
  const groupAccumulatorRef = useRef(null);
  const groupTimerRef = useRef(null);
  const photoInputRef = useRef(null);

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
      resetPhotoSelection();
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

  function appendMessage(type, identifier, text, extras = {}) {
    setRooms((prev) => {
      const descriptor = roomDescriptor(type, identifier);
      const existing = prev[descriptor.id] || createRoom(type, identifier);
      const nextMessages = [...existing.messages, createMessage(text, extras)].slice(-HISTORY_LIMIT);
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

  function handlePhotoFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      setPhotoAttachment(null);
      setPhotoError("");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoAttachment(null);
      setPhotoError("Photo must be 3MB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        setPhotoAttachment(null);
        setPhotoError("Unable to read photo data.");
        return;
      }
      const commaIndex = result.indexOf(",");
      const base64 = commaIndex === -1 ? "" : result.slice(commaIndex + 1);
      if (!base64) {
        setPhotoAttachment(null);
        setPhotoError("Unable to encode photo.");
        return;
      }
      setPhotoAttachment({
        name: sanitizeFileName(file.name),
        mime: file.type || "image/png",
        data: base64,
        size: file.size,
      });
      setPhotoError("");
    };
    reader.onerror = () => {
      setPhotoAttachment(null);
      setPhotoError("Failed to read photo.");
    };
    reader.readAsDataURL(file);
  }

  function resetPhotoSelection() {
    setPhotoAttachment(null);
    setPhotoCaption("");
    setPhotoError("");
    if (photoInputRef.current) {
      photoInputRef.current.value = "";
    }
  }

  function handleSendPhoto(e) {
    e?.preventDefault();
    if (!photoAttachment) {
      setPhotoError("Select a photo first.");
      return;
    }
    const room = rooms[activeRoomId];
    if (!readyForChats || !room || room.type === "system" || !room.target) {
      appendMessage(
        "system",
        "system",
        "Open a private user (@nickname) or group (#group) room before sending a photo."
      );
      return;
    }
    const targetArg = room.type === "group" ? `#${room.target}` : `@${room.target}`;
    const caption = photoCaption.trim();
    const command = `/photo ${targetArg} ${photoAttachment.mime} ${photoAttachment.name} ${photoAttachment.data}${
      caption ? ` ${caption}` : ""
    }`;
    if (!sendRaw(command)) {
      setPhotoError("Connection not ready. Photo not sent.");
      return;
    }
    resetPhotoSelection();
  }

  function requestDeleteMessage(messageId) {
    if (!messageId) {
      return;
    }
    if (!sendRaw(`/delete ${messageId}`)) {
      appendMessage("system", "system", "Unable to send delete command (connection not ready).");
    }
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

  function handlePhotoEvent(payload) {
    if (!payload || typeof payload !== "object") {
      appendMessage("system", "system", "[warn] Received malformed photo payload.");
      return;
    }
    if (!payload.mime || !payload.data) {
      appendMessage("system", "system", "[warn] Photo payload missing mime or data.");
      return;
    }
    const roomType = payload.kind === "group" ? "group" : "private";
    let identifier;
    if (roomType === "group") {
      identifier = payload.group;
    } else if (payload.sender === nickname) {
      identifier = payload.target || payload.sender;
    } else {
      identifier = payload.sender || payload.target;
    }
    if (!identifier) {
      appendMessage("system", "system", "[warn] Photo payload missing target.");
      return;
    }
    const captionText = payload.caption?.trim();
    let lineText;
    if (roomType === "group") {
      lineText = `${payload.sender}: ${captionText || "sent a photo."}`;
    } else if (payload.sender === nickname && payload.target) {
      lineText = `(you -> ${payload.target}) ${captionText || "sent a photo."}`;
    } else if (payload.sender === nickname) {
      lineText = `(you) ${captionText || "sent a photo."}`;
    } else {
      lineText = `${payload.sender}: ${captionText || "sent a photo."}`;
    }
    appendMessage(roomType, identifier, lineText, {
      media: {
        kind: "photo",
        mime: payload.mime,
        name: payload.name || "photo",
        data: payload.data,
        size: payload.size || 0,
      },
      sender: payload.sender,
      caption: captionText,
      timestamp: payload.timestamp || Date.now(),
      photo: true,
      id: payload.id,
      deleted: payload.deleted,
    });
  }

  function handleDeleteEvent(payload) {
    if (!payload || typeof payload !== "object") {
      appendMessage("system", "system", "[warn] Received malformed delete payload.");
      return;
    }
    const messageId = Number(payload.id);
    if (!messageId) {
      appendMessage("system", "system", "[warn] Delete payload missing id.");
      return;
    }
    const roomType = payload.type === "group" ? "group" : "private";
    let identifier;
    if (roomType === "group") {
      identifier = payload.group;
    } else if (payload.sender === nickname) {
      identifier = payload.target || payload.sender;
    } else if (payload.target === nickname) {
      identifier = payload.sender;
    } else {
      identifier = payload.sender || payload.target;
    }
    if (!identifier) {
      appendMessage("system", "system", `[warn] Delete event for #${messageId} missing room info.`);
      return;
    }
    const descriptor = roomDescriptor(roomType, identifier);
    ensureRoom(roomType, identifier);
    let updated = false;
    setRooms((prev) => {
      const room = prev[descriptor.id];
      if (!room) {
        return prev;
      }
      let changed = false;
      const nextMessages = room.messages.map((msg) => {
        if (msg?.id === messageId && !msg.deleted) {
          changed = true;
          return { ...msg, text: "[deleted]", media: undefined, deleted: true };
        }
        return msg;
      });
      if (!changed) {
        return prev;
      }
      updated = true;
      return {
        ...prev,
        [descriptor.id]: { ...room, messages: nextMessages },
      };
    });
    if (!updated) {
      appendMessage(roomType, identifier, `[info] Message #${messageId} deleted by ${payload.by || "sender"}.`);
    }
  }

  function routeServerLine(line) {
    if (!line.trim()) {
      return;
    }
    if (line.startsWith("PHOTO ")) {
      try {
        const payload = JSON.parse(line.slice(6));
        handlePhotoEvent(payload);
      } catch {
        appendMessage("system", "system", "[warn] Failed to parse incoming photo.");
      }
      return;
    }
    if (line.startsWith("DELETE ")) {
      try {
        const payload = JSON.parse(line.slice(7));
        handleDeleteEvent(payload);
      } catch {
        appendMessage("system", "system", "[warn] Failed to parse delete event.");
      }
      return;
    }
    handleUserMetadata(line);
    handleGroupMetadata(line);

    const privateIncoming = line.match(/^\[PM(?:#(\d+))?\]\s+([^:]+):\s*(.*)$/);
    if (privateIncoming) {
      const [, idRaw, sender, body] = privateIncoming;
      appendMessage("private", sender, `${sender}: ${body}`, {
        id: idRaw ? Number(idRaw) : undefined,
        sender,
      });
      return;
    }
    const privateOutgoing = line.match(/^\[PM -> ([^\]\s]+)(?:\s+#(\d+))?\]\s*(.*)$/);
    if (privateOutgoing) {
      const [, target, idRaw, body] = privateOutgoing;
      appendMessage("private", target, `(you): ${body}`, {
        id: idRaw ? Number(idRaw) : undefined,
        sender: nickname,
      });
      return;
    }
    const groupMatch = line.match(/^\[Group:([^\]#]+)(?:\s*#(\d+))?\]\s+(.*)$/);
    if (groupMatch) {
      const [, groupName, idRaw, rest] = groupMatch;
      const colonIndex = rest.indexOf(":");
      let speaker;
      if (rest.startsWith("(you):")) {
        speaker = nickname;
      } else if (colonIndex !== -1) {
        speaker = rest.slice(0, colonIndex).trim();
      }
      const displayText = rest.trim();
      appendMessage("group", groupName, displayText, {
        id: idRaw ? Number(idRaw) : undefined,
        sender: speaker,
      });
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
    resetPhotoSelection();
    setReconnectKey((key) => key + 1);
  }

  if (!readyForChats) {
    return (
      <div className="entry-screen">
        <div className="entry-card">
          <div className="entry-hero">
            <img src={ENTRY_ART} alt="Colorful chat illustration" />
            <span className="entry-hero__badge">Seabreeze</span>
          </div>
          <h2>Create Avatar</h2>
          <p className="muted small">Pick a nickname to join the chat.</p>
          <div className="entry-status">
            <span>Status: {connectionStatus}</span>
            {(connectionStatus === "closed" || connectionStatus === "error") && (
              <button type="button" onClick={handleReconnect}>
                Reconnect
              </button>
            )}
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
            {(activeRoom?.messages ?? []).map((entry, idx) => {
              const message = typeof entry === "string" ? { text: entry } : entry;
              const label = formatTimestamp(message.timestamp);
              const isPhoto = message.media?.kind === "photo";
              const isDeleted = message.deleted;
              const showPhoto = isPhoto && !isDeleted;
              const canDelete = !isDeleted && message.id && message.sender === nickname;
              return (
                <div
                  key={`${activeRoom?.id}-${idx}`}
                  className={`line${isPhoto ? " photo-line" : ""}`}
                >
                  {label && <span className="timestamp">{label}</span>}
                  <div className="message-text">
                    <div className="message-header">
                      <span>{isDeleted ? "[deleted]" : message.text}</span>
                      {canDelete && (
                        <button
                          type="button"
                          className="delete-btn"
                          onClick={() => requestDeleteMessage(message.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                    {showPhoto && (
                      <div className="photo-bubble">
                        <img
                          src={`data:${message.media.mime};base64,${message.media.data}`}
                          alt={message.media.name || "photo"}
                        />
                        <div className="muted small">
                          {`${message.media.name || "image"} · ${formatBytes(
                            message.media.size || 0
                          )}`}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
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
          <div className="photo-tools">
            <input
              type="file"
              accept="image/*"
              ref={photoInputRef}
              onChange={handlePhotoFileChange}
            />
            <input
              className="photo-caption"
              value={photoCaption}
              onChange={(e) => setPhotoCaption(e.target.value)}
              placeholder="Photo caption (optional)"
            />
            <button
              type="button"
              onClick={handleSendPhoto}
              disabled={!photoAttachment || !readyForChats}
            >
              Send Photo
            </button>
            {photoAttachment && (
              <button type="button" className="pill-btn ghost" onClick={resetPhotoSelection}>
                Clear
              </button>
            )}
          </div>
          {photoAttachment && (
            <p className="muted small">
              Ready: {photoAttachment.name} · {formatBytes(photoAttachment.size)}
            </p>
          )}
          {photoError && (
            <p className="error small" role="alert">
              {photoError}
            </p>
          )}
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
