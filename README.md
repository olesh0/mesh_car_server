# Meshtastic Serial API

Start the API with `npm start`. It listens on `http://127.0.0.1:3000` by default.
The node snapshot is kept in memory while the server is running.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/devices` | List available serial devices for the frontend to display |
| `POST` | `/connect` | Connect to the selected device with `{"path":"COM3"}` |
| `GET` | `/self` | Read connection status and the latest information received for this node |
| `POST` | `/disconnect` | Disconnect the active device |

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
or disconnect, and refreshes node information automatically.
