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
};
const nodeInfoByNumber = new Map();

function getSelf() {
  const hasNodeInfo = nodeState.myNodeInfo !== null;

  return {
    connected: activeDevice !== null && connectionStatus !== "disconnected",
    connecting,
    port: selectedPort,
    status: connectionStatus,
    node: hasNodeInfo ? nodeState : null,
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
}

async function connectToDevice(path) {
  if (connecting || activeDevice !== null) {
    throw new ApiError(409, "A serial device is already connecting or connected");
  }

  connecting = true;
  selectedPort = path;
  connectionStatus = "connecting";
  nodeState = { myNodeInfo: null, nodeInfo: null, deviceMetadata: null };
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
    nodeState = { myNodeInfo: null, nodeInfo: null, deviceMetadata: null };
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

async function handleRequest(request, response) {
  applyCors(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
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
