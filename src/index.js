import { Peer } from "peerjs";

const ERROR_PREFIX = "PlayPeer error: ";
const WARNING_PREFIX = "PlayPeer warning: ";

export default class PlayPeer {
    // Config properties
    id;
    #peer;
    #options;

    // Event callbacks stored in a map
    #callbacks = new Map();

    // Logic properties
    #storage = {};
    #isHost = false;
    #hostConnections = new Set(); // Host-side array containing all peers connected to current host, send out IDs to clients
    #hostConnectionsIdArray = []; // Client-side array to store the host's connections' IDs.
    #outgoingConnection;

    // Heartbeat variables
    #heartbeatSendInterval;
    #heartbeatReceiveInterval;
    #heartbeatReceived;

    /**
     * WebRTC Data Channels wrapper for handling multiplayer in games.
     * @constructor
     * @param {string} id - Unique id for signalling
     * @param {object} [options] - Peer options (ice config, host, port etc.)
     */
    constructor(id, options) {
        this.id = id;
        if (options) this.#options = options;
    }

    /** 
     * Register an event callback.
     * @param {string} event - Event name (e.g., "incomingPeerConnected", "outgoingPeerError")
     * @param {function} callback - Callback function to register 
     */
    onEvent(event, callback) {
        const validEvents = [
            "status",
            "error",
            "destroy",
            "storageUpdate",
            "incomingPeerConnected",
            "incomingPeerDisconnected",
            "incomingPeerError",
            "outgoingPeerConnected",
            "outgoingPeerDisconnected",
            "outgoingPeerError"
        ];

        if (!validEvents.includes(event)) return console.warn(WARNING_PREFIX + `Invalid event type "${event}" provided to onEvent.`);
        this.#callbacks.set(event, callback);
    }

    /**
     * Trigger event and invoke callback dynamically
     * @param {string} event - Event name
     * @param {...any} args - Arguments to pass to the callback
     * @private
     */
    #triggerEvent(event, ...args) {
        const callback = this.#callbacks.get(event);
        if (!callback) return;

