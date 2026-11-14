import { useCallback, useEffect, useMemo, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";
const SELF_POLL_INTERVAL = 2500;

async function apiRequest(path, options) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, options);
  } catch {
    throw new Error(`Cannot reach the API at ${API_URL}. Is the server running?`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The API returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(data.error ?? `Request failed with status ${response.status}.`);
  }

  return data;
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") {
    return "Not reported";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatLastHeard(value) {
  if (!value) {
    return "Not reported";
  }
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? displayValue(value) : date.toLocaleString();
}

function formatCoordinates(position) {
  if (
    typeof position?.latitudeI !== "number" ||
    typeof position?.longitudeI !== "number"
  ) {
    return "Not reported";
  }
  return `${(position.latitudeI / 1e7).toFixed(5)}, ${(position.longitudeI / 1e7).toFixed(5)}`;
}

function DeviceDetails({ node }) {
  const myNodeInfo = node.myNodeInfo ?? {};
  const nodeInfo = node.nodeInfo ?? {};
  const user = nodeInfo.user ?? {};
  const metadata = node.deviceMetadata ?? {};
  const displayName = user.longName || "Meshtastic node";

  const details = [
    { label: "Node number", value: myNodeInfo.myNodeNum ?? nodeInfo.num },
    { label: "Short name", value: user.shortName },
    { label: "Hardware model", value: user.hwModel },
    { label: "Firmware", value: metadata.firmwareVersion },
    { label: "Reboot count", value: myNodeInfo.rebootCount },
    { label: "Last heard", value: formatLastHeard(nodeInfo.lastHeard) },
    { label: "Position", value: formatCoordinates(nodeInfo.position) },
  ];

  return (
    <section className="panel node-panel" aria-labelledby="node-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">YOUR DEVICE</p>
          <h2 id="node-heading">{displayName}</h2>
        </div>
        {user.shortName && <span className="node-short-name">{user.shortName}</span>}
      </div>

      <div className="details-grid">
        {details.map(({ label, value }) => (
          <div className="detail-item" key={label}>
            <span className="detail-label">{label}</span>
            <span className="detail-value">{displayValue(value)}</span>
          </div>
        ))}
      </div>

      <details className="raw-details">
        <summary>Raw node data</summary>
        <pre>{JSON.stringify(node, null, 2)}</pre>
      </details>
    </section>
  );
}

function ChannelsPanel({ channels, connected }) {
  return (
    <section className="panel supporting-panel" aria-labelledby="channels-heading">
      <div className="supporting-heading">
        <div>
          <p className="eyebrow">NETWORK</p>
          <h2 id="channels-heading">Mesh channels</h2>
        </div>
        <span className="channel-count">{channels.length}</span>
      </div>

      {channels.length > 0 ? (
        <ul className="channel-list">
          {channels.map((channel) => (
            <li className="channel-item" key={channel.index}>
              <span className="channel-index">
                {String(channel.index).padStart(2, "0")}
              </span>
              <span className="channel-copy">
                <strong>{channel.name || `Channel ${channel.index}`}</strong>
                <span>{channel.roleName || "Unknown role"}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="supporting-empty">
          {connected
            ? "Channel details will appear after the node finishes configuring."
            : "Connect a serial device to load this node's channels."}
        </p>
      )}
    </section>
  );
}

function AdditionalDataPanel() {
  return (
    <section className="panel supporting-panel future-panel" aria-labelledby="future-heading">
      <div className="supporting-heading">
        <div>
          <p className="eyebrow">EXTENSIBLE</p>
          <h2 id="future-heading">Additional data</h2>
        </div>
        <span className="future-badge">FUTURE</span>
      </div>
      <div className="future-placeholder">
        <span className="future-mark" aria-hidden="true">+</span>
        <p>Reserved for more node telemetry and tools.</p>
      </div>
    </section>
  );
}

const beaconFieldOptions = [
  { key: "name", label: "Node name" },
  { key: "id", label: "Node ID" },
  { key: "hardware", label: "Hardware" },
  { key: "firmware", label: "Firmware" },
];

const beaconIntervalOptions = [
  { value: 1, label: "Every minute" },
  { value: 5, label: "Every 5 minutes" },
  { value: 15, label: "Every 15 minutes" },
  { value: 30, label: "Every 30 minutes" },
];

function BeaconPanel({
  channels,
  activeBeacon,
  connected,
  hasNodeInfo,
  channelIndex,
  intervalMinutes,
  include,
  busy,
  onChannelChange,
  onIntervalChange,
  onIncludeChange,
  onStart,
  onStop,
}) {
  const activeChannel = channels.find(
    (channel) => channel.index === activeBeacon.channelIndex,
  );
  const hasIncludedFields = beaconFieldOptions.some(({ key }) => include[key]);

  return (
    <section className="panel supporting-panel beacon-panel" aria-labelledby="beacon-heading">
      <div className="supporting-heading">
        <div>
          <p className="eyebrow">ANNOUNCEMENTS</p>
          <h2 id="beacon-heading">Node beacon</h2>
        </div>
        <span className={`beacon-state ${activeBeacon.active ? "is-active" : ""}`}>
          <span className="indicator-dot" />
          {activeBeacon.active ? "Active" : "Stopped"}
        </span>
      </div>

      <p className="beacon-description">
        Broadcast a node summary now, then repeat on the selected channel and interval.
      </p>

      <div className="beacon-selects">
        <label className="beacon-field">
          <span className="field-label">Mesh channel</span>
          <select
            value={activeBeacon.active ? String(activeBeacon.channelIndex) : channelIndex}
            onChange={(event) => onChannelChange(event.target.value)}
            disabled={activeBeacon.active || busy || channels.length === 0}
          >
            {channels.length === 0 ? (
              <option value="">No enabled channels</option>
            ) : (
              channels.map((channel) => (
                <option value={String(channel.index)} key={channel.index}>
                  {channel.name || `Channel ${channel.index}`} · {channel.roleName}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="beacon-field">
          <span className="field-label">Repeat interval</span>
          <select
            value={String(activeBeacon.active ? activeBeacon.intervalMinutes : intervalMinutes)}
            onChange={(event) => onIntervalChange(Number(event.target.value))}
            disabled={activeBeacon.active || busy}
          >
            {beaconIntervalOptions.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="beacon-fields" disabled={activeBeacon.active || busy}>
        <legend>Include in beacon</legend>
        {beaconFieldOptions.map(({ key, label }) => (
          <label className="beacon-checkbox" key={key}>
            <input
              type="checkbox"
              checked={include[key]}
              onChange={(event) => onIncludeChange(key, event.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      <div className="beacon-actions">
        {activeBeacon.active ? (
          <button
            className="button button-danger"
            onClick={onStop}
            disabled={busy}
            type="button"
          >
            {busy ? "Stopping…" : "Stop beaconing"}
          </button>
        ) : (
          <button
            className="button button-primary"
            onClick={onStart}
            disabled={
              !connected || !hasNodeInfo || !channelIndex || !hasIncludedFields || busy
            }
            type="button"
          >
            {busy ? "Starting…" : "Start beaconing"}
          </button>
        )}
        {activeBeacon.active && activeChannel && (
          <span className="beacon-active-channel">
            {activeChannel.name || `Channel ${activeChannel.index}`}
          </span>
        )}
      </div>

      {activeBeacon.lastSentAt && (
        <p className="beacon-last-sent">
          Last sent {new Date(activeBeacon.lastSentAt).toLocaleTimeString()}
        </p>
      )}
      {activeBeacon.lastMessage && (
        <p className="beacon-message">{activeBeacon.lastMessage}</p>
      )}
      {activeBeacon.lastError && (
        <p className="beacon-error" role="status">{activeBeacon.lastError}</p>
      )}
    </section>
  );
}

export default function App() {
  const [devices, setDevices] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [self, setSelf] = useState(null);
  const [apiOnline, setApiOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [beaconBusy, setBeaconBusy] = useState(false);
  const [beaconChannelIndex, setBeaconChannelIndex] = useState("");
  const [beaconIntervalMinutes, setBeaconIntervalMinutes] = useState(1);
  const [beaconInclude, setBeaconInclude] = useState({
    name: true,
    id: true,
    hardware: true,
    firmware: true,
  });
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  const refreshDevices = useCallback(async () => {
    setRefreshingDevices(true);
    try {
      const result = await apiRequest("/devices");
      setDevices(result.devices);
      setSelectedPath((currentPath) => {
        if (result.devices.some((device) => device.path === currentPath)) {
          return currentPath;
        }
        return result.devices[0]?.path ?? "";
      });
      setApiOnline(true);
      setError("");
    } catch (requestError) {
      setApiOnline(false);
      setError(requestError.message);
    } finally {
      setRefreshingDevices(false);
    }
  }, []);

  const refreshSelf = useCallback(async () => {
    try {
      const result = await apiRequest("/self");
      setSelf(result);
      setApiOnline(true);
      setLastUpdated(new Date());
    } catch (requestError) {
      setApiOnline(false);
      setError(requestError.message);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    let active = true;
    let timer;

    const pollSelf = async () => {
      try {
        const result = await apiRequest("/self");
        if (active) {
          setSelf(result);
          setApiOnline(true);
          setLastUpdated(new Date());
        }
      } catch (requestError) {
        if (active) {
          setApiOnline(false);
          setError(requestError.message);
        }
      } finally {
        if (active) {
          timer = window.setTimeout(pollSelf, SELF_POLL_INTERVAL);
        }
      }
    };

    void pollSelf();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const statusLabel = self?.status ?? "waiting for API";
  const node = self?.node;
  const channels = node?.channels ?? [];
  const beaconChannels = channels.filter((channel) => channel.role !== 0);
  const activeBeacon = self?.beacon ?? { active: false, channelIndex: null };

  useEffect(() => {
    if (activeBeacon.active) {
      return;
    }
    setBeaconChannelIndex((currentIndex) => {
      if (beaconChannels.some((channel) => String(channel.index) === currentIndex)) {
        return currentIndex;
      }
      return beaconChannels.length > 0 ? String(beaconChannels[0].index) : "";
    });
  }, [beaconChannels, activeBeacon.active]);

  useEffect(() => {
    if (!activeBeacon.active) {
      return;
    }
    setBeaconChannelIndex(String(activeBeacon.channelIndex));
    setBeaconIntervalMinutes(activeBeacon.intervalMinutes);
    setBeaconInclude((currentInclude) => {
      const activeInclude = activeBeacon.include ?? {};
      if (
        beaconFieldOptions.every(
          ({ key }) => currentInclude[key] === Boolean(activeInclude[key]),
        )
      ) {
        return currentInclude;
      }
      return Object.fromEntries(
        beaconFieldOptions.map(({ key }) => [key, Boolean(activeInclude[key])]),
      );
    });
  }, [
    activeBeacon.active,
    activeBeacon.channelIndex,
    activeBeacon.intervalMinutes,
    activeBeacon.include?.firmware,
    activeBeacon.include?.hardware,
    activeBeacon.include?.id,
    activeBeacon.include?.name,
  ]);

  const statusClass = useMemo(() => {
    if (self?.connected) {
      return "is-connected";
    }
    if (self?.connecting || ["connecting", "configuring"].includes(self?.status)) {
      return "is-pending";
    }
    return "is-disconnected";
  }, [self]);

  async function connect() {
    if (!selectedPath) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest("/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedPath }),
      });
      setSelf(result);
      await refreshSelf();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest("/disconnect", { method: "POST" });
      setSelf(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function startBeaconing() {
    setBeaconBusy(true);
    setError("");
    try {
      const result = await apiRequest("/beacon/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelIndex: Number(beaconChannelIndex),
          intervalMinutes: beaconIntervalMinutes,
          include: beaconInclude,
        }),
      });
      setSelf(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBeaconBusy(false);
    }
  }

  async function stopBeaconing() {
    setBeaconBusy(true);
    setError("");
    try {
      const result = await apiRequest("/beacon/stop", { method: "POST" });
      setSelf(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBeaconBusy(false);
    }
  }

  function updateBeaconField(field, enabled) {
    setBeaconInclude((currentInclude) => ({
      ...currentInclude,
      [field]: enabled,
    }));
  }

  const connected = Boolean(self?.connected);
  const connecting = Boolean(self?.connecting);
  const hasActivePort = Boolean(self?.port);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Mesh Node Console home">
          <span className="brand-mark">M</span>
          <span>
            <strong>MESH</strong>
            <small>NODE CONSOLE</small>
          </span>
        </a>
        <div className={`api-indicator ${apiOnline ? "is-online" : ""}`}>
          <span className="indicator-dot" />
          {apiOnline ? "API online" : "API offline"}
        </div>
      </header>

      <main className="dashboard">
        <section className="hero">
          <p className="eyebrow">LOCAL DEVICE MANAGER</p>
          <h1>Node dashboard</h1>
          <p className="hero-copy">
            Choose a serial device to connect, then view the information reported by your node.
          </p>
        </section>

        <section className="panel connection-panel" aria-labelledby="connection-heading">
          <div className="section-heading connection-heading">
            <div>
              <p className="eyebrow">CONNECTION</p>
              <h2 id="connection-heading">Serial device</h2>
            </div>
            <span className={`status-pill ${statusClass}`}>
              <span className="indicator-dot" />
              {statusLabel}
            </span>
          </div>

          <div className="connection-controls">
            <label className="device-field">
              <span className="field-label">Available devices</span>
              <select
                value={selectedPath}
                onChange={(event) => setSelectedPath(event.target.value)}
                disabled={hasActivePort || connecting || busy}
              >
                <option value="">Choose a serial device</option>
                {devices.map((device) => (
                  <option value={device.path} key={device.path}>
                    {device.friendlyName || device.path} — {device.path}
                  </option>
                ))}
              </select>
            </label>

            <button
              className="button button-secondary refresh-button"
              onClick={refreshDevices}
              disabled={refreshingDevices || busy || hasActivePort}
              type="button"
            >
              {refreshingDevices ? "Refreshing…" : "Refresh"}
            </button>

            {hasActivePort ? (
              <button
                className="button button-danger"
                onClick={disconnect}
                disabled={busy || connecting}
                type="button"
              >
                {connecting ? "Connecting…" : busy ? "Disconnecting…" : "Disconnect"}
              </button>
            ) : (
              <button
                className="button button-primary"
                onClick={connect}
                disabled={!selectedPath || busy || connecting || !apiOnline}
                type="button"
              >
                {busy || connecting ? "Connecting…" : "Connect"}
              </button>
            )}
          </div>

          <div className="connection-meta">
            <span>
              {self?.port ? `Selected port: ${self.port}` : `${devices.length} device${devices.length === 1 ? "" : "s"} found`}
            </span>
            {lastUpdated && (
              <span>Updated {lastUpdated.toLocaleTimeString()}</span>
            )}
          </div>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")} type="button" aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}

        {node ? (
          <DeviceDetails node={node} />
        ) : (
          <section className="panel empty-panel">
            <div className="empty-icon" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <h2>{connected ? "Waiting for node data" : "No node connected"}</h2>
            <p>
              {connected
                ? "The connection is open. Node details will appear here as soon as the device reports them."
                : "Choose one of the available serial devices above to start receiving node information."}
            </p>
          </section>
        )}

        <div className="supporting-grid">
          <ChannelsPanel
            channels={node?.channels ?? []}
            connected={Boolean(self?.connected)}
          />
          <BeaconPanel
            channels={beaconChannels}
            activeBeacon={activeBeacon}
            connected={connected}
            hasNodeInfo={Boolean(node?.myNodeInfo)}
            channelIndex={beaconChannelIndex}
            intervalMinutes={beaconIntervalMinutes}
            include={beaconInclude}
            busy={beaconBusy}
            onChannelChange={setBeaconChannelIndex}
            onIntervalChange={setBeaconIntervalMinutes}
            onIncludeChange={updateBeaconField}
            onStart={startBeaconing}
            onStop={stopBeaconing}
          />
          <AdditionalDataPanel />
        </div>

        <footer className="page-footer">
          <span>API</span>
          <code>{API_URL}</code>
          <span className="footer-separator">·</span>
          <span>Node data refreshes automatically</span>
        </footer>
      </main>
    </div>
  );
}
