# Meshtastic Serial API

Start the API with `npm start`. It listens on `http://127.0.0.1:3000` by default.
The node snapshot is kept in memory while the server is running.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/devices` | List available serial devices for the frontend to display |
| `POST` | `/connect` | Connect to the selected device with `{"path":"COM3"}` |
| `GET` | `/self` | Read connection status, node details, and mesh channels |
| `POST` | `/disconnect` | Disconnect the active device |
| `POST` | `/beacon/start` | Start recurring node beacons on a selected channel |
| `POST` | `/beacon/stop` | Stop recurring node beacons |

Starting beaconing immediately broadcasts the selected node details, then
repeats at the selected interval. Choose an enabled channel index from
`/self.node.channels`; supported intervals are 1, 5, 15, and 30 minutes. For
example:

```json
{
  "channelIndex": 0,
  "intervalMinutes": 1,
  "include": {
    "name": true,
    "id": true,
    "hardware": true,
    "firmware": true
  }
}
```

Only the selected channel is used. Channel data in `/self` includes names,
roles, and indexes, but not channel encryption keys. Beaconing stops when
explicitly stopped or when the node disconnects.

Example frontend flow:

```js
const { devices } = await fetch("http://127.0.0.1:3000/devices").then((response) =>
  response.json(),
);

await fetch("http://127.0.0.1:3000/connect", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: devices[0].path }),
});

const self = await fetch("http://127.0.0.1:3000/self").then((response) =>
  response.json(),
);
```

The API binds to localhost by default. Set `HOST`, `PORT`, or `FRONTEND_ORIGIN`
to change the bind address, port, or allowed frontend origin. The default CORS
origin is `http://localhost:5173`.

Import [`insomnia/mesh-server-api.json`](./insomnia/mesh-server-api.json) into
Insomnia to use the included API requests. Update `base_url` and `device_path`
in the Base Environment to match your server and selected serial device.

## Frontend

Start the API with `npm start` in the project root. In a separate terminal, run
`npm install` and `npm run dev` from the `frontend` directory, then open
`http://localhost:5173`. The dashboard lists serial devices, lets you connect
or disconnect, shows mesh channels, and refreshes node information
automatically. The node panel includes an explicit beacon action and a
configurable recurring beacon panel. Choose the channel, repeat interval, and
node details to include; the dashboard also reserves a panel for future data.

## Docker Compose

The Compose setup runs both the API and frontend. The API container needs the
serial device to be visible to Linux (for example, forward the USB device into
WSL2 first). From a WSL2 terminal, find its Linux path with
`ls /dev/ttyUSB* /dev/ttyACM*`, then create and edit `.env`:

```sh
cp .env.example .env
# Set SERIAL_DEVICE in .env to the path reported above.
docker compose up --build
```

Run Compose with a Linux Docker Engine that can access the forwarded device.
After startup, open `http://localhost:5173`; the API is available at
`http://127.0.0.1:3000`. Stop both containers with `docker compose down`. A
Windows `COM` path such as `COM3` is not a Linux device path and cannot be
mapped directly into these containers.
