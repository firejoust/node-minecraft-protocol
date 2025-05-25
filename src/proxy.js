"use strict";

const EventEmitter = require("events").EventEmitter;
const createClient = require("./createClient");
const createServer = require("./createServer");
const states = require("./states");

class ProxyConnection extends EventEmitter {
  constructor(realClientConnection, proxyServerInstance) {
    super();
    this.realClientConnection = realClientConnection;
    this.proxyServer = proxyServerInstance;
    this.options = proxyServerInstance.options;
    this.mcData = proxyServerInstance.mcData;

    this.targetClient = null;
    this.targetClientConnected = false;
    this.targetClientReadyForPlay = false;

    this._ended = false;
    this._endReason = "";
    this._endOrigin = "";

    this.username = null;
    this.uuid = null;

    this.realClientCompressed = false;
    this.targetClientCompressed = false;

    this.hookRealClient();
  }

  hookRealClient() {
    const realClient = this.realClientConnection;

    realClient.on("packet", (data, meta) => {
      if (this._ended || (this.targetClient && this.targetClient.ended)) return; // Don't process if ending or target is gone

      if (!this.targetClient || !this.targetClientConnected) {
        if (meta.state === states.HANDSHAKING || (meta.state === states.LOGIN && meta.name === 'login_start')) {
          return;
        }
        return;
      }

      if (meta.state === states.LOGIN && meta.name === "login_acknowledged") {
        if (this.targetClient.state === states.LOGIN && !this.targetClient.ended) {
          this.targetClient.write("login_acknowledged", data);
        }
        return;
      }

      if (meta.state === states.CONFIGURATION && meta.name === "finish_configuration") {
        if (this.targetClient.state === states.CONFIGURATION && !this.targetClient.ended) {
          this.targetClient.write("finish_configuration", data);
        }
        return;
      }

      if (
        this.targetClientReadyForPlay ||
        meta.state === this.targetClient.state ||
        (this.targetClient.state === states.LOGIN && (meta.name === "encryption_begin" || meta.name === "login_plugin_response")) ||
        (this.targetClient.state === states.CONFIGURATION && (meta.name === "client_information" || meta.name === "custom_payload" || meta.name === "select_known_packs"))
      ) {
        this.handlePacket(data, meta, "serverBound", realClient, this.targetClient);
      }
    });

    realClient.on("end", (reason) => this.end(`Real client disconnected: ${reason}`, "realClient"));
    realClient.on("error", (err) => {
      if (err.code === 'ECONNRESET' && this._ended) return; // Ignore reset if we already initiated end
      this.emit("error", err, "realClient");
      this.end(`Real client error: ${err.message}`, "realClient", err);
    });
  }

  initiateTargetConnection(realClientUsername, realClientUuid) {
    if (this.targetClient || this._ended) return;

    this.username = realClientUsername;
    this.uuid = realClientUuid;

    this.targetClient = createClient({
      host: this.options.targetHost,
      port: this.options.targetPort,
      username: this.username,
      version: this.options.version,
      keepAlive: this.options.keepAlive || false,
      auth: "offline",
      hideErrors: this.options.hideErrors || false,
      skipValidation: true,
    });

    this.targetClient.on("connect", () => {
      if (this._ended) { // Connection might have ended while targetClient was connecting
          if (!this.targetClient.ended) this.targetClient.end('Proxy connection ended during target connect');
          return;
      }
      this.targetClientConnected = true;
      const loginStartParams = {
        username: this.username,
        playerUUID: this.uuid,
      };
      if (this.mcData.supportFeature("profileKeySignatureV2")) {
        loginStartParams.signature = null;
      } else if (this.mcData.supportFeature("signedLogin")) {
        loginStartParams.publicKey = null;
      }
      if (!this.targetClient.ended) this.targetClient.write("login_start", loginStartParams);
    });

    this.targetClient.on("packet", (data, meta) => {
      if (this._ended || (this.realClientConnection && this.realClientConnection.ended)) return; // Don't process if ending or real client is gone
      this.handlePacket(data, meta, "clientBound", this.targetClient, this.realClientConnection);
    });

    this.targetClient.on("state", (newState, oldState) => {
      if (this._ended) return;
      if (newState === states.PLAY && oldState !== states.PLAY) {
        this.targetClientReadyForPlay = true;
      }
    });

    this.targetClient.on("end", (reason) => this.end(`Target client disconnected: ${reason}`, "targetClient"));
    this.targetClient.on("error", (err) => {
      if (err.code === 'ECONNRESET' && this._ended) return; // Ignore reset if we already initiated end
      this.emit("error", err, "targetClient");
      this.end(`Target client error: ${err.message}`, "targetClient", err);
    });
  }

