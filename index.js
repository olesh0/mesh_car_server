import { createServer } from "node:http";
import { MeshDevice } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import { SerialPort } from "serialport";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";

const deviceStatuses = {
  1: "restarting",
  2: "disconnected",
  3: "connecting",
  4: "reconnecting",
  5: "connected",
  6: "configuring",
  7: "configured",
};
const beaconIntervals = [1, 5, 15, 30];
const beaconFieldNames = ["name", "id", "hardware", "firmware"];

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

let activeDevice = null;
let selectedPort = null;
let connectionStatus = "disconnected";
let connecting = false;
let nodeState = {
  myNodeInfo: null,
  nodeInfo: null,
  deviceMetadata: null,
  channels: [],
};
const nodeInfoByNumber = new Map();
let beaconTimer = null;
let beaconSending = false;
let beaconState = {
  active: false,
  channelIndex: null,
  intervalMinutes: 1,
  include: null,
  startedAt: null,
  lastSentAt: null,
  lastMessage: null,
  lastPacketId: null,
  lastError: null,
};

function getSelf() {
  const hasNodeData =
    nodeState.myNodeInfo !== null ||
    nodeState.nodeInfo !== null ||
    nodeState.deviceMetadata !== null ||
    nodeState.channels.length > 0;

  return {
    connected: activeDevice !== null && connectionStatus !== "disconnected",
    connecting,
    port: selectedPort,
    status: connectionStatus,
    node: hasNodeData ? nodeState : null,
    beacon: { ...beaconState, sending: beaconSending },
  };
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function applyCors(request, response) {
  response.setHeader("Vary", "Origin");
  if (request.headers.origin === frontendOrigin) {
    response.setHeader("Access-Control-Allow-Origin", frontendOrigin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

async function readJsonBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new ApiError(415, "Content-Type must be application/json");
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024) {
      throw new ApiError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
}

async function listDevices() {
  const ports = await SerialPort.list();
  const devices = ports.map(({ path, friendlyName, manufacturer, vendorId, productId }) => ({
    path,
    friendlyName,
    manufacturer,
    vendorId,
    productId,
  }));

  console.log("Available serial devices:", devices);
  return devices;
}

function subscribeToDevice(device) {
  device.events.onDeviceStatus.subscribe((status) => {
    connectionStatus = deviceStatuses[status] ?? "unknown";
    if (status === 2 && beaconState.active) {
      stopBeaconing("Beaconing stopped because the node disconnected.");
    }
  });

  device.events.onMyNodeInfo.subscribe((info) => {
    nodeState.myNodeInfo = info;
    nodeState.nodeInfo = nodeInfoByNumber.get(info.myNodeNum) ?? null;
  });

  device.events.onNodeInfoPacket.subscribe((info) => {
    nodeInfoByNumber.set(info.num, info);
    if (nodeState.myNodeInfo?.myNodeNum === info.num) {
      nodeState.nodeInfo = info;
    }
  });

  device.events.onDeviceMetadataPacket.subscribe((packet) => {
    nodeState.deviceMetadata = packet.data;
  });

  device.events.onChannelPacket.subscribe((channel) => {
    const settings = channel.settings ?? {};
    const channelInfo = {
      index: channel.index,
      name: settings.name || `Channel ${channel.index}`,
      role: channel.role,
      roleName: ["Disabled", "Primary", "Secondary"][channel.role] ?? "Unknown",
      uplinkEnabled: settings.uplinkEnabled,
      downlinkEnabled: settings.downlinkEnabled,
    };

    nodeState.channels = nodeState.channels
      .filter((currentChannel) => currentChannel.index !== channel.index)
      .concat(channelInfo)
      .sort((left, right) => left.index - right.index);
  });
}

async function connectToDevice(path) {
  if (connecting || activeDevice !== null) {
    throw new ApiError(409, "A serial device is already connecting or connected");
  }

  connecting = true;
  selectedPort = path;
  connectionStatus = "connecting";
  nodeState = { myNodeInfo: null, nodeInfo: null, deviceMetadata: null, channels: [] };
  nodeInfoByNumber.clear();

  let transport = null;
  let device = null;
  try {
    const devices = await SerialPort.list();
    if (!devices.some((availableDevice) => availableDevice.path === path)) {
      throw new ApiError(404, "The selected serial device is no longer available");
    }

    transport = await TransportNodeSerial.create(path);
    device = new MeshDevice(transport);
    activeDevice = device;
    subscribeToDevice(device);
    await device.configure();
    return getSelf();
  } catch (error) {
    activeDevice = null;
    selectedPort = null;
    connectionStatus = "disconnected";
    nodeState = { myNodeInfo: null, nodeInfo: null, deviceMetadata: null, channels: [] };
    nodeInfoByNumber.clear();

    const disconnect = device
      ? () => device.disconnect()
      : transport
        ? () => transport.disconnect()
        : null;
    if (disconnect) {
      try {
        await disconnect();
      } catch (cleanupError) {
        console.error("Failed to clean up the serial connection:", cleanupError);
      }
    }

    throw error;
  } finally {
    connecting = false;
  }
}

async function disconnectDevice() {
  if (connecting) {
    throw new ApiError(409, "A serial device is still connecting");
  }
  stopBeaconing();
  if (activeDevice === null) {
    return getSelf();
  }

  const device = activeDevice;
  connectionStatus = "disconnecting";
  try {
    await device.disconnect();
  } finally {
    activeDevice = null;
    selectedPort = null;
    connectionStatus = "disconnected";
  }

  return getSelf();
}

function beaconField(value, maxLength) {
  if (value === null || value === undefined) {
    return null;
  }

  const field = String(value).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(field).slice(0, maxLength).join("") || null;
}

function limitBeaconBytes(message, maxBytes) {
  let limitedMessage = "";
  for (const character of message) {
    if (Buffer.byteLength(limitedMessage + character, "utf8") > maxBytes) {
      break;
    }
    limitedMessage += character;
  }
  return limitedMessage;
}

function stopBeaconing(lastError = beaconState.lastError) {
  if (beaconTimer !== null) {
    clearInterval(beaconTimer);
    beaconTimer = null;
  }
  beaconState = { ...beaconState, active: false, lastError };
  return beaconState;
}

function validateBeaconConfig(body) {
  if (!Number.isInteger(body?.channelIndex)) {
    throw new ApiError(400, "A channel index must be selected");
  }
  if (
    !Number.isInteger(body?.intervalMinutes) ||
    !beaconIntervals.includes(body.intervalMinutes)
  ) {
    throw new ApiError(400, "Beacon interval must be 1, 5, 15, or 30 minutes");
  }

  const include = Object.fromEntries(
    beaconFieldNames.map((fieldName) => [fieldName, body.include?.[fieldName] === true]),
  );
  if (!Object.values(include).some(Boolean)) {
    throw new ApiError(400, "Select at least one node detail to beacon");
  }

  return {
    channelIndex: body.channelIndex,
    intervalMinutes: body.intervalMinutes,
    include,
  };
}

function buildBeaconMessage(include) {
  const user = nodeState.nodeInfo?.user ?? {};
  const values = [];
  if (include.name) {
    const name = beaconField(user.longName, 36);
    if (name) values.push(`Name ${name}`);
  }
  if (include.id) {
    const id = beaconField(nodeState.myNodeInfo?.myNodeNum, 16);
    if (id) values.push(`ID ${id}`);
  }
  if (include.hardware) {
    const hardware = beaconField(user.hwModel, 16);
    if (hardware) values.push(`HW ${hardware}`);
  }
  if (include.firmware) {
    const firmware = beaconField(nodeState.deviceMetadata?.firmwareVersion, 24);
    if (firmware) values.push(`FW ${firmware}`);
  }
  if (values.length === 0) {
    throw new ApiError(409, "The selected beacon details are not available yet");
  }

  return limitBeaconBytes(`Node: ${values.join(" | ")}`, 180);
}

async function sendBeaconPacket(config) {
  if (beaconSending) {
    return null;
  }
  if (activeDevice === null || connectionStatus === "disconnected") {
    throw new ApiError(409, "Connect to a node before beaconing");
  }
  if (nodeState.myNodeInfo === null) {
    throw new ApiError(409, "Node information has not been received yet");
  }
  if (!nodeState.channels.some((channel) => (
    channel.index === config.channelIndex && channel.role !== 0
  ))) {
    throw new ApiError(409, "The selected mesh channel is no longer available");
  }

  const message = buildBeaconMessage(config.include);
  beaconSending = true;
  try {
    const packetId = await activeDevice.sendText(
      message,
      "broadcast",
      false,
      config.channelIndex,
    );
    beaconState = {
      ...beaconState,
      lastSentAt: new Date().toISOString(),
      lastMessage: message,
      lastPacketId: packetId,
      lastError: null,
    };
    return { message, packetId };
  } catch (error) {
    console.error("Failed to send node beacon:", error);
    throw new ApiError(502, "Failed to send beacon on the selected channel");
  } finally {
    beaconSending = false;
  }
}

async function sendScheduledBeacon(config) {
  if (!beaconState.active) {
    return;
  }
  try {
    await sendBeaconPacket(config);
  } catch (error) {
    beaconState = { ...beaconState, lastError: error.message };
    console.error("Scheduled node beacon failed:", error);
    if (connectionStatus === "disconnected") {
      stopBeaconing("Beaconing stopped because the node disconnected.");
    }
  }
}

async function startBeaconing(body) {
  if (beaconState.active) {
    throw new ApiError(409, "Beaconing is already active");
  }
  if (activeDevice === null || connectionStatus === "disconnected") {
    throw new ApiError(409, "Connect to a node before beaconing");
  }
  if (nodeState.myNodeInfo === null) {
    throw new ApiError(409, "Node information has not been received yet");
  }

  const config = validateBeaconConfig(body);
  if (!nodeState.channels.some((channel) => (
    channel.index === config.channelIndex && channel.role !== 0
  ))) {
    throw new ApiError(400, "Choose an enabled mesh channel");
  }

  beaconState = {
    active: true,
    channelIndex: config.channelIndex,
    intervalMinutes: config.intervalMinutes,
    include: config.include,
    startedAt: new Date().toISOString(),
    lastSentAt: null,
    lastMessage: null,
    lastPacketId: null,
    lastError: null,
  };

  try {
    await sendBeaconPacket(config);
    beaconTimer = setInterval(
      () => void sendScheduledBeacon(config),
      config.intervalMinutes * 60 * 1000,
    );
    return getSelf();
  } catch (error) {
    stopBeaconing(error.message);
    throw error;
  }
}

async function handleRequest(request, response) {
  applyCors(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (
    request.method === "POST" &&
    request.headers.origin &&
    request.headers.origin !== frontendOrigin
  ) {
    throw new ApiError(403, "Origin not allowed");
  }

  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "GET" && pathname === "/devices") {
    sendJson(response, 200, { devices: await listDevices() });
    return;
  }

  if (request.method === "GET" && pathname === "/self") {
    sendJson(response, 200, getSelf());
    return;
  }

  if (request.method === "POST" && pathname === "/connect") {
    const body = await readJsonBody(request);
    if (typeof body?.path !== "string" || body.path.trim() === "") {
      throw new ApiError(400, "Request body must include a serial device path");
    }
    sendJson(response, 200, await connectToDevice(body.path));
    return;
  }

  if (request.method === "POST" && pathname === "/disconnect") {
    sendJson(response, 200, await disconnectDevice());
    return;
  }

  if (request.method === "POST" && pathname === "/beacon/start") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await startBeaconing(body));
    return;
  }

  if (request.method === "POST" && pathname === "/beacon/stop") {
    stopBeaconing();
    sendJson(response, 200, getSelf());
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (error instanceof ApiError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }

    console.error("API request failed:", error);
    sendJson(response, 500, { error: "Internal server error" });
  });
});

server.listen(port, host, () => {
  console.log(`Meshtastic API listening on http://${host}:${port}`);
});

server.on("error", (error) => {
  console.error("API server failed:", error);
  process.exitCode = 1;
});