        try {
            callback(...args);
        } catch (error) {
            console.error(ERROR_PREFIX + `${event} callback error:`, error);
        }
    }

    /**
     * Initialize new multiplayer object.
     * @async
     * @returns {Promise} Async Initialization promise.
    */
    async init() {
        return new Promise((resolve, reject) => {
            this.destroy(); // If peer already exists, destroy
            if (!this.id) console.warn(ERROR_PREFIX + "No id for the client provided!");
            this.#triggerEvent("status", "Initializing new instance...");

            try {
                this.#peer = new Peer(this.id, {
                    config: this.#options || {
                        'iceServers': [
                            { urls: "stun:stun.l.google.com:19302" }
                        ]
                    }
                });
            } catch (error) {
                console.error(ERROR_PREFIX + "Failed to initialize peer:", error);
                this.#triggerEvent("error", "Failed to initialize peer: " + error);
                reject("Failed to initialize peer.");
                return;
            }

            this.#setupPeerEventListeners(); // Attach regular peer event listeners
            this.#peer.on('connection', this.#handleIncomingConnections.bind(this)); // Attach host logic (on-connection listener)
            resolve();
        });
    }

    /**
     * Set up peer event listeners that refernece the own, internal peer
     * @private
     */
    #setupPeerEventListeners() {
        this.#peer.on('disconnected', () => {
            if (!this.#peer?.destroyed) {
                try {
                    this.#peer.reconnect();
                    console.warn(WARNING_PREFIX + "Disconnected from signalling server. Attempting to reconnect.");
                    this.#triggerEvent("status", "Disconnected from signalling server...");
                } catch (error) {
                    console.error(ERROR_PREFIX + "Failed to reconnect:", error);
                    this.#triggerEvent("error", "Failed to reconnect: " + error);
                }
            }
        });

        this.#peer.on('error', (error) => {
            if (error.type !== "network") {
                console.error(ERROR_PREFIX + "Fatal peer error:", error);
                this.#triggerEvent("error", "Fatal peer error: " + error);
            } else {
                console.error(ERROR_PREFIX + "Fatal network error:", error);
                this.#triggerEvent("error", "Fatal network error: " + error);
            }
            this.destroy();
        });

        this.#peer.on('close', () => {
            this.#triggerEvent("status", "Peer permanently closed.");
            console.error(ERROR_PREFIX + "Connection permanently closed.");
            this.destroy();
        });
    }

    /**
     * Handle incoming peer connections (Host code)
     * @private
     */
    #handleIncomingConnections(incomingConnection) {
        // Close broken connections that don't open or address the wrong host (delay ensures the close event triggers on peers)
        setTimeout(() => {
            if (!incomingConnection.open || !this.#isHost) {
                try {
                    incomingConnection.close();
                    this.#hostConnections.delete(incomingConnection);
                    console.warn(WARNING_PREFIX + `Connection ${incomingConnection.peer} closed - no response (or not host).`);
                } catch (error) {
                    console.error(WARNING_PREFIX + "Error closing invalid connection:", error);
                }
            }
        }, 1000);

        // Only process incoming connections if hosting
        if (this.#isHost) {
            this.#triggerEvent("status", "New peer connected.");
            this.#hostConnections.add(incomingConnection);

            this.#heartbeatSendInterval = setInterval(() => {
                if (this.#isHost) this.#broadcastMessage("heartbeat");
                if (!this.#isHost) clearInterval(this.#heartbeatSendInterval);
            }, 500);

            incomingConnection.on('open', () => {
                this.#triggerEvent("status", "Incoming connection opened.");
                this.#triggerEvent("incomingPeerConnected", incomingConnection.peer);

                // Sync host's connections with all peers
                const peerList = Array.from(this.#hostConnections).map((conn) => conn.peer);
                this.#broadcastMessage("peer_list", { peers: peerList });

                // Send current storage state to new peer
                try {
                    incomingConnection.send({ type: 'storage_sync', storage: this.#storage });
                } catch (error) {
                    console.error(WARNING_PREFIX + "Error sending initial storage sync:", error);
                    this.#triggerEvent("error", "Error sending initial storage sync: " + error);
                }
            });

            incomingConnection.on('data', (data) => {
                if (!data || !data?.type) return;

                switch (data.type) {
                    case 'storage_update':
                        // Storage updates, sent out by clients
                        if (this.#isHost) {
                            this.#setStorageLocally(data.key, data.value);
                            this.#broadcastMessage("storage_sync", { storage: this.#storage });
                        }
                        break;
                }
            });

            incomingConnection.on('close', () => {
                this.#hostConnections.delete(incomingConnection);
                this.#triggerEvent("incomingPeerDisconnected", incomingConnection.peer);
                this.#triggerEvent("status", "Incoming connection closed.");

                const peerList = Array.from(this.#hostConnections).map((conn) => conn.peer);
                this.#broadcastMessage("peer_list", { peers: peerList });
            });

            incomingConnection.on('error', (error) => {
                this.#triggerEvent("incomingPeerError", incomingConnection.peer);
                console.error(ERROR_PREFIX + `Connection ${incomingConnection.peer} error:`, error);
                this.#triggerEvent("error", "Error in incoming connection: " + error);
            });
        } else {
            console.warn(WARNING_PREFIX + "Incoming connection ignored as peer is not hosting.");
        }
    }

    /**
     * Create room and become host
     * @param {object} initialStorage Initial storage object
     * @returns {string} Peer id
     */
    createRoom(initialStorage = {}) {
        this.#isHost = true;
        this.#storage = initialStorage;
        return this.id;
    }

    /**
     * Join existing room (Client code)
     * @param {string} hostId Id of the host to connect to
     */
    async joinRoom(hostId) {
        return new Promise((resolve, reject) => {
            try {
                if (this.#isHost) console.warn(WARNING_PREFIX + "This instance was previously a host - reuse is discouraged.");
                this.#isHost = false;

                this.#outgoingConnection = this.#peer.connect(hostId, { reliable: true });
                this.#triggerEvent("status", "Attempting to connect to host...");

                // Connection timeout
                const timeout = setTimeout(() => {
                    if (this.#outgoingConnection) {
                        this.#outgoingConnection.close();
                        this.#outgoingConnection = null;
                    }
                    console.error(ERROR_PREFIX + "Connection attempt timed out.");
                    this.#triggerEvent("status", "Connection attempt timed out.");
                    reject(new Error("Connection attempt timed out."));
                }, 2000);

                const connectionOpened = false;

                this.#outgoingConnection.on("open", () => {
                    clearTimeout(timeout);
                    connectionOpened = true;
                    this.#triggerEvent("outgoingPeerConnected", hostId);
                    this.#triggerEvent("status", "Connection to host established.");

                    // Regularly check if heartbeats from host arrive
                    this.#heartbeatReceived = false;
                    this.#heartbeatReceiveInterval = setInterval(() => {
                        if (!this.#isHost) {
                            if (!this.#heartbeatReceived) {
                                console.warn(WARNING_PREFIX + "Host did not send heartbeat multiple times - disconnecting from host.");
                                this.#triggerEvent("status", "Host did not send heartbeat - disconnecting.");
                                this.#outgoingConnection.close();
                                return;
                            }
                            this.#heartbeatReceived = false; // Reset, so that heartbeat needs to be set by host again
                        } else {
                            clearInterval(this.#heartbeatReceiveInterval);
                        }
                    }, 750);

                    resolve();
                });

                this.#outgoingConnection.on('data', (data) => {
                    if (!data || !data?.type) return;
                    switch (data.type) {
                        case 'storage_sync':
                            this.#storage = data.storage;
                            this.#triggerEvent("storageUpdate", this.#storage);
                            break;
                        case 'peer_list':
                            this.#hostConnectionsIdArray = data.peers;
                            break;
                        case 'heartbeat':
                            this.#heartbeatReceived = true;
                            break;
                    }
                });

                this.#outgoingConnection.on('close', () => {
                    this.#triggerEvent("outgoingPeerDisconnected", hostId);
                    this.#triggerEvent("status", "Connection to host closed.");
                    if (connectionOpened) this.#migrateHost(); // Only migrate host if the connection was ever open
                });

                this.#outgoingConnection.on('error', (error) => {
                    clearTimeout(timeout);
                    this.#triggerEvent("outgoingPeerError", hostId);
                    console.error(ERROR_PREFIX + `Host connection error:`, error);
                    this.#triggerEvent("error", "Error in host connection: " + error);
                    reject(error);
                });
            } catch (error) {
                console.error(ERROR_PREFIX + "Error connecting to host:", error);
                this.#triggerEvent("error", "Error connecting to host: " + error);
                reject(error);
            }
        });
    }

    /**
     * Update storage with new value
     * @public
     * @param {string} key Storage key to update
     * @param {*} value New value
     */
    updateStorage(key, value) {
        if (this.#isHost) {
            this.#setStorageLocally(key, value);
            this.#broadcastMessage("storage_sync", { storage: this.#storage });
        } else {
            this.#outgoingConnection?.send({
                type: 'storage_update',
                key,
                value
            });
            // Optimistic update for non-host peers Ref: https://medium.com/@kyledeguzmanx/what-are-optimistic-updates-483662c3e171
            this.#setStorageLocally(key, value);
        }
    }

    /**
     * Update local storage and trigger callback
     * @private
     */
    #setStorageLocally(key, value) {
        this.#storage[key] = value;
        this.#triggerEvent("storageUpdate", this.#storage);
    }

    /**
     * Broadcast a message of a specific type to all peers. Used by host only.
     * @private
     * @param {string} type - Message type (e.g., "storage_sync", "peer_list")
     * @param {object} [payload] - Additional data to send
     */
    #broadcastMessage(type, payload = {}) {
        const message = { type, ...payload };
        this.#hostConnections.forEach((connection) => {
            if (connection.open) {
                try {
                    connection.send(message);
                } catch (error) {
                    console.error(WARNING_PREFIX + `Failed to send broadcast message to peer ${connection.peer}:`, error);
                    this.#triggerEvent("error", `Failed to send broadcast message to peer ${connection.peer}: ${error}`);
                }
            }
        });
    }

    /**
     * Handle host migration when current host disconnects
     * @private
     */
    #migrateHost() {
        const connectedPeerIds = this.#hostConnectionsIdArray; // Get list of all known peers from host's connection list
        connectedPeerIds.sort(); // Sort ids to ensure selection is streamlined

        if (connectedPeerIds[0] === this.id) {
            // Become new host
            this.#isHost = true;
            this.#triggerEvent("status", "Becoming new host...");
            this.#outgoingConnection = null;
        } else {
            // Connect to new host
            this.#triggerEvent("status", "Attempting to connect to new host in 1s...");
            setTimeout(() => {
                this.joinRoom(connectedPeerIds[0]); // Wait for new host to become the host first
            }, 1000);
        }
    }

    /**
     * Clean up and destroy peer
     */
    destroy() {
        try {
            if (this.#peer && !this.#peer.destroyed) this.#peer.destroy();

            // Resets
            this.#peer = undefined;
            this.#storage = {};
            this.#isHost = false;
            this.#hostConnections.clear();
            this.#hostConnectionsIdArray = [];

            // Clear intervals
            clearInterval(this.#heartbeatSendInterval);
            clearInterval(this.#heartbeatReceiveInterval);

            // Trigger events
            this.#triggerEvent("status", "Instance destroyed.");
            this.#triggerEvent("destroy");
        } catch (error) {
            console.error(ERROR_PREFIX + "Error during cleanup:", error);
            this.#triggerEvent("error", "Error during cleanup: " + error);
        }
    }

    /**
     *  @returns {number} - Number of active connections to the host
     */
    get connectionCount() {
        if (this.#isHost) return this.#hostConnections?.size || 0;
        return this.#hostConnectionsIdArray?.length || 0;
    }

    /**
     *  @returns {object} - Get storage object
     */
    get getStorage() {
        return this.#storage || {};
    }
}