  handlePacket(data, meta, direction, source, destination) {
    if (this._ended || !destination || destination.ended) return; // Crucial check

    let dropped = false;
    let modifiedPacket = null;

    const drop = () => { dropped = true; };
    const modify = (newPacket) => { modifiedPacket = newPacket; };

    const packetDataForEvent = {
      name: meta.name,
      params: data,
      meta,
      direction,
      buffer: meta.buffer,
    };
    this.emit(direction, packetDataForEvent, drop, modify);

    if (dropped) return;

    const packetToSend = modifiedPacket || { name: meta.name, params: data };

    if (direction === "clientBound" && source === this.targetClient) {
      if (packetToSend.name === "login_success") {
        this.username = packetToSend.params.username;
        this.uuid = packetToSend.params.uuid;
        if (this.realClientConnection.finishLoginPromiseResolve) {
          this.realClientConnection.finishLoginPromiseResolve();
          delete this.realClientConnection.finishLoginPromiseResolve;
        }
        return;
      }

      if (packetToSend.name === "set_compression") {
        if (!this.targetClient.ended) this.targetClient.compressionThreshold = packetToSend.params.threshold;
        this.targetClientCompressed = packetToSend.params.threshold >= 0;
        if (this.realClientConnection.state === states.LOGIN && !this.realClientConnection.ended) {
          this.realClientConnection.write('set_compression', { threshold: packetToSend.params.threshold });
          this.realClientConnection.compressionThreshold = packetToSend.params.threshold;
          this.realClientCompressed = packetToSend.params.threshold >= 0;
        }
        return;
      }

      if (this.mcData.supportFeature("hasConfigurationState") && packetToSend.name === "finish_configuration") {
        if (this.realClientConnection.state === states.CONFIGURATION && !this.realClientConnection.ended) {
          this.realClientConnection.write("finish_configuration", {});
        }
        return;
      }
    }

    // General Relaying
    // Check destination.ended again right before writing
    if (destination && !destination.ended) {
      if (destination.state === meta.state ||
          (direction === "clientBound" && destination.state === states.CONFIGURATION && meta.state === states.PLAY) ||
          (direction === "clientBound" && destination.state === states.LOGIN && meta.state === states.LOGIN)
         ) {
        destination.write(packetToSend.name, packetToSend.params);
      } else {
        // console.warn(`[Proxy Relay] State mismatch. Packet: ${meta.state}.${packetToSend.name}, Dest (${destination === this.targetClient ? 'Target' : 'Real'}) State: ${destination.state}. Packet dropped.`);
      }
    }
  }

  end(reason, origin, error = null) {
    if (this._ended) return;
    this._ended = true; // Set this flag first
    this._endReason = reason;
    this._endOrigin = origin;

    // console.log(`[ProxyConnection] Ending. Origin: ${origin}, Reason: ${reason}`);
    // if (error) console.error(`[ProxyConnection] Associated error:`, error);


    // Attempt to gracefully end the other connection if it's not the one that caused the end
    // And if it hasn't already ended.
    if (origin !== "realClient" && this.realClientConnection && !this.realClientConnection.ended) {
      // console.log(`[ProxyConnection] Ending realClientConnection.`);
      this.realClientConnection.end(reason);
    }
    if (origin !== "targetClient" && this.targetClient && !this.targetClient.ended) {
      // console.log(`[ProxyConnection] Ending targetClient.`);
      this.targetClient.end(reason);
    }

    this.emit("end", reason, origin, error);
    this.removeAllListeners(); // Clean up listeners to prevent memory leaks
  }
}

class Proxy extends EventEmitter {
  constructor(options) {
    super();
    this.options = {
      keepAlive: false,
      hideErrors: false,
      ...options,
      "online-mode": false,
    };

    if (!this.options.version) {
      throw new Error('Proxy requires a "version" option to be set.');
    }
    if (!this.options.targetHost || !this.options.targetPort) {
      throw new Error('Proxy requires "targetHost" and "targetPort" options.');
    }

    this.mcData = require("minecraft-data")(this.options.version);
    if (!this.mcData) {
      throw new Error(`Unsupported Minecraft version for proxy: ${this.options.version}`);
    }

    this.server = createServer({
      version: this.options.version,
      port: this.options.port,
      host: this.options.host,
      "online-mode": false,
      keepAlive: this.options.keepAlive,
      hideErrors: this.options.hideErrors,
      beforeLogin: (client) => {
        return new Promise((resolve) => {
          client.finishLoginPromiseResolve = resolve;
        });
      },
    });

    this.connections = new Set();

    this.server.on("listening", () => this.emit("listening"));
    this.server.on("error", (err) => this.emit("error", err));
    this.server.on("close", () => this.emit("close"));

    this.server.on("login", (loggedInRealClient) => {
      const proxyConnection = Array.from(this.connections).find(
        (conn) => conn.realClientConnection === loggedInRealClient
      );

      if (proxyConnection) {
        if (proxyConnection._ended) { // If connection ended before login completed
            console.warn("[Proxy] ProxyConnection ended before target initiation for client:", loggedInRealClient.username);
            if (!loggedInRealClient.ended) loggedInRealClient.end("Proxy connection closed prematurely");
            return;
        }
        proxyConnection.initiateTargetConnection(loggedInRealClient.username, loggedInRealClient.uuid);
        this.emit("login", proxyConnection, { username: loggedInRealClient.username, uuid: loggedInRealClient.uuid });
      } else {
        console.warn("[Proxy] Critical: Could not find ProxyConnection for a client that completed login with the proxy server. Client will be disconnected.");
        if (!loggedInRealClient.ended) loggedInRealClient.end("Proxy internal error: Connection tracking failed.");
      }
    });

    this.server.on("connection", (realClient) => {
       if (this.server.socketServer === null || !this.server.socketServer.listening) {
        // Server is shutting down or not ready
        if (!realClient.ended) realClient.end("Proxy server not available");
        return;
      }
      const proxyConnection = new ProxyConnection(realClient, this);
      this.connections.add(proxyConnection);
      this.emit("connection", proxyConnection);

      proxyConnection.on("end", (reason, origin, error) => {
        this.connections.delete(proxyConnection);
      });
    });
  }

  close() {
    // console.log("[Proxy] Closing proxy server...");
    if (this.server) {
        this.server.close(); // This should trigger 'end' on realClients
    }
    for (const conn of this.connections) {
      if (!conn._ended) { // Check if not already ended
        conn.end("Proxy shutting down", "proxy");
      }
    }
    this.connections.clear();
    // console.log("[Proxy] Proxy server closed.");
  }
}

module.exports = Proxy